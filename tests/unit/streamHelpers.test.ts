import { describe, it } from "node:test";
import assert from "node:assert";
import {
  hasValuableContent,
  isKnownNonClaudeStreamPayload,
  unwrapGeminiChunk,
} from "../../open-sse/utils/streamHelpers.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";

describe("hasValuableContent", () => {
  describe("OpenAI format", () => {
    it("returns true for content with text", () => {
      const chunk = { choices: [{ delta: { content: "Hello" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns false for empty delta", () => {
      const chunk = { choices: [{ delta: {} }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), false);
    });

    it("returns false for delta with empty string content", () => {
      const chunk = { choices: [{ delta: { content: "" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), false);
    });

    it("returns true for reasoning_content", () => {
      const chunk = { choices: [{ delta: { reasoning_content: "thinking" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns true for client-readable reasoning", () => {
      const chunk = { choices: [{ delta: { reasoning: "thinking" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns true for Copilot reasoning_text", () => {
      const chunk = { choices: [{ delta: { reasoning_text: "thinking" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns true for OpenRouter reasoning_details", () => {
      const chunk = {
        choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: "thinking" }] } }],
      };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns true for finish_reason", () => {
      const chunk = { choices: [{ delta: {}, finish_reason: "stop" }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });

    it("returns true for role delta", () => {
      const chunk = { choices: [{ delta: { role: "assistant" } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.OPENAI), true);
    });
  });

  describe("Claude format", () => {
    it("returns true for content_block_delta with text", () => {
      const chunk = { type: "content_block_delta", delta: { text: "Hello" } };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.CLAUDE), true);
    });

    it("returns false for empty content_block_delta", () => {
      const chunk = { type: "content_block_delta", delta: {} };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.CLAUDE), false);
    });

    it("returns true for thinking blocks", () => {
      const chunk = { type: "content_block_delta", delta: { thinking: "reasoning" } };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.CLAUDE), true);
    });
  });

  describe("Gemini format", () => {
    it("returns true for content with text", () => {
      const chunk = { candidates: [{ content: { parts: [{ text: "Hello" }] } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.GEMINI), true);
    });

    it("returns false for empty parts", () => {
      const chunk = { candidates: [{ content: { parts: [] } }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.GEMINI), false);
    });

    it("returns true for finishReason", () => {
      const chunk = { candidates: [{ finishReason: "STOP" }] };
      assert.strictEqual(hasValuableContent(chunk, FORMATS.GEMINI), true);
    });
  });
});

describe("unwrapGeminiChunk", () => {
  it("returns chunk directly when candidates is at top level (standard Gemini)", () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "Hi" }] } }], usageMetadata: {} };
    const result = unwrapGeminiChunk(chunk);
    assert.strictEqual(result, chunk);
  });

  it("unwraps Cloud Code envelope { response: { candidates: [...] } }", () => {
    const inner = { candidates: [{ content: { parts: [{ text: "Hello" }] } }] };
    const chunk = { response: inner, modelVersion: "gemini-2.5-flash" };
    const result = unwrapGeminiChunk(chunk);
    assert.strictEqual(result, inner);
    assert.deepEqual(result.candidates[0].content.parts[0].text, "Hello");
  });

  it("returns parsed directly when no candidates and no response", () => {
    const chunk = { someOther: "data" };
    const result = unwrapGeminiChunk(chunk);
    assert.strictEqual(result, chunk);
  });

  it("returns parsed when response is null (falsy) — no valid envelope to unwrap", () => {
    const chunk = { response: null, other: "data" };
    const result = unwrapGeminiChunk(chunk);
    assert.strictEqual(result, chunk);
  });

  it("prefers top-level candidates over response when both exist", () => {
    const inner = { candidates: [{ content: { parts: [{ text: "inner" }] } }] };
    const chunk = {
      candidates: [{ content: { parts: [{ text: "outer" }] } }],
      response: inner,
    };
    const result = unwrapGeminiChunk(chunk);
    assert.strictEqual(result, chunk);
    assert.equal(result.candidates[0].content.parts[0].text, "outer");
  });
});

// #5297 — `isKnownNonClaudeStreamPayload` is the gate the combo validator uses
// (via `validateResponseQuality`) to decide whether a streaming chunk should
// enter the OpenAI per-delta branch that accumulates content + sets the
// `hasOpenAIStopOrToolCalls` flag. Historically a chunk with
// `choices:[{delta:{role:"assistant"},finish_reason:"stop"}]` (GLM 5.2 / DeepSeek
// final chunk shape) returned FALSE because the delta was content/reasoning/
// tool_calls-empty — so the validator fell through to the Anthropic switch,
// the `ob` flag never set, and the empty-stop / mid-thought checks (which both
// require `terminated`) were dead code for those responses. The combo then
// forwarded truncated responses ("Reasons:", "The answer is:") to the client,
// terminating the agent loop. Patched 2026-08-02: a choice with a non-empty
// `finish_reason` is a recognized OpenAI-style chunk even when the delta is
// empty, so `ob` flips and the checks fire.
describe("isKnownNonClaudeStreamPayload — #5297 terminal-chunk recognition", () => {
  it("returns true for a content chunk (baseline)", () => {
    const chunk = { object: "chat.completion.chunk", choices: [{ delta: { content: "hi" } }] };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), true);
  });

  it("returns true for an empty-delta chunk with finish_reason=stop", () => {
    // GLM 5.2 / DeepSeek final-chunk shape: delta has role only, no content,
    // finish_reason='stop'. Without the fix this returned false.
    const chunk = {
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" }, finish_reason: "stop" }],
    };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), true);
  });

  it("returns true for a fully empty delta with finish_reason=stop", () => {
    const chunk = {
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
    };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), true);
  });

  it("returns true for finish_reason=tool_calls", () => {
    const chunk = {
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), true);
  });

  it("returns true for finish_reason=length", () => {
    const chunk = {
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "length" }],
    };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), true);
  });

  it("returns false for a fully empty delta with no finish_reason", () => {
    const chunk = {
      object: "chat.completion.chunk",
      choices: [{ delta: {} }],
    };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), false);
  });

  it("returns false for choices:[] (empty array)", () => {
    const chunk = { object: "chat.completion.chunk", choices: [] };
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), false);
  });

  it("returns false for an Anthropic message_delta with no finish chunk", () => {
    const chunk = { type: "message_delta", delta: { stop_reason: "end_turn" } };
    // message_delta is not an OpenAI-shape chunk; falls through Anthropic branch.
    assert.strictEqual(isKnownNonClaudeStreamPayload(chunk), false);
  });
});
