/**
 * zeroOutputQuotaGuard.ts — Detects Cloudflare Workers AI's "soft quota" pattern:
 * HTTP 200 OK + empty body + 0 generated tokens + near-100% cache hit ratio.
 *
 * When an account hits its 10K-neuron daily cap mid-stream, Cloudflare stops
 * generating new tokens but still returns 200 OK with the cached portion. The
 * proxy can't tell from the HTTP status alone, but the token-count signature
 * is unmistakable: in>0, out=0, cache_read ≈ in.
 *
 * On detection we:
 *   1. Mark the connection in the DB via recordModelLockoutFailure() so it
 *      stays unavailable until the next UTC midnight (16h cap).
 *   2. Shadow-lock it in the in-memory map so concurrent sibling requests
 *      in the same process skip it on their NEXT selector pass — no DB
 *      roundtrip race.
 *   3. Log at warn level so operators see the cascade start.
 *
 * Caveats:
 *   - This fires AFTER the stream has been returned to the client. The current
 *     request's response body is whatever empty/short content Cloudflare sent;
 *     we can't "undo" that for an SSE stream. The fix prevents the SAME
 *     exhausted account from being re-picked on subsequent requests in the
 *     same session — agents that retry automatically (most do) get a
 *     non-empty response from a healthy account next time.
 *   - We also accept the response body so we can distinguish a real quota hit
 *     (no content, no tool_calls, no reasoning) from a legitimate tool-only
 *     finish (model emitted tool_calls, no text content). Tool-only responses
 *     also have completion_tokens=0 with meaningful prompt_tokens, so without
 *     this check we'd false-positive on every tool-use turn.
 *   - MIN_PROMPT_TOKENS guards against tiny legit no-op replies (e.g. a 12-token
 *     "ok" prompt that legitimately produced 0 output).
 */

import { createLogger } from "@/shared/utils/logger";

const log = createLogger("zero-output-quota");

// Don't fire on a tiny prompt — e.g. a 12-token "ok" prompt legitimately
// producing 0 output tokens is just a no-op reply, not a quota hit.
const MIN_PROMPT_TOKENS = 100;

type UsageLike = Record<string, unknown> | null | undefined;
type BodyLike = Record<string, unknown> | null | undefined;

function getNum(obj: UsageLike, ...keys: string[]): number {
  if (!obj) return 0;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * Inspect the parsed streaming response body to decide if the empty completion
 * was a *useful* one (tool_calls present, or content present) vs a true
 * zero-output empty body. Mirrors isEmptyContentResponse's logic but
 * inlined here to avoid a circular import.
 */
function hasUsableContentOrToolCalls(body: BodyLike): boolean {
  if (!body || typeof body !== "object") return false;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const c = choice as Record<string, unknown>;
    const message = c.message as Record<string, unknown> | undefined;
    const delta = c.delta as Record<string, unknown> | undefined;

    // content
    const content = message?.content ?? delta?.content;
    if (typeof content === "string" && content.trim() !== "") return true;

    // reasoning_content (some providers return this on a separate field)
    const reasoning = message?.reasoning_content ?? delta?.reasoning_content;
    if (typeof reasoning === "string" && reasoning.trim() !== "") return true;

    // tool_calls (OpenAI / OpenAI-compatible shape)
    const toolCalls = message?.tool_calls ?? delta?.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;

    // Anthropic content blocks: array of { type: "tool_use" | "text" | "thinking" }
    const blocks = message?.content;
    if (Array.isArray(blocks) && blocks.length > 0) {
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") return true;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim() !== "") return true;
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim() !== "")
          return true;
      }
    }
  }
  return false;
}

export interface ZeroOutputQuotaResult {
  detected: boolean;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  reason?: string;
}

/**
 * Detect the Cloudflare soft-quota signature:
 *   prompt ≥ MIN_PROMPT_TOKENS (real workload, not a no-op)
 *   completion_tokens === 0 (no new tokens generated)
 *   reasoning_tokens === 0 (model didn't even think)
 *   response body has NO usable content and NO tool_calls (rules out legit
 *     tool-only turns and length-truncated completions)
 */
