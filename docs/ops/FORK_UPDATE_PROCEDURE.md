# Fork Update Procedure — keeping GLM 5.2 / DeepSeek-V4 fixes alive across upstream releases

> Scope: this doc covers how to integrate upstream OmniRoute releases
> (`origin/main` aka `diegosouzapw/OmniRoute`) into this fork WITHOUT losing
> the fork-only fixes that keep the `combo/glm-5.2-nvidia-only` combo stable.
> The normal `git pull origin main` / `git merge` will conflict or silently
> clobber them; use the rebase-lift procedure in this file instead.
>
> Maintainer: JoseFernandoMunguiaZertuche. Current fork push remote is `fork`
> (`JoseFernandoMunguiaZertuche/OmniRoute`); `origin` is upstream.

## Why a vanilla `git pull` / `git merge` is unsafe

The fork is currently **285 commits ahead of `origin/main`** — most are upstream PRs
cherry-picked early in a release cycle, plus a small set of genuine fork-only fixes.
Upstream does NOT track this fork's customizations. A `git merge origin/main`
treats the fork commits and the upstream commits as equal-ranking history and
auto-resolves overlapping hunks nondeterministically; the GLM/DeepSeek fixes can
vanish silently because:

1. They live in files the upstream release actively rewrites (`combo.ts`,
   `validateQuality.ts`, `stream.ts`, `streamHelpers.ts`).
2. Upstream's release commits are LARGE — e.g. `c9d4a45f1 Release v3.8.49`
   touches `combo.ts` for **+1422 lines**, `validateQuality.ts` for +273 lines,
   `stream.ts` for +283. A merge takes whichever side touched more lines (i.e.
   upstream wins) on a conflict.
3. The fork's rebasing convention (`4a3d966f5 rebase: rebase fork custom patches
onto release/v3.8.47, …`) demonstrates that the durable approach is
   **explicit rebase of the _fork-only_ subset onto a fresh upstream tag**, NOT
   forward-merging upstream onto a fork tree.

## The "must survive" fix commits (the canon)

These commits are the fork-only patches this file exists to protect. When a
rebase is performed, the operator's job is to land these (or their reworked
equivalent) on top of the new upstream release.

| SHA         | File(s)                                                                                               | Purpose                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `94cb986d4` | `open-sse/services/combo.ts` + `validateQuality.ts` + `stream.ts`                                     | `detect empty streaming responses from GLM 5.2 + auto-retry` — the original empty-response failover.                                                                                                                          |
| `244f6c5f0` | `open-sse/services/combo.ts`                                                                          | Reduce per-key fixed backoff from 20min → 60s so all-keys-exhausted recovery is bounded.                                                                                                                                      |
| `c2db1737b` | `open-sse/services/combo.ts`                                                                          | Target exhaustion cooldown + model strip directive + per-connection proxy support.                                                                                                                                            |
| `7978cd1e4` | provider/effort config                                                                                | Allow literal `max` reasoning_effort for NVIDIA z-ai/glm-5.2 + opencode-zen DeepSeek (the combo's source models).                                                                                                             |
| `7b4949b90` | `open-sse/services/combo.ts` + `validateQuality.ts` + `stream.ts`                                     | Eliminate `{"command":"true"}` synth pollution on GLM empty/mid-thought stops (disables the EMPTY and MIDTHOUGHT synth branches with `false &&` guards).                                                                      |
| `1bc3517bd` | `open-sse/services/combo/validateQuality.ts`                                                          | Extend mid-thought/empty-stop detection to Anthropic-shape streams (content_block_start/stop `break`, accumulate `delta.text`, combined `terminated` flag).                                                                   |
| `0dc66f130` | `open-sse/services/combo.ts` + `open-sse/utils/streamHelpers.ts` + `tests/unit/streamHelpers.test.ts` | Recognize empty-delta OpenAI terminal chunks via `finish_reason` (the root cause of intermittent `ob=false`); add `lastQualityResponse` forward gate so all-keys-quality-exhaustion forwards instead of recursing infinitely. |

### Quick recall

```bash
git tag fork-fixes-glm-deepseek 0dc66f130   # stable pointer for `git rebase --onto`
```

`0dc66f130` is the tip of the fix set as of this writing. (Tag lives in the
fork's local clone only; if you rebuild the clone on a new workstation, you can
re-create it from the SHA above — the SHAs in this table are immutable.)

## How to refresh from upstream (the recommended path)

This mirrors the procedure used for the `Release v3.8.47` rebase
(commit `4a3d966f5`).

### Step 0 — verify there IS a new upstream release worth picking up

```bash
git fetch origin --no-tags
git log --oneline main..origin/main | head -40
```

If that output is empty or only shows CI/docs churn (`.mergify.yml`, README
edits, Dependabot bumps), the fork is already current-enough; **stop** and let
the running box keep serving. The fixes documented here only need re-applying
when one of the fix files (`combo.ts`, `validateQuality.ts`, `stream.ts`,
`streamHelpers.ts`) appears in `main..origin/main`.

### Step 1 — flag any UPSTREAM commits that ALREADY overlap your fix set

Before you re-apply a fork commit, check whether the new upstream release
solves the same problem a different way. This happens — e.g.:

- Upstream `c9d4a45f1` (Release v3.8.49) introduced `hasOpenAIFinishReason()` in
  `streamHelpers.ts` — that's the SAME root cause my `0dc66f130` patch solved
  (intermittent `ob=false` for GLM/DeepSeek empty-delta terminal chunks), just
  with a different API. On a v3.8.49 or later rebase:
  - **DROP the `streamHelpers.ts` part of `0dc66f130`** — upstream's
    `hasOpenAIFinishReason` is wired into `flags.hasTerminalMarker` in
    `validateQuality.ts` and does the same job.
  - **KEEP the `combo.ts` part of `0dc66f130`** — i.e. `lastQualityResponse` /
    `lastQualityReason` + the "All N attempt(s) failed quality check (…)
    — forwarding last response as-is" gate. Upstream did not add a forward
    gate; without it the RR loop recurses forever on all-keys-quality-fail.
  - **KEEP the `tests/unit/streamHelpers.test.ts` additions** — they pin the
    behaviour in either formulation.

To find overlaps:

```bash
for sha in $(git log --format=%h main..origin/main); do
  files=$(git show --stat --format="" $sha | grep -E " combo\.ts$| validateQuality\.ts$| stream\.ts$| streamHelpers\.ts$" )
  [ -n "$files" ] && echo "$sha: $files"
