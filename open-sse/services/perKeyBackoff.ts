/**
 * Per-key backoff for combo routing.
 *
 * Tracks when each connection (API key) last returned 429 and a fixed
 * "backoff until" timestamp. Combo target selection filters out keys
 * whose backoff has not yet expired. This lets each NVIDIA key recover
 * independently across the 4 keys we run with separate WireGuard egress.
 *
 * Design (2026-07-14):
 *  - Fixed initial backoff window: BACKOFF_MS_DEFAULT (default 60s = 60000ms). Deliberately
 *    NOT exponential: the goal is to discover NVIDIA's actual reset window
 *    by trying the key exactly once per window, not to mask it.
 *  - Per-connection granularity. Keys are identified by their `connectionId`
 *    (a UUID, stable across requests).
 *  - Resets to 0 on a recorded 200 OK. The key is "healthy" again.
 *  - Self-pruning: expired entries are filtered out lazily on read.
 *  - No DB writes. Pure in-memory, like providerCooldownTracker.
 *
 * The combo calls:
 *   - recordKeyBackoff(connectionId, BACKOFF_MS) when a target returns 429
 *   - recordKeySuccess(connectionId) when a target returns 200
 *   - isKeyAvailable(connectionId) — true if no backoff or backoff expired
 *   - getBackoffState() — for status / monitoring
 */

const BACKOFF_MS_DEFAULT = 60 * 1000;

type BackoffEntry = {
  backoffUntilMs: number;
  setAtMs: number;
  consecutiveFailures: number;
};

const state: Map<string, BackoffEntry> = new Map();

function getNowMs(): number {
  return Date.now();
}

export function recordKeyBackoff(
  connectionId: string,
  backoffMs: number = BACKOFF_MS_DEFAULT
): void {
  if (!connectionId) return;
  const now = getNowMs();
  const existing = state.get(connectionId);
  const prevFailures = existing?.consecutiveFailures ?? 0;
  // Fixed window: do NOT extend on consecutive failures. We want to learn
  // the true reset window, not hide it.
  state.set(connectionId, {
    backoffUntilMs: now + backoffMs,
    setAtMs: now,
    consecutiveFailures: prevFailures + 1,
  });
}

export function recordKeySuccess(connectionId: string): void {
  if (!connectionId) return;
  state.delete(connectionId);
}

export function isKeyAvailable(connectionId: string): boolean {
  if (!connectionId) return true;
  const entry = state.get(connectionId);
  if (!entry) return true;
  if (getNowMs() >= entry.backoffUntilMs) {
    // Expired — lazily prune
    state.delete(connectionId);
    return true;
  }
  return false;
}

export function getBackoffState(): Array<{
  connectionId: string;
  remainingMs: number;
  consecutiveFailures: number;
}> {
  const now = getNowMs();
  const out: Array<{
    connectionId: string;
    remainingMs: number;
    consecutiveFailures: number;
  }> = [];
  for (const [connectionId, entry] of state.entries()) {
    const remaining = entry.backoffUntilMs - now;
    if (remaining > 0) {
      out.push({
        connectionId,
        remainingMs: remaining,
        consecutiveFailures: entry.consecutiveFailures,
      });
    } else {
      state.delete(connectionId);
    }
  }
  return out;
}

export function clearAllBackoffs(): void {
  state.clear();
}

export function getDefaultBackoffMs(): number {
  return BACKOFF_MS_DEFAULT;
}
