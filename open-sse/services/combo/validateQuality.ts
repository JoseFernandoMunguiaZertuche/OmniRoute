/**
 * Combo response-quality validation extracted from combo.ts.
 *
 * `validateResponseQuality` (bounded SSE peek + non-streaming content check) and
 * `toRetryAfterDisplayValue` moved out of the combo.ts god-file (Quality Gate v2
 * / Fase 9). Logic unchanged; re-exported from combo.ts for compatibility.
 */

import {
  createSSEDataLineNormalizer,
  isKnownNonClaudeStreamPayload,
} from "../../utils/streamHelpers.ts";
import { evaluateResponseValidation, type ResponseValidationConfig } from "./responseValidation.ts";
import { getReasoningTokens } from "../../../src/lib/usage/tokenAccounting.ts";
import type { ComboRetryAfter } from "./types.ts";

export function toRetryAfterDisplayValue(value: ComboRetryAfter): string | Date {
  if (typeof value !== "number") return value;
  if (value > 0 && value < 1_000_000_000) {
    return new Date(Date.now() + value * 1000);
  }
  return new Date(value);
}

// Issue #6427: some providers mask credit/quota exhaustion behind an HTTP 200 —
// either an OpenAI-shape top-level `error` object, or a known exhaustion phrase
// living in the error envelope itself (never in assistant prose — see
// `extractEnvelopeErrorText`). Single-quantifier-per-token-class alternation,
// no nested/overlapping quantifiers — cannot backtrack catastrophically.
const EXHAUSTION_MARKER_PATTERN =
  /\b(insufficient\s+credit|insufficient\s+balance|quota\s+exceeded|out\s+of\s+credits?|credit\s+exhausted)\b/i;

/**
 * Collect the small set of top-level "error envelope" strings a 200 response may
 * carry alongside (or instead of) a normal completion: the OpenAI-shape `error`
 * object's `message`/`code`/`type`, a bare string `error`, or sibling top-level
 * `message`/`detail` fields some providers use for the same purpose. Deliberately
 * does NOT look inside `choices[].message.content` — assistant prose that merely
 * mentions "quota" or "credits" must never be misclassified as an upstream failure.
 */
function extractEnvelopeErrorText(json: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const err = json.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.code === "string") parts.push(e.code);
    if (typeof e.type === "string") parts.push(e.type);
  } else if (typeof err === "string" && err.length > 0) {
    parts.push(err);
  }
  if (typeof json.message === "string") parts.push(json.message);
  if (typeof json.detail === "string") parts.push(json.detail);
  return parts.length > 0 ? parts.join(" ") : null;
}

function responsesApiOutputHasContent(output: unknown): boolean {
  return (
    Array.isArray(output) &&
    output.some((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      if (record.type !== "message") return Boolean(record.type);
      const content = record.content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) =>
            !!part &&
            typeof part === "object" &&
            typeof (part as Record<string, unknown>).text === "string" &&
            ((part as Record<string, string>).text as string).length > 0
        )
      );
    })
  );
}

/**
 * Validate that a successful (HTTP 200) non-streaming response actually contains
 * meaningful content. Returns { valid: true } or { valid: false, reason }.
 *
 * Only inspects non-streaming JSON responses — streaming responses are passed through
 * because buffering the full stream would defeat the purpose of streaming.
 *
 * Checks:
 * 1. Body is valid JSON
 * 2. Has at least one choice with non-empty content or tool_calls
 */