done
```

### Step 2 — do the rebase-lift

```bash
# 1. Fetch upstream + fork
git fetch origin --no-tags
git fetch fork  --no-tags   # your fork (push target); only needed if you push first

# 2. Make a throwaway branch from the new upstream tip
git switch -c upstream-bump origin/main

# 3. Cherry-pick the fix set ONTO that branch, resolving as you go
#    Each cherry-pick is an opportunity to drop hunks that upstream now covers
git cherry-pick 94cb986d4        # detect empty GLM streaming + auto-retry
git cherry-pick 244f6c5f0        # 20min -> 60s per-key backoff
git cherry-pick c2db1737b       # target exhaustion cooldown + per-conn proxy
git cherry-pick 7978cd1e4       # allow literal max for glm-5.2 / DeepSeek
git cherry-pick 7b4949b90       # disable the {"command":"true"} synth branches
git cherry-pick 1bc3517bd        # Anthropic-shape mid-thought detection
git cherry-pick 0dc66f130       # finish_reason terminal chunk + forward gate
                                # on v3.8.49+: DROP the streamHelpers.ts hunks here

# 4. Sort any conflicts by reading this doc — do NOT blindly `--ours/--theirs`.
#    Conflict resolution guidance:
#      combo.ts (handleRoundRobinCombo):
#        KEEP lastQualityResponse / lastQualityReason declarations
#        KEEP the forward-gate block ("All N attempt(s) failed quality check (…)
#             — forwarding last response as-is (no transient error to wait out)")
#        KEEP the empty/mid-thought quality reject that records qR/qN WITHOUT
#             setting lastStatus=502 (otherwise the recursion gate reappears)
#      validateQuality.ts:
#        On v3.8.49+: USE upstream's hasOpenAIFinishReason / flags.hasTerminalMarker
#             architecture; ADAPT the Anthropic mid-thought block to upstream's
#             new switch layout (upstream splits parseAnthropicEvent out).
#        KEEP the trailing-colon / `[:;,]$|\.\.\.$` mid-thought regex.
#      stream.ts:
#        KEEP the `false &&` disable guards on both the EMPTY and MIDTHOUGHT
#             synthesizer branches (the combo validator catches these upstream
#             of the synth layer, so synthing now only re-pollutes context).
#      streamHelpers.ts:
#        On v3.8.49+: DROP my hasOpenAICompatibleStreamValue extension in favour
#             of upstream's hasOpenAIFinishReason — the test file's assertions
#             cover both formulations; the helper semantics are equivalent.