export function detectZeroOutputQuotaExhaustion(
  usage: unknown,
  responseBody: unknown = null
): ZeroOutputQuotaResult {
  const empty: ZeroOutputQuotaResult = {
    detected: false,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
  };
  if (!usage || typeof usage !== "object") return empty;
  const u = usage as Record<string, unknown>;
  const promptTokens = getNum(u, "prompt_tokens", "input_tokens", "promptTokens");
  const completionTokens = getNum(u, "completion_tokens", "output_tokens", "completionTokens");
  const reasoningTokens = getNum(u, "reasoning_tokens", "reasoningTokens");
  const cacheReadTokens = getNum(u, "cache_read_input_tokens", "cached_tokens", "cacheReadTokens");

  if (promptTokens < MIN_PROMPT_TOKENS) {
    return { ...empty, promptTokens, completionTokens, reasoningTokens, cacheReadTokens };
  }
  if (completionTokens > 0) {
    return { ...empty, promptTokens, completionTokens, reasoningTokens, cacheReadTokens };
  }
  if (reasoningTokens > 0) {
    return { ...empty, promptTokens, completionTokens, reasoningTokens, cacheReadTokens };
  }
  if (hasUsableContentOrToolCalls(responseBody as BodyLike)) {
    return { ...empty, promptTokens, completionTokens, reasoningTokens, cacheReadTokens };
  }
  return {
    detected: true,
    promptTokens,
    completionTokens,
    reasoningTokens,
    cacheReadTokens,
    reason: `prompt=${promptTokens} completion=${completionTokens} reasoning=${reasoningTokens} cache_read=${cacheReadTokens}`,
  };
}

/**
 * Apply the quota-hit quarantine to a connection. Called from
 * `chatCore.ts` after `recordStreamingUsageStats` runs on a stream that
 * completed with status=200 and the 0-output signature.
 *
 * Side effects (fire-and-forget):
 *   - DB write via recordModelLockoutFailure (durable, persists across restart)
 *   - In-memory shadow lock so concurrent siblings skip this connection
 *     instantly
 */
export async function quarantineConnectionForZeroOutput(params: {
  provider: string;
  model: string;
  connectionId: string;
  usage: ZeroOutputQuotaResult;
  log?: (level: "warn" | "info", tag: string, msg: string) => void;
}): Promise<void> {
  const { provider, model, connectionId, usage, log: logFn } = params;

  if (!connectionId) return;

  // Dynamic imports keep chatCore's module-load graph minimal
  try {
    const [
      { recordModelLockoutFailure },
      { markFromDailyQuota },
      { getMsUntilTomorrow, DAILY_QUOTA_COOLDOWN_CAP_MS },
    ] = await Promise.all([
      import("@omniroute/open-sse/services/accountFallback.ts"),
      import("@/sse/services/inMemoryAccountLock"),
      import("@omniroute/open-sse/services/accountFallback.ts"),
    ]);

    const msUntilTomorrow = getMsUntilTomorrow();
    const tomorrowMidnight = Date.now() + Math.min(msUntilTomorrow, DAILY_QUOTA_COOLDOWN_CAP_MS);

    // DB lock — durable
    try {
      recordModelLockoutFailure(
        provider,
        connectionId,
        model,
        "zero_output_quota_exhausted",
        200,
        0,
        null,
        { exactCooldownMs: tomorrowMidnight }
      );
    } catch {
      // best-effort: DB write failing shouldn't crash the stream-completion path
    }

    // In-memory shadow — propagates to concurrent sibling requests instantly
    try {
      markFromDailyQuota(connectionId, tomorrowMidnight);
    } catch {
      // best-effort
    }

    const account8 = connectionId.slice(0, 8);
    const msg = `[ZERO_OUTPUT_QUOTA] ${provider}/${model} on ${account8} returned ${usage.reason}; quarantining until UTC midnight (cap 16h).`;
    if (logFn) logFn("warn", "ZERO_OUTPUT_QUOTA", msg);
    else log.warn("ZERO_OUTPUT_QUOTA", msg);
  } catch {
    // If any import fails, give up silently — the next request will hit the
    // same 0-output pattern, eventually the DB-side rateLimitedUntil will
    // catch up via the existing daily-quota body-text path.
  }
}
