#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * import-ai-accounts.mjs — one-shot importer for ai-proxy style account pools
 * into the OmniRoute `provider_connections` table.
 *
 * Supports:
 *   - Cloudflare Workers AI accounts (ACCOUNTS_JSON = [{id, token, label}, ...])
 *   - DigitalOcean GenAI accounts       (DO_KEY_1, DO_KEY_2, ... = doo_v1_...)
 *
 * ZenMux is intentionally NOT imported — per the user, they no longer offer
 * free tokens.
 *
 * Usage:
 *   # Bulk import from ai-proxy .dev.vars (Cloudflare + DigitalOcean pools)
 *   node --import tsx/esm scripts/import-ai-accounts.mjs --from /home/jferm/ai-proxy/.dev.vars
 *
 *   # Add a single connection — provider:key[:label] (key never echoed)
 *   node --import tsx/esm scripts/import-ai-accounts.mjs --add openai:sk-...[:work]
 *   node --import tsx/esm scripts/import-ai-accounts.mjs --add anthropic:sk-ant-...[:main]
 *
 *   # Same, but read the spec from a file (key never in argv/shell history)
 *   echo "openai:sk-abc" > /tmp/key && \
 *     node --import tsx/esm scripts/import-ai-accounts.mjs --add-from-file /tmp/key && \
 *     rm /tmp/key
 *
 *   # List current connections (keys masked)
 *   node --import tsx/esm scripts/import-ai-accounts.mjs --list
 *
 *   # Dry-run (no DB writes)
 *   node --import tsx/esm scripts/import-ai-accounts.mjs --from ... --dry-run
 *
 * Uses createProviderConnection() from src/lib/db/providers.ts — encryption,
 * dedup, and provider-specific data normalization go through the proper
 * domain module (no raw SQL per src/lib/db/AGENTS.md). Idempotent: re-running
 * with the same data updates existing rows rather than duplicating.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const fromPath = (() => {
  const i = args.indexOf("--from");
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : null;
})();
const wantList = args.includes("--list");
const dryRun = args.includes("--dry-run");

const addSpec = (() => {
  const i = args.indexOf("--add");
  if (i < 0) return null;
  const raw = args[i + 1];
  if (!raw) throw new Error("--add expects provider:key[:label]");
  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("--add spec must be provider:key[:label]");
  const provider = parts[0].trim();
  const key = parts.slice(1, -1).join(":").trim();
  const label =
    (parts[parts.length - 1] === key ? "" : parts[parts.length - 1].trim()) || undefined;
  if (key === parts[parts.length - 1]) {
    return { provider, key: parts.slice(1).join(":").trim(), label: undefined };
  }
  if (parts.length === 2) {
    return { provider, key: parts[1], label: undefined };
  }
  return {
    provider,
    key: parts.slice(1, -1).join(":").trim(),
    label: parts[parts.length - 1].trim(),
  };
})();

const addFromFile = (() => {
  const i = args.indexOf("--add-from-file");
  if (i < 0) return null;
  const p = args[i + 1];
  if (!p) throw new Error("--add-from-file expects a path");
  const raw = readFileSync(resolve(p), "utf8").trim();
  const parts = raw.split(":");
  if (parts.length < 2) throw new Error("--add-from-file content must be provider:key[:label]");
  if (parts.length === 2) {
    return { provider: parts[0].trim(), key: parts[1], label: undefined };
  }
  return {
    provider: parts[0].trim(),
    key: parts.slice(1, -1).join(":").trim(),
    label: parts[parts.length - 1].trim(),
  };
})();

const isHelp = args.includes("--help") || args.includes("-h");

function loadEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    // If value starts with a single or double quote, accumulate lines until the
    // matching closing quote (handles multi-line JSON arrays, heredocs, etc.).
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0];
      if (v.length > 1 && v.endsWith(quote) && v[1] !== quote) {
        v = v.slice(1, -1);
      } else {
        v = v.slice(1);
        i++;
        while (i < lines.length) {
          const next = lines[i];
          if (next.endsWith(quote)) {
            v += "\n" + next.slice(0, -1);
            break;
          }
          v += "\n" + next;
          i++;
        }
      }
    }
    out[m[1]] = v;
  }
  return out;
}