export async function validateResponseQuality(
  response: Response,
  isStreaming: boolean,
  log: { warn?: (...args: unknown[]) => void },
  responseValidation?: ResponseValidationConfig | null
): Promise<{ valid: boolean; reason?: string; clonedResponse?: Response }> {
  // Issue #3685: For Claude SSE streaming responses, use a BOUNDED PEEK to
  // detect the empty-content-block pattern (content_filter stop_reason with
  // no content_block_* events) WITHOUT de-streaming non-empty responses.
  //
  // Parse SSE events incrementally. Stop buffering once a content_block_* event
  // or a known non-Claude SSE payload appears, replay the buffered prefix, then
  // pipe the original reader so the rest of the stream keeps flowing normally.
  // Only fail over when a complete Claude lifecycle ends without content_block.
  //
  // Non-text/event-stream streaming responses are not buffered at all.
  if (isStreaming) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      return { valid: true };
    }

    if (!response.body) {
      return { valid: true };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    // Raw Uint8Array chunks accumulated so far — used to replay the prefix
    // in the returned clonedResponse.
    const bufferedChunks: Uint8Array[] = [];
    // Decoded text accumulated across chunks for incremental SSE parsing.
    // Only the tail of the most-recently-processed line window remains here
    // between iterations (incomplete lines are deferred to the next chunk).
    let decodedSoFar = "";

    // SSE lifecycle state.
    let hasMessageStart = false;
    let hasContentBlock = false;
    let hasLifecycleEnd = false;
    let anyContentFound = false;
    let sawAnyBytes = false;
    // OpenAI-style streaming state (#5297 fix: detect "stop with empty choices"
    // emitted by some upstream models like GLM 5.2 on NVIDIA — they send a
    // `choices: [{delta: {}, finish_reason: 'stop'}]` chunk and then [DONE] with
    // no content, no tool_calls, no reasoning. Previously this slipped through
    // because we only watched the Claude content_block_* lifecycle.
    let hasOpenAIChoice = false;
    let hasOpenAIStopOrToolCalls = false;
    // Reasoning deltas are NOT wire content: GLM 5.2 with max effort emits long
    // `reasoning_content` but zero content/tool_calls and then finishes with
    // `stop` — a dead-end turn for the agent. Track it separately so
    // reasoning-only responses are flagged invalid for the combo empty-retry.
    let sawReasoning = false;
    // Mid-thought detection: GLM 5.2 sometimes emits real content that ends
    // mid-sentence (trailing `:`/`;`/`...`) and then `finish_reason: stop` —
    // the stream-layer MIDTHOUGHT synth would inject a `true` keep-alive in
    // that case; instead we flag it invalid here so the combo skips+failovers
    // to the next key (DeepSeek usually returns a complete answer).
    let openAIContentText = "";
    let openAIToolCallsFound = false;
    let openAICompletionTokens = 0;
    let openAIReasoningTokens = 0;
    const sseLineNormalizer = createSSEDataLineNormalizer();
    let pendingEventType = "";

    /**
     * Parse any complete SSE lines from `decodedSoFar`, updating lifecycle
     * flags in the closure. The last (potentially incomplete) line is kept in
     * `decodedSoFar` for the next iteration.
     *
     * Returns true when a content_block_* event is detected — the caller
     * should stop peeking and treat the stream as non-empty.
     */
    function parseAccumulatedSse(): boolean {
      const lines = decodedSoFar.split(/\r?\n/);
      // Retain the potentially-incomplete trailing fragment.
      decodedSoFar = lines[lines.length - 1];

      for (const line of sseLineNormalizer.normalize(lines.slice(0, -1))) {
        const trimmed = line.trim();

        if (trimmed.startsWith("event:")) {
          pendingEventType = trimmed.slice(6).trim();
          continue;
        }

        if (!trimmed.startsWith("data:")) {
          if (!trimmed) pendingEventType = "";
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType =
          (typeof parsed.type === "string" ? parsed.type : null) || pendingEventType || "";
        pendingEventType = "";

        if (isKnownNonClaudeStreamPayload(parsed, eventType)) {
          // #5297 — OpenAI-style streaming: track whether any choice emitted
          // content / tool_calls / reasoning, and whether the stream reached a
          // terminal finish_reason. At end-of-stream, if the stream completed
          // but emitted no valuable content, treat as invalid for combo
          // failover / retry.
          const choices = parsed.choices;
          if (Array.isArray(choices)) {
            for (const choice of choices) {
              if (!choice || typeof choice !== "object") continue;
              const c = choice as Record<string, unknown>;
              const delta = c.delta as Record<string, unknown> | undefined;
              const finish = c.finish_reason as string | null | undefined;
              if (Array.isArray(delta?.tool_calls) && (delta.tool_calls as unknown[]).length > 0) {
                anyContentFound = true;
                openAIToolCallsFound = true;
              }
              const deltaContent = delta?.content;
              if (typeof deltaContent === "string" && deltaContent.length > 0) {
                anyContentFound = true;
                openAIContentText += deltaContent;
              }
              const deltaReasoning =
                (delta?.reasoning_content as string | undefined) ??
                (delta?.reasoning as string | undefined);
              if (typeof deltaReasoning === "string" && deltaReasoning.length > 0) {
                // Deliberately NOT anyContentFound — see sawReasoning declaration.
                sawReasoning = true;
              }
              if (finish === "stop" || finish === "tool_calls" || finish === "length") {
                hasOpenAIStopOrToolCalls = true;
                hasOpenAIChoice = true;
              } else if (delta && typeof delta === "object" && Object.keys(delta).length > 0) {
                // Any non-empty delta (role, content, etc.) means we saw a real choice.
                if (
                  typeof delta.role === "string" ||
                  deltaContent ||
                  deltaReasoning ||
                  Array.isArray(delta.tool_calls)
                ) {
                  hasOpenAIChoice = true;
                }
              }
            }
            if (parsed.usage && typeof parsed.usage === "object") {
              const u = parsed.usage as Record<string, unknown>;
              openAICompletionTokens = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
              openAIReasoningTokens = Number(u.reasoning_tokens ?? u.reasoningTokens ?? 0) || 0;
            }
          }
          // Do NOT return true here: OpenAI-style streams must be peeked through
          // to end-of-stream so the terminal-finish checks below (empty stop,
          // mid-thought stop) can run. Returning true on the first chunk made
          // those checks dead code — the stream-layer MIDTHOUGHT/EMPTY synth
          // would then inject a `{"command":"true"}` keep-alive into the agent
          // context. Buffering the (usually short) OpenAI stream costs latency
          // but guarantees the combo skips+failovers instead of polluting.
          return false;
        }

        switch (eventType) {
          case "message_start":
            hasMessageStart = true;
            break;
          case "content_block_start":
          case "content_block_delta":
          case "content_block_stop":
            hasContentBlock = true;
            // Signal caller to stop buffering immediately.
            return true;
          case "message_stop":
            hasLifecycleEnd = true;
            break;
          case "message_delta": {
            const delta = parsed.delta;
            if (
              delta &&
              typeof delta === "object" &&
              (delta as Record<string, unknown>).stop_reason != null
            ) {
              hasLifecycleEnd = true;
            }
            break;
          }
          default:
            break;
        }
      }
      return false;
    }

    /**
     * Build a Response whose body first replays all bytes in `bufferedChunks`,
     * then forwards the remainder of `readerToForward` chunk-by-chunk.
     * Preserves the original response's status, statusText, and headers.
     */
    function buildReplayResponse(
      readerToForward: ReadableStreamDefaultReader<Uint8Array>
    ): Response {
      // Snapshot the prefix so mutations after this point don't affect it.
      const prefix = bufferedChunks.slice();
      let prefixIdx = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          // 1. Drain the buffered prefix one chunk at a time.
          if (prefixIdx < prefix.length) {
            controller.enqueue(prefix[prefixIdx++]);
            return;
          }
          // 2. Forward the remainder from the original reader.
          try {
            const { done, value } = await readerToForward.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Main bounded-peek loop.
    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Stream finished — flush the TextDecoder and parse any remaining text.
          const tail = decoder.decode(undefined, { stream: false });
          if (tail) decodedSoFar += tail;
          if (decodedSoFar.trim()) decodedSoFar += "\n\n";
          parseAccumulatedSse();

          if (hasMessageStart && hasLifecycleEnd && !hasContentBlock) {
            // Complete Claude lifecycle with zero content blocks → failover.
            log.warn?.(
              "COMBO",
              "Streaming Claude response has complete lifecycle but zero content blocks (content_filter?) — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming empty content block" };
          }

          // #5297 — OpenAI-style streaming: the stream reached a terminal
          // finish_reason ("stop" or "tool_calls") but emitted NO content and
          // NO tool_calls on the wire. This is the signature pattern of GLM 5.2
          // (and similar models) returning an empty assistant turn — the model
          // "thinks" (reasoning_content deltas, possibly thousands of tokens)
          // and then tells the agent "I'm done" with nothing to say, which
          // causes opencode to terminate the loop prematurely. Reasoning deltas
          // are deliberately NOT counted as wire content (sawReasoning), so a
          // reasoning-only terminal stop is flagged invalid here and the
          // per-target retry logic in combo.ts retries internally — the client
          // never sees the empty turn and no synthesized tool call is needed.
          // Guard against false positives on legitimately-tiny responses
          // (e.g. a 12-token "ok") by requiring completion_tokens >= 50 OR
          // reasoning deltas — if usage confirms the model emitted meaningful
          // tokens WITH content, anyContentFound is true anyway.
          if (
            !anyContentFound &&
            hasOpenAIStopOrToolCalls &&
            (openAICompletionTokens < 100 || sawReasoning)
          ) {
            log.warn?.(
              "COMBO",
              `Streaming OpenAI-style response has terminal finish_reason but no content/tool_calls on the wire (completion_tokens=${openAICompletionTokens}, reasoning_only=${sawReasoning}) — marking as invalid for combo retry`
            );
            return { valid: false, reason: "streaming empty stop with no content" };
          }

          // Mid-thought stop: content reached the wire but ends mid-sentence
          // (trimmed last char is `:`/`;`/`,` OR trailed by `...`) and the turn
          // finished with stop/length and NO tool_calls. A complete agent turn
          // never ends with a bare colon, comma, or ellipsis; the model was cut
          // off. Flag invalid so the combo skips+failovers to the next key
          // (DeepSeek returns a complete answer) instead of the stream-layer
          // MIDTHOUGHT synth emitting a `true` keep-alive that pollutes the
          // context. The comma must be included to stay aligned with the synth
          // layer's own mid-thought regex (`[:;,]$|\.\.\.$`).
          if (
            openAIContentText.length > 0 &&
            openAIContentText.trim().length > 0 &&
            !openAIToolCallsFound &&
            hasOpenAIStopOrToolCalls &&
            /[;:,]$|\.\.\.$/.test(openAIContentText.trim())
          ) {
            const tail = openAIContentText.trim().slice(-12);
            log.warn?.(
              "COMBO",
              `Streaming OpenAI-style response ended mid-thought (finish with no tool_calls, last chars=${JSON.stringify(tail)}) — marking as invalid for combo retry`
            );
            return { valid: false, reason: "streaming mid-thought stop" };
          }

          // Stream ended with a truly EMPTY body (e.g. Gemini returning HTTP
          // 200 with zero bytes) — mark as invalid for combo failover so the
          // sibling model gets tried. Streams that carried ANY SSE activity
          // (an explicit `data: [DONE]`, ping/metadata events, an incomplete
          // Claude lifecycle) keep the pass-through contract (#3399/#3685):
          // those are handled by the stream-readiness timeout, not failover.
          if (!anyContentFound && !hasContentBlock && !sawAnyBytes) {
            log.warn?.(
              "COMBO",
              "Streaming response ended with no recognized content — marking as invalid for combo failover"
            );
            return { valid: false, reason: "streaming no recognized content" };
          }

          // Incomplete lifecycle or non-Claude stream — replay all buffered
          // bytes. The reader is exhausted so the forwarding reader will
          // immediately signal done.
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }

        // Accumulate raw bytes for potential replay.
        bufferedChunks.push(value);
        if (value && value.length > 0) sawAnyBytes = true;

        // Decode incrementally (stream:true keeps multi-byte char state).
        decodedSoFar += decoder.decode(value, { stream: true });
        const foundContent = parseAccumulatedSse();

        if (foundContent) {
          anyContentFound = true;
          // A content_block_* event was found — stop peeking. Return a
          // clonedResponse that replays all buffered bytes (the current chunk
          // is already in bufferedChunks) and then forwards the remainder of
          // the original reader unchanged.
          const clonedResponse = buildReplayResponse(reader);
          return { valid: true, clonedResponse };
        }
      }
    } catch (streamErr) {
      // If reading the stream fails due to a locked stream or pipe error,
      // the content cannot be verified — mark as invalid for combo failover.
      // A locked ReadableStream means the response body is already consumed
      // or corrupted (e.g. "Invalid state: The ReadableStream is locked").
      // Broad match: Chrome/V8 throws "body used already", Firefox throws
      // "ReadableStream is locked", etc.
      const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
      if (
        streamErr instanceof TypeError &&
        (errMsg.includes("locked") ||
          errMsg.includes("disturbed") ||
          errMsg.includes("used already"))
      ) {
        return { valid: false, reason: "stream locked or disturbed" };
      }
      // Other read errors — pass through (stream readiness timeout will catch truly broken streams)
      return { valid: true };
    }
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !contentType.includes("text/")) {
    return { valid: true };
  }

  let cloned: Response;
  try {
    cloned = response.clone();
  } catch {
    return { valid: true };
  }

  let text: string;
  try {
    text = await cloned.text();
  } catch {
    return { valid: true };
  }

  if (!text || text.trim().length === 0) {
    return { valid: false, reason: "empty response body" };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    if (text.startsWith("data:") || text.startsWith("event:")) return { valid: true };
    return { valid: false, reason: "response is not valid JSON" };
  }

  // Feature 4985: apply the combo's configured response-body predicate. A failure here
  // fails over to the next target via the same path as the built-in empty-content checks.
  if (responseValidation) {
    const verdict = evaluateResponseValidation(json, responseValidation);
    if (!verdict.valid) {
      return { valid: false, reason: verdict.reason };
    }
  }

  // Issue #6427: a masked 200 — an OpenAI-shape top-level `error` object, or a
  // known exhaustion phrase in the error envelope — is a failure regardless of
  // whether `choices`/`output` also look structurally present (some providers
  // echo a stub completion alongside the error). Checked unconditionally, before
  // any shape-specific branch, so it can't be shadowed by an otherwise-valid body.
  const rawError = json?.error;
  const errorIsMeaningful =
    (typeof rawError === "string" && rawError.length > 0) ||
    (!!rawError && typeof rawError === "object" && Object.keys(rawError).length > 0);
  if (errorIsMeaningful) {
    const envelopeText = extractEnvelopeErrorText(json);
    const errMsg =
      rawError &&
      typeof rawError === "object" &&
      typeof (rawError as Record<string, unknown>).message === "string"
        ? ((rawError as Record<string, unknown>).message as string)
        : envelopeText || JSON.stringify(rawError).substring(0, 200);
    return { valid: false, reason: `upstream error in 200 body: ${errMsg}` };
  }
  {
    const envelopeText = extractEnvelopeErrorText(json);
    if (envelopeText && EXHAUSTION_MARKER_PATTERN.test(envelopeText)) {
      const snippet = envelopeText.length > 80 ? `${envelopeText.slice(0, 80)}…` : envelopeText;
      return { valid: false, reason: `upstream exhaustion marker in 200 body: ${snippet}` };
    }
  }

  const choices = json?.choices;
  if (json?.object === "response") {
    if (!responsesApiOutputHasContent(json.output))
      return { valid: false, reason: "empty_choices" };
    const status = typeof json.status === "string" ? json.status : "";
    if (status && !["completed", "done"].includes(status)) {
      return { valid: false, reason: "no_terminal" };
    }
    return {
      valid: true,
      clonedResponse: new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    };
  }

  if (!Array.isArray(choices) || choices.length === 0) {
    // `json?.error` is already handled unconditionally above (#6427); reaching
    // here means no error envelope was present.
    if (json?.output || json?.result || json?.data || json?.response) return { valid: true };
    return { valid: true };
  }

  const firstChoice = choices[0];
  const message = firstChoice?.message || firstChoice?.delta;
  if (!message) {
    return { valid: false, reason: "choice has no message object" };
  }

  const content = message.content;
  const toolCalls = message.tool_calls;
  // Issue #2341: Reasoning models (Kimi-K2.5-TEE, GLM-5-TEE, etc.) emit their
  // output in `reasoning_content` (or `reasoning`) with `content: null`. The
  // validator used to flag those as empty and trigger a false-positive 502
  // fallback. Count a non-empty reasoning_content as valid output too.
  const reasoningContent = message.reasoning_content ?? message.reasoning;
  const hasReasoningContent =
    typeof reasoningContent === "string" && reasoningContent.trim().length > 0;
  const hasContent =
    (content !== null && content !== undefined && content !== "") || hasReasoningContent;
  const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!hasContent && !hasToolCalls) {
    return { valid: false, reason: "empty content and no tool_calls in response" };
  }

  // Issue #3587: Reasoning models (deepseek-v4-flash, nemotron, etc.) may consume
  // ALL max_tokens for reasoning_tokens, leaving content empty. When content is
  // empty but reasoning_content exists, and usage shows reasoning consumed nearly
  // all completion tokens, treat as invalid so the combo loop retries with more
  // tokens or falls back to a non-reasoning model.
  const contentIsEmpty = content === null || content === undefined || content === "";
  if (contentIsEmpty && hasReasoningContent && !hasToolCalls) {
    const usage = json?.usage as Record<string, unknown> | undefined;
    if (usage) {
      const completionTokens = Number(usage.completion_tokens) || 0;
      const reasoningTokens = getReasoningTokens(usage);
      // If reasoning consumed 90%+ of completion tokens, the model ran out of
      // budget before producing any content output.
      if (completionTokens > 0 && reasoningTokens >= completionTokens * 0.9) {
        return {
          valid: false,
          reason: `reasoning consumed ${reasoningTokens}/${completionTokens} tokens — no content output`,
        };
      }
    }
  }

  return {
    valid: true,
    clonedResponse: new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  };
}

/**
 * Release the peek-and-abandon clone used by {@link validateResponseQuality}.
 *
 * The quality check clones the upstream response, reads the clone only until the
 * first content block, then hands back a `clonedResponse` that callers on the
 * streaming path DISCARD (they forward the original, untouched response). Because
 * a `Response.clone()` tees the body, that abandoned branch would otherwise buffer
 * the entire remaining body in memory until the original finishes streaming.
 *
 * Cancelling the abandoned branch releases that buffer. Per the ReadableStream tee
 * contract, cancelling one branch does NOT cancel the shared source while the other
 * branch (the original response being streamed to the client) is still active, so
 * this is safe. No-op when the clone fell back to the original (clone unsupported)
 * or when quality reading already exhausted the body (no `clonedResponse`).
 */
export function releaseQualityClone(
  clone: Response,
  original: Response,
  quality: { clonedResponse?: Response }
): void {
  if (clone === original) return;
  void quality.clonedResponse?.body?.cancel().catch(() => {});
}