# 5. Run the test suite that pins the behaviour
node --import tsx/esm --test tests/unit/streamHelpers.test.ts
node --import tsx/esm --test tests/unit/combo-quality-validator-reasoning.test.ts
node --import tsx/esm --test tests/unit/quality-ratchet.test.ts
node --import tsx/esm --test tests/unit/validate-response-quality.test.ts

# 6. Build dist. THIS STEP WILL FAIL ON THE CURRENT VPS IF RAM STAYS OOM-CONTESTED
#    (see "Build environment" below); if so, hot-patch the live dist chunks the
#    same way the existing fixed commit set was applied. The source commits are
#    still the source of truth; the build is only the runtime face.
npm run build   # preferably with as few opencode sessions running as possible

# 7. Move main to the rebased branch + push to fork
git switch main
git reset --hard upstream-bump
git branch -D upstream-bump
git push fork main --force-with-lease   # `--force-with-lease` not bare `-f`
```

The `--force-with-lease` is appropriate because the rebase legitimately rewrites
the fork's recent commits; it's safer than bare `-f` since it refuses to clobber
a `fork/main` that has moved since your last fetch.

### Step 3 — live re-verification (server must reproduce all 5 wins)

The current fix set has been live-verified on `omniroute-server.service`
(PORT 20128). After any rebase, re-run this verification within the first hour
of the new server instance being up:

```bash
# server is up?
systemctl is-active omniroute-server.service
PID=$(systemctl show -p MainPID --value omniroute-server.service)

# 1) happy path — GLM asks through with NO failover
curl -sS -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo/glm-5.2-nvidia-only","stream":true,
       "messages":[{"role":"user","content":"What is 2+2? Reply with just the number."}]}' \
  | grep -E "x-omniroute-provider|^\[DONE\]"

# 2) mid-thought pressure — all keys failover, forward gate fires, client gets a FINITE response
time curl -sS -X POST http://127.0.0.1:20128/v1/chat/completions \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo/glm-5.2-nvidia-only","stream":true,
       "messages":[{"role":"user","content":"Reply with ONLY a short sentence ending with a colon and NOTHING else. Example: \"The answer is:\""}]}'

# 3) zero {"command":"true"} pollution in opencode DB after the post-fix window
#    (the boundary epoch = the server's start-of-fix time; recompute per rebuild)
FIX_LIVE_EPOCH_MS=$(date -d "$(systemctl show -p ActiveEnterTimestamp --value omniroute-server.service)" +%s%3N)
sqlite3 /home/jferm/.local/share/opencode/opencode.db \
  "SELECT COUNT(*) FROM part WHERE json_extract(data,'$.state.input.command')='true' AND time_created > $FIX_LIVE_EPOCH_MS;"
#   Expect 0. The opencode DB MUST be receiving other writes (sanity):
sqlite3 /home/jferm/.local/share/opencode/opencode.db \
  "SELECT COUNT(*) FROM part WHERE time_created > $FIX_LIVE_EPOCH_MS;"
#   Expect > 0 (DB is alive).

# 4) journald: NO new "Synthesized bash noop tool_call" fires
journalctl -u omniroute-server.service --since "$(systemctl show -p ActiveEnterTimestamp --value omniroute-server.service)" \
  --no-pager -o cat | grep -c "Synthesized bash noop tool_call"
#   Expect 0.

# 5) journald: forward gate fired at least once during step 2's pressure test
journalctl -u omniroute-server.service --since "5 minutes ago" --no-pager -o cat \
  | grep "forwarding last response as-is"
