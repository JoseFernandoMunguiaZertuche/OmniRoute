import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleNoCredentials } from "../chatHelpers.ts";

describe("handleNoCredentials — all-accounts-failed messaging", () => {
  it("allRateLimited with triedCount=13 returns 'All 13 ... failed or are cooling down'", async () => {
    const res = handleNoCredentials(
      { allRateLimited: true, lastError: "rate_limit", retryAfterHuman: "retry in 5m" },
      null,
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      "429 quota exceeded",
      429,
      13
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(res.status, 429);
    assert.match(
      body.error.message,
      /All 13 cloudflare-ai account\(s\) failed or are cooling down/
    );
    assert.match(body.error.message, /last: 429 quota exceeded/);
  });

  it("falls back to triedCount=1 when none provided", async () => {
    const res = handleNoCredentials(
      { allRateLimited: true, lastError: "rate_limit" },
      null,
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      "429 quota exceeded",
      429
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /All 1 cloudflare-ai account\(s\) failed or are cooling down/);
  });

  it("preserves the 'last upstream error' branch and includes the count", async () => {
    const res = handleNoCredentials(
      null,
      "conn-abc",
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      "502 Bad Gateway from upstream",
      502,
      13
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(res.status, 502);
    assert.match(
      body.error.message,
      /All 13 cloudflare-ai account\(s\) failed — last: 502 Bad Gateway from upstream/
    );
  });

  it("last-fallback 503 includes the count when lastStatus is missing", async () => {
    const res = handleNoCredentials(
      null,
      "conn-abc",
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      null,
      null,
      13
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(res.status, 503);
    assert.match(
      body.error.message,
      /All 13 cloudflare-ai account\(s\) failed or are cooling down/
    );
  });

  it("allExpired path still works (existing behavior)", async () => {
    const res = handleNoCredentials(
      { allExpired: true, expiredStatus: "credits_exhausted", expiredCount: 7 },
      null,
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      null,
      null
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(res.status, 401);
    assert.match(body.error.message, /All 7 connection\(s\) credits exhausted/);
  });

  // Regression: when all 13 cloudflare-ai accounts hit daily quota, the
  // connection selector returns `unavailableCount: 13`. The chat handler
  // must surface that as "All 13" — not "All 2" (the count of accounts
  // tried in THIS single request before the selector said everyone is
  // rate-limited).
  it("selector-supplied unavailableCount is used when present", async () => {
    const res = handleNoCredentials(
      {
        allRateLimited: true,
        lastError: "daily free allocation exhausted",
        retryAfterHuman: "retry in 5h 28m",
        unavailableCount: 13,
        totalCount: 13,
      },
      null,
      "cloudflare-ai",
      "@cf/zai-org/glm-5.2",
      "[429]: daily free allocation exhausted",
      429,
      // triedCount=2 simulates the OLD misleading count (2 accounts tried
      // in this request before allRateLimited). The new code should
      // prefer the selector's 13.
      2
    );
    const body = (await res.json()) as { error: { message: string } };
    assert.equal(res.status, 429);
    assert.match(
      body.error.message,
      /All 13 cloudflare-ai account\(s\) failed or are cooling down/
    );
    assert.doesNotMatch(body.error.message, /All 2 cloudflare-ai/);
  });
});