function mask(value, keep = 6) {
  if (!value || value.length < keep + 4) return "(redacted)";
  return `${value.slice(0, keep)}...${value.slice(-4)}`;
}

function readCloudflareAccounts(env) {
  const raw = env.ACCOUNTS_JSON;
  if (!raw) return { accounts: [], placeholderCount: 0 };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ACCOUNTS_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ACCOUNTS_JSON must be a JSON array");
  }
  let placeholderCount = 0;
  const accounts = parsed
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const id = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
      const token = typeof entry.token === "string" && entry.token.length > 0 ? entry.token : null;
      const label = typeof entry.label === "string" && entry.label.length > 0 ? entry.label : id;
      if (!id || !token) {
        placeholderCount += 1;
        return null;
      }
      return { id, token, label };
    })
    .filter(Boolean);
  return { accounts, placeholderCount };
}

function readDigitalOceanAccounts(env) {
  const out = [];
  let placeholderCount = 0;
  for (let i = 1; i <= 13; i++) {
    const key = env[`DO_KEY_${i}`];
    if (key && key.trim()) {
      out.push({ index: i, token: key.trim(), label: `do-${i}` });
    } else {
      placeholderCount += 1;
    }
  }
  return { accounts: out, placeholderCount };
}

async function listMode() {
  const { getDbInstance } = await import("../src/lib/db/core.ts");
  const { getProviderConnections } = await import("../src/lib/db/providers.ts");
  getDbInstance();
  const rows = await getProviderConnections({});
  const groups = new Map();
  for (const r of rows) {
    const list = groups.get(r.provider) ?? [];
    list.push(r);
    groups.set(r.provider, list);
  }
  if (groups.size === 0) {
    console.log("(no provider connections in DB)");
    return;
  }
  console.log(`Found ${rows.length} connection(s) across ${groups.size} provider(s):`);
  for (const [provider, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`\n  ${provider}  (${list.length})`);
    for (const c of list) {
      const flag = c.isActive ? "active  " : "INACTIVE";
      const status = c.testStatus ? `[${c.testStatus}]` : "";
      const name = c.name || c.displayName || c.email || c.id.slice(0, 8);
      const key = c.apiKey ? `  key=${mask(c.apiKey)}` : "";
      console.log(`    - ${name}  ${flag}  ${status}${key}`);
    }
  }
}

