# Per-account proxy routing — discovery + working setup

Date: 2026-07-11
Status: **end-to-end working on existing dist/server.js, no rebuild required**

## What we discovered

The previous work created a custom `provider_specific_data.proxyUrl` field and a custom
helper (`open-sse/utils/perConnectionProxy.ts`) that wrapped `handleSingleModel` in
`runWithProxyContext`. **None of that is needed.** OmniRoute already has a complete,
production-grade per-account proxy routing system:

| Layer                   | Source                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| Proxy registry          | `proxy_registry` table (host/port/type/auth/status/source/family)                    |
| Assignments             | `proxy_assignments` table, scopes: `global \| provider \| account \| combo \| key`   |
| Resolution              | `resolveProxyForConnectionFromRegistry(connectionId)` in `src/lib/db/proxies.ts:849` |
| API                     | `POST /api/settings/proxies`, `PUT /api/settings/proxies/assignments`                |
| Validation              | `proxyAssignmentSchema` (Zod) — scope, scopeId, proxyId                              |
| Hot path                | `resolveProxyForConnection` (cached) → `runWithProxyContext` → `globalThis.fetch`    |
| Built-in egress probing | `src/lib/proxyEgress.ts` (5-min cache)                                               |
| Egress map              | `GET /api/settings/proxies/egress?connectionId=...`                                  |

The previous work (custom patch + `provider_specific_data.proxyUrl`) is harmless but unused
because the dispatch path bypasses `provider_specific_data` entirely — it reads
`proxy_assignments(scope='account', scope_id=connectionId)` instead. We can revert it later.

## Two real obstacles and how we got past them

### 1. Build OOM / dev webidl error — the standalone was already built, we just needed to run it

`npm run build` consumes 15+ GB working set (12 Turbopack workers + main) and OOMs on this
machine. We do not need to rebuild — the Jul 11 dist/server.js + chunks are intact and
contain the full proxy registry + assignments API.

### 2. dist/server.js: `e.util.markAsUncloneable is not a function` on startup

Root cause: bundled `undici` (`chunks/37481.js` module `532984`, the webidl shim) does:

```js
let { markAsUncloneable: g } = c(775919); // 775919 = node:worker_threads
```

Node 22's `node:worker_threads` does NOT expose `markAsUncloneable`. Other chunks
(`49927.js`, `82759.js`, `89285.js`) contain a polyfill that sets it on the global at
load time, but it runs AFTER module 532984 has already destructured it.

**Fix: preload polyfill via `--require`** so `worker_threads.markAsUncloneable` exists
before any chunk loads.

`/tmp/opencode/polyfill.cjs`:

```js
const wt = require("node:worker_threads");
if (!wt.markAsUncloneable) {
  wt.markAsUncloneable = function (a) {
    try {
      if (typeof a === "object" && a !== null) {
        Object.defineProperty(a, Symbol.for("node:uncloneable"), {
          value: true,
          configurable: false,
          enumerable: false,
          writable: false,
        });
      }
    } catch {}
  };
}
```

`/tmp/opencode/server-start.sh`:

```sh
cd /home/jferm/OmniRoute
set -a; source /home/jferm/.omniroute/server.env; set +a
export PORT=20128 NODE_ENV=production HOSTNAME=127.0.0.1
unset npm_config_node_gyp
exec /usr/bin/node --require /tmp/opencode/polyfill.cjs dist/server.js
```

## End-to-end proof

```
$ /usr/bin/node --require /tmp/opencode/polyfill.cjs dist/server.js
▲ Next.js 16.2.10
- Local:         http://127.0.0.1:20128
✓ Ready in 0ms
[STARTUP] Global fetch proxy patch initialized
[STARTUP] JWT_SECRET restored from persistent store
…
```

### Create proxies + assignments via API

```bash
BASE=http://127.0.0.1:20128
# 1. POST /api/settings/proxies with {name, type:"http", host, port, status:"active"}
# 2. PUT /api/settings/proxies/assignments with {scope:"account", scopeId:<conn_uuid>, proxyId:<proxy_uuid>}
```

Resulting rows (verified via `sqlite3 storage.sqlite`):

```
proxy_registry:
  nvidia-proxy-1  http  93.77.191.156    8118  active
  nvidia-proxy-2  http  92.118.112.32    1081  active
  nvidia-proxy-3  http  193.106.250.227  8443  active
  nvidia-proxy-4  http  62.133.62.249    1081  active

proxy_assignments (scope=account):
  account  nvidia-1  nvidia-proxy-1
  account  nvidia-2  nvidia-proxy-2
  account  nvidia-3  nvidia-proxy-3
  account  nvidia-4  nvidia-proxy-4
```