```

All 5 must pass before declaring the rebase done. If `3) (SYNC true pollution)`
returns a number greater than zero OTHER than just-after-server-startup (where
old in-flight parts from before the bounce may settle), you have re-introduced
the synth path — restart with `git show --stat upstream-bump` and confirm
`stream.ts` still has both `false &&` synth disable guards.

## Build environment constraint (why the live server's dist is hot-patched)

The current box has **7.5 GB RAM** with **~200 MB free** while 3-4 `opencode`
sessions + the running `omniroute-server.service` + Brave are resident
(2026-08-02 observation; see `free -h`, `ps aux --sort=-%mem | head`). The Next.js
Turbopack production build (`scripts/build/build-next-isolated.mjs` → `next build`)
needs 3-4 GB of working RAM and cannot complete under those conditions — it's
swapped to death and either SIGKILLed by the OOM killer or hit by the build
script's own per-step timeout. **This is environmental, not a code defect.**

Workarounds (in order of preference):

1. **Stop one or two `opencode` sessions before building** — frees the most
   RAM per session (each is 600 MB - 1.3 GB RSS). This is the lowest-risk fix.
2. **Build on a different machine** (more RAM, fresh checkout) and `rsync`
   `dist/` across — matches the VPS deploy flow already used for production.
3. **Hot-patch the live `dist/.build/next/server/chunks/*.js` chunks the way the
   current fix set was applied** — surgical regex edits to the minified
   chunk(s) containing `hasOpenAICompatibleStreamValue`, the combo RR validator,
   and the synth layer. Reference current set: `77772.js`, `9739.js`,
   `19057.js`, `97256.js`, `98216.js`, `87107.js`, `37544.js`. This is a
   runtime-only bridge; the committed SOURCE is the source of truth, and the
   next successful `next build` regenerates these chunks in lock-step with it.

A chunk-name-number is per-build-version. When a future `next build` on a sane
host regenerates the chunks, the new chunk file names WILL differ. The mapping
you care about is "the chunk containing `hasOpenAICompatibleStreamValue`" —
locate that with:

```bash
grep -rl "hasOpenAICompatibleStreamValue\|hasOpenAIFinishReason" dist/.build/next/server/chunks/ 2>/dev/null
```

…or for the RR validator/synth combo fix:

```bash
grep -rl "forwarding last response\|streaming mid-thought stop" dist/.build/next/server/chunks/ 2>/dev/null
grep -rl "call_omni_cont_\|Synthesized bash noop" dist/.build/next/server/chunks/ 2>/dev/null
```

## Dist hot-patch pattern (reference, for option 3 above)

When the build can't run, surgically edit the minified chunk to mirror the
committed source change. The patches use stable in-chunk markers (function
names, log strings) — NOT layout-based offsets — so they remain locatable
across chunk renames:

```text
Combo RR validator + forward gate (chunks 9739.js / 77772.js on current build):
  INSERT around the .choices.some(…) OpenAI peek:
    let fr=<arg>.finish_reason;
    if(typeof fr=="string"&&fr.length>0)return!0;
  INSERT before the recursion gate:
    if(!lastStatus&&lastQualityResponse&&lastQualityResponse.ok&&lastQualityReason){
      console.warn("COMBO-RR","All "+recordedAttempts+" attempt(s) failed quality check ("+lastQualityReason+") — forwarding last response as-is (no transient error to wait out)");
      if(B._es) B._es = 0;
      recordSuccess(...); return lastQualityResponse;
    }

Synth disable (chunks 87107.js / 37544.js on current build):
  Change:
    if(isFinishChunk&&!passthroughHasToolCalls&&!passthroughAccumulatedContent.trim()&&...) {
  to:
    if(false&&isFinishChunk&&...) {           // EMPTY synth — disabled

  Change:
    else if(isFinishChunk&&parsed.choices[0]?.finish_reason==="stop"&&!passthroughHasToolCalls&&...) {
  to:
    else if(false&&isFinishChunk&&...) {      // MIDTHOUGHT synth — disabled
```

Validate each chunk after patching:

```bash
for f in dist/.build/next/server/chunks/77772.js dist/.build/next/server/chunks/9739.js \
         dist/.build/next/server/chunks/19057.js dist/.build/next/server/chunks/97256.js \
         dist/.build/next/server/chunks/98216.js dist/.build/next/server/chunks/87107.js \
         dist/.build/next/server/chunks/37544.js; do node --check "$f" || echo "BAD: $f"; done
```

Then `systemctl restart omniroute-server.service` and re-run the verification
block (Step 3 above) before declaring it live.

## TL;DR for an AI agent asked to "update omniroute to the latest"

> Agent — when given that instruction, the correct first action is NOT `git pull`.
> Read this whole doc, then:
>
> 1. `git fetch origin --no-tags` and inspect `git log --oneline main..origin/main`
>    against the fix-file list.
> 2. Use the cherry-pick-the-fix-set-onto-`origin/main` procedure (Step 2) —
>    NOT `git merge`. Re-check Step 1 for any upstream commits that overlap your
>    fix set so you can DROP the redundant fork hunks instead of conflicting on
>    them.
> 3. Resolve conflicts by reading the conflict-resolution guidance above; the
>    forward-gate must always survive — without it the RR loop recurses forever.
> 4. Run the test suite (Step 2 end) + the live 5-point verification (Step 3).
> 5. The dist hot-patch is fallback path 3 — only if a true `next build` cannot
>    run. Prefer reducing concurrent opencode sessions or building on another
>    host.
