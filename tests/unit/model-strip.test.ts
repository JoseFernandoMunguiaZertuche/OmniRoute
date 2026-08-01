import test from "node:test";
import assert from "node:assert/strict";

import {
  getStripTypesForProviderModel,
  stripIncompatibleMessageContent,
} from "../../open-sse/services/modelStrip.ts";

test("stripIncompatibleMessageContent removes image and audio parts but preserves text", () => {
  const originalMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: "Summarize this input." },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
        { type: "input_audio", input_audio: { data: "abc", format: "wav" } },
      ],
    },
  ];

  const result = stripIncompatibleMessageContent(originalMessages, ["image", "audio"]);

  assert.equal(result.removedParts, 2);
  assert.deepEqual(result.messages, [
    {
      role: "user",
      content: [{ type: "text", text: "Summarize this input." }],
    },
  ]);
});

test("stripIncompatibleMessageContent leaves non-array content untouched", () => {
  const originalMessages = [{ role: "user", content: "hello" }];

  const result = stripIncompatibleMessageContent(originalMessages, ["image"]);

  assert.equal(result.removedParts, 0);
  assert.deepEqual(result.messages, originalMessages);
});

test('getStripTypesForProviderModel declares strip=["image"] for GLM 5.2 text-only targets', () => {
  assert.deepEqual(getStripTypesForProviderModel("cloudflare-ai", "@cf/zai-org/glm-5.2"), [
    "image",
  ]);
  assert.deepEqual(getStripTypesForProviderModel("nvidia", "z-ai/glm-5.2"), ["image"]);
  assert.deepEqual(getStripTypesForProviderModel("zai", "glm-5.2"), ["image"]);
});

test("stripIncompatibleMessageContent replaces image-only content with a directive placeholder", () => {
  const originalMessages = [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
    },
  ];

  const result = stripIncompatibleMessageContent(originalMessages, ["image"]);

  assert.equal(result.removedParts, 1);
  assert.equal(result.messages[0].content.length, 1);
  assert.equal(result.messages[0].content[0].type, "text");
  assert.match(result.messages[0].content[0].text, /cannot read images/);
  assert.match(result.messages[0].content[0].text, /Do not retry/);
});

test("stripIncompatibleMessageContent handles tool-result image parts (Anthropic source format)", () => {
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "abcd" } },
            { type: "text", text: "see above" },
          ],
        },
      ],
    },
  ];

  const result = stripIncompatibleMessageContent(messages, ["image"]);

  assert.equal(result.removedParts, 1);
  assert.equal(result.messages[0].content[0].content.length, 1);
  assert.equal(result.messages[0].content[0].content[0].type, "text");
});
