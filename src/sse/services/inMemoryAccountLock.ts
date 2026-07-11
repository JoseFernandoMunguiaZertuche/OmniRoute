/**
 * inMemoryAccountLock.ts — Per-process in-memory lock for accounts that
 * have just hit a daily-quota 429. Activates the moment a request detects
 * the body-text "you have used up your daily free allocation of N neurons"
 * (or equivalent on other providers), so concurrent sibling requests
 * picking the same account abort their retry attempt within the same
 * request's selector pass — no DB roundtrip race.
 *
 * Why an in-memory shadow of `rateLimitedUntil`:
 *   The DB write to `rateLimitedUntil` is async (`await markAccountUnavailable`).
 *   Two concurrent requests can both read "available" before either write lands,
 *   both pick the same exhausted account, both hit 429 daily quota, both
 *   fall back to the same healthy account — wasting two upstream slots.
 *   With this shadow, the FIRST request's hit propagates instantly to the
 *   SECOND request's selector pass (next millisecond).
 *
 * Lifetime: until `expiresAtMs` (typically UTC midnight, capped at 16h —
 * matches `recordModelLockoutFailure` + the `dailyQuotaExhausted` cooldown
 * used elsewhere in chat.ts). The DB write is still the source of truth
 * for cross-restart persistence; this is purely an in-process accelerator.
 *
 * Scope: ONLY triggered by `markFromDailyQuota()`. Other failures
 * (transient 5xx, network errors, per-minute 429) leave the shadow empty.
 */

type LockEntry = { expiresAtMs: number };

const _lock = new Map<string, LockEntry>();

export function markFromDailyQuota(connectionId: string, expiresAtMs: number): void {
  if (!connectionId || !Number.isFinite(expiresAtMs)) return;
  // Only extend the lock — never shorten an existing longer-running lock.
  const existing = _lock.get(connectionId);
  if (existing && existing.expiresAtMs >= expiresAtMs) return;
  _lock.set(connectionId, { expiresAtMs });
}

export function isLocked(connectionId: string, nowMs: number = Date.now()): boolean {
  const entry = _lock.get(connectionId);
  if (!entry) return false;
  if (nowMs >= entry.expiresAtMs) {
    _lock.delete(connectionId);
    return false;
  }
  return true;
}

/**
 * Diagnostic: how many connections are currently shadow-locked. Used by
 * the AUTH logger to surface "N shadow-locked (in-memory)" alongside the
 * DB-side unavailable count, so operators can see when the in-memory
 * shadow is masking a quota that hasn't yet been persisted to DB.
 */
export function snapshotShadowLockedCount(nowMs: number = Date.now()): number {
  let n = 0;
  for (const [, entry] of _lock) {
    if (nowMs < entry.expiresAtMs) n += 1;
  }
  return n;
}
