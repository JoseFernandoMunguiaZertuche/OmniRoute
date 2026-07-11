/**
 * dailyTokenTracker.ts — Track per-account cumulative daily token usage in
 * `providerSpecificData` so the selector can skip accounts near Cloudflare's
 * 10K-neuron free-tier daily cap BEFORE sending a request.
 *
 * Why this exists:
 *   Cloudflare Workers AI returns HTTP 200 with 0 output tokens when an
 *   account hits its daily quota mid-stream (the "soft quota" pattern).
 *   The agent's UI sees the empty SSE stream as "model stopped" and aborts
 *   the build. We can't undo an empty SSE stream once the client starts
 *   reading it — the only way to keep the agent running is to NEVER pick
 *   an account that's about to hit the cap.
 *
 *   CF doesn't expose a usage API we can poll proactively (no
 *   `getUsageForProvider` case in usage.ts for "cloudflare-ai"). So we
 *   estimate from the response: each successful request returns
 *   `usage.prompt_tokens` and `usage.completion_tokens`; we sum them
 *   into `providerSpecificData.dailyTokenUsage` with the UTC midnight
 *   reset window. The selector filter skips accounts whose running sum
 *   crosses THRESHOLD_TOKENS (= 8,000, leaving headroom below the
 *   10K free cap; CF doesn't reveal the exact neuron calculation but
 *   prompt+completion tokens are within ~2x of neuron cost for the
 *   models we use, so 80% threshold is conservative).
 *
 * Storage: `providerSpecificData.dailyTokenUsage = { total, resetAt }`.
 * Stored as JSON; reset lazily on the next read after `resetAt` passes.
 * DB write is fire-and-forget (don't block the stream-completion path).
 */

// Free tier: 10,000 neurons/day/account. Neuron cost ≈ token cost for
// the models in scope (GLM 5.2 ≈ 50-100 neurons per 1K tokens, but the
// daily quota is enforced on a different metric; we treat tokens as a
// conservative upper-bound proxy). Threshold = 60% of the cap — leaves
// 4K tokens of headroom for one more bursty request but skips accounts
// that are clearly approaching exhaustion. AI coding agents running long
// sessions burn ~500-2000 tokens per turn, so 6K is hit after ~3-12
// turns on a free CF account — enough warning to rotate without the
// agent seeing the 0-output "model stopped" symptom.
const THRESHOLD_TOKENS = 6_000;

type DailyTokenState = {
  total: number;
  resetAt: string; // ISO; UTC midnight of the day the counter applies to
};

function nextUtcMidnightIso(nowMs: number = Date.now()): string {
  const d = new Date(nowMs);
  const next = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate() + 1, // rolls over to next day at 00:00:00 UTC
      0,
      0,
      0,
      0
    )
  );
  return next.toISOString();
}

function readState(
  providerSpecificData: Record<string, unknown> | null | undefined
): DailyTokenState {
  const raw = providerSpecificData?.dailyTokenUsage;
  if (!raw || typeof raw !== "object") {
    return { total: 0, resetAt: nextUtcMidnightIso() };
  }
  const s = raw as Record<string, unknown>;
  const total = typeof s.total === "number" && Number.isFinite(s.total) ? s.total : 0;
  const resetAt = typeof s.resetAt === "string" ? s.resetAt : nextUtcMidnightIso();
  // If reset window has passed, start fresh
  if (Date.now() >= Date.parse(resetAt)) {
    return { total: 0, resetAt: nextUtcMidnightIso() };
  }
  return { total, resetAt };
}

/**
 * Read the current daily usage for a connection, applying the lazy
 * midnight reset. Returns the post-reset total — i.e. what the selector
 * should compare against the threshold.
 */
export function getDailyTokenUsage(
  providerSpecificData: Record<string, unknown> | null | undefined
): number {
  return readState(providerSpecificData).total;
}

/**
 * Has the account crossed the daily threshold? Used by the selector
 * filter to skip accounts near quota.
 */
export function isAccountNearDailyQuota(
  providerSpecificData: Record<string, unknown> | null | undefined
): boolean {
  return getDailyTokenUsage(providerSpecificData) >= THRESHOLD_TOKENS;
}

/**
 * Compute the next state given current state + this request's token usage.
 * Resets the counter if resetAt has passed. Adds prompt + completion +
 * reasoning tokens (rough neuron proxy — see header comment).
 */
export function accumulateDailyTokens(
  providerSpecificData: Record<string, unknown> | null | undefined,
  usage: unknown
): DailyTokenState {
  const prev = readState(providerSpecificData);

  if (!usage || typeof usage !== "object") return prev;
  const u = usage as Record<string, unknown>;
  const prompt = pickNum(u, "prompt_tokens", "input_tokens", "promptTokens");
  const completion = pickNum(u, "completion_tokens", "output_tokens", "completionTokens");
  const reasoning = pickNum(u, "reasoning_tokens", "reasoningTokens");
  if (prompt + completion + reasoning <= 0) return prev;

  return {
    total: prev.total + prompt + completion + reasoning,
    resetAt: prev.resetAt,
  };
}

function pickNum(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

export const DAILY_TOKEN_THRESHOLD = THRESHOLD_TOKENS;