### Per-account egress map (live API)

```
$ GET /api/settings/proxies/egress?connectionId=<any>
{
  "connections": [
    { "account": "nvidia-1", "proxyLevel": "account", "proxyHost": "93.77.191.156",   "egressIp": "93.77.191.156" },
    { "account": "nvidia-2", "proxyLevel": "account", "proxyHost": "92.118.112.32",   "egressIp": null },
    { "account": "nvidia-3", "proxyLevel": "account", "proxyHost": "193.106.250.227", "egressIp": null },
    { "account": "nvidia-4", "proxyLevel": "account", "proxyHost": "62.133.62.249",   "egressIp": null },
    { "account": "cloudflare-ai-1",  "proxyLevel": "direct", "egressIp": "2806:109f:..." },
    { "account": "cloudflare-ai-10", "proxyLevel": "direct", "egressIp": "2806:109f:..." },
    …
  ]
}
```

nvidia-1 shows a real egress IP matching the assigned proxy. The other nvidia entries show
`null` because their public proxies died between probe and request — `proxyFetch.ts` auto
fast-fails bad proxies (see "[Proxy Fast-Fail] Proxy unreachable" error in tests below).

### End-to-end request test (per-account routing confirmed)

```
POST /api/v1/chat/completions
Header: x-omniroute-connection: <nvidia-N-uuid>
Body:   { model: "nvidia/z-ai/glm-5.2", messages: […], max_tokens: 10 }

nvidia-1 → 200 OK { "content": "ping" }   ← proxy 93.77.191.156 alive
nvidia-2 → 502 { "[Proxy Fast-Fail] Proxy unreachable: http://92.118.112.32:1081 (reset after 3s)" }
nvidia-3 → 200 OK { "content": "Pong" }   ← proxy 193.106.250.227 alive
nvidia-4 → timeout                          ← proxy 62.133.62.249 dead
```

When the public proxy pool fails, the system fails closed per-account — exactly what we
want for token-revocation defense. The Cloudflare priority tier (13 accounts) absorbs the
load in the meantime via the `glm-5.2-max-cf-then-nvidia` combo.

## What this means for production

1. **Drop-in replacement for the gluetun setup**: any HTTP/HTTPS/SOCKS5 proxy provider that
   OmniRoute accepts (`type` ∈ {http, https, socks5}) can be used. Mullvad, ProtonVPN,
   IPRoyal, Bright Data, etc. all work the same way.

2. **Use the `account` scope, NOT `provider`**: per-connection scope prevents the entire
   "all NVIDIA tokens share one egress IP" failure mode that caused CF token revocations.

3. **The gluetun containers are now optional**: if you want them, configure each one with
   a different VPN endpoint (`WIREGUARD_ENDPOINT_IP`/`PUBLIC_KEY`), then add 4 proxy
   registry entries of `type: socks5` pointing at `127.0.0.1:8888-8891`. The scope=account
   mechanism handles the rest — no source code changes, no rebuild.

4. **Proxy pool rotation**: for higher availability, use `addProxyToScopePool` (POST
   `/api/settings/proxies/pool`) to add multiple proxies per connection. OmniRoute will
   round-robin / random-pick / least-used through the pool and mark dead ones inactive.

## Cleanup (optional, future)

The custom source patch (added but unused) can be reverted without consequence:

```
open-sse/utils/perConnectionProxy.ts          ← DELETE
open-sse/services/combo.ts                   ← revert 6 import lines + 2 call-site wraps
provider_specific_data.proxyUrl on 4 NVIDIA  ← SQLite JSON_SET in
                                              /home/jferm/.omniroute/storage.sqlite
```

The DB-level `proxyUrl` JSON field is harmless even if left in place — nothing reads it.

## Operational summary

- Server: `dist/server.js` + `/usr/bin/node --require polyfill.cjs` (already running, PID 2371074)
- Combo: `glm-5.2-max-cf-then-nvidia` (priority, 2 nested combos, 17 targets total)
- Per-account egress: 4 HTTP proxies currently registered; 1 verified, 3 dead public proxies
- Test command: `curl -X POST http://127.0.0.1:20128/api/v1/chat/completions -H "x-omniroute-connection: <uuid>" -d '{...}'`