async function importMode() {
  const envFile = fromPath ?? resolve(process.cwd(), ".env");
  console.log(`[import] reading accounts from ${envFile}`);
  const env = loadEnvFile(envFile);

  const { accounts: cfAccounts, placeholderCount: cfPlaceholders } = readCloudflareAccounts(env);
  const { accounts: doAccounts, placeholderCount: doPlaceholders } = readDigitalOceanAccounts(env);

  const totalPlaceholders = cfPlaceholders + doPlaceholders;
  console.log(
    `[import] parsed ${cfAccounts.length} Cloudflare account(s), ${doAccounts.length} DigitalOcean account(s)` +
      (totalPlaceholders > 0 ? `, ${totalPlaceholders} empty placeholder slot(s)` : "")
  );

  if (cfAccounts.length === 0 && doAccounts.length === 0) {
    console.log("[import] nothing to import");
    if (totalPlaceholders > 0) {
      console.log(
        `[import] tip: ${totalPlaceholders} placeholder slot(s) are waiting in ${envFile}. Fill them in and re-run.`
      );
    }
    return;
  }

  if (dryRun) {
    for (const a of cfAccounts) {
      console.log(`  - cloudflare-ai  id=${a.id}  label=${a.label}  token=${mask(a.token)}`);
    }
    for (const a of doAccounts) {
      console.log(`  - digitalocean   label=${a.label}  token=${mask(a.token)}`);
    }
    if (totalPlaceholders > 0) {
      console.log(
        `  (${totalPlaceholders} empty placeholder slot(s) skipped — fill them in to add more accounts)`
      );
    }
    console.log("[import] dry-run: no DB writes performed");
    return;
  }

  const { getDbInstance } = await import("../src/lib/db/core.ts");
  const { createProviderConnection } = await import("../src/lib/db/providers.ts");
  getDbInstance();

  let ok = 0;
  let fail = 0;

  for (const a of cfAccounts) {
    try {
      await createProviderConnection({
        provider: "cloudflare-ai",
        authType: "apikey",
        name: a.label,
        apiKey: a.token,
        isActive: true,
        priority: 0,
        providerSpecificData: { accountId: a.id },
      });
      console.log(`  + cloudflare-ai  ${a.label}  id=${a.id}  token=${mask(a.token)}`);
      ok++;
    } catch (err) {
      console.error(
        `  ! cloudflare-ai  ${a.label} (${a.id}): ${err instanceof Error ? err.message : String(err)}`
      );
      fail++;
    }
  }

  for (const a of doAccounts) {
    try {
      await createProviderConnection({
        provider: "digitalocean",
        authType: "apikey",
        name: a.label,
        apiKey: a.token,
        isActive: true,
        priority: 0,
      });
      console.log(`  + digitalocean   ${a.label}  token=${mask(a.token)}`);
      ok++;
    } catch (err) {
      console.error(
        `  ! digitalocean   ${a.label}: ${err instanceof Error ? err.message : String(err)}`
      );
      fail++;
    }
  }

  console.log(`\n[import] done: ${ok} ok, ${fail} failed. Run --list to confirm.`);
  if (fail > 0) process.exit(1);
}

async function addOne(spec) {
  const { getDbInstance } = await import("../src/lib/db/core.ts");
  const { createProviderConnection } = await import("../src/lib/db/providers.ts");
  getDbInstance();
  const label = spec.label || `${spec.provider}-${Date.now()}`;
  try {
    await createProviderConnection({
      provider: spec.provider,
      authType: "apikey",
      name: label,
      apiKey: spec.key,
      isActive: true,
      priority: 0,
    });
    console.log(`  + ${spec.provider}  ${label}  key=${mask(spec.key)}`);
  } catch (err) {
    console.error(
      `  ! ${spec.provider}  ${label}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

async function main() {
  if (isHelp) {
    console.log(`import-ai-accounts.mjs — manage OmniRoute provider connections

Usage:
  --list                              List all current connections (keys masked)
  --from <path>                       Bulk-import CF + DO pools from a .dev.vars / .env file
  --add provider:key[:label]          Add a single connection (key never in shell history)
  --add-from-file <path>              Same, but read the spec from a file
  --dry-run                           Show what would be imported; no DB writes
  -h, --help                          This help

The --add and --add-from-file modes write the key straight to the encrypted
provider_connections table; it is never echoed in the output.

Examples:
  # Add an OpenAI key
  node --import tsx/esm scripts/import-ai-accounts.mjs --add openai:sk-proj-...[:work]

  # Add a Groq key with a label
  node --import tsx/esm scripts/import-ai-accounts.mjs --add groq:gsk_...:home

  # Keep the key out of argv and out of ~/.bash_history
  printf 'openai:sk-proj-abc' > /tmp/k
  node --import tsx/esm scripts/import-ai-accounts.mjs --add-from-file /tmp/k
  rm /tmp/k

  # Bulk import ai-proxy pools
  node --import tsx/esm scripts/import-ai-accounts.mjs \\
    --from /home/jferm/ai-proxy/.dev.vars
`);
    return;
  }
  if (addSpec) return addOne(addSpec);
  if (addFromFile) return addOne(addFromFile);
  if (wantList) return listMode();
  return importMode();
}

main().catch((err) => {
  console.error("[import] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
