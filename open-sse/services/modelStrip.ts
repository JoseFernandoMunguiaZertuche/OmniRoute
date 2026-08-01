import { PROVIDER_ID_TO_ALIAS, getModelStripTypes } from "../config/providerModels.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function shouldStripPart(part: JsonRecord, stripTypes: Set<string>): boolean {
  const type = typeof part.type === "string" ? part.type : "";
  if (!type) return false;

  if (stripTypes.has(type)) return true;
  if (stripTypes.has("image") && (type === "image_url" || type === "image")) return true;
  if (stripTypes.has("audio") && (type === "input_audio" || type === "audio")) return true;
  return false;
}

const DIRECTIVE_PLACEHOLDER = {
  type: "text",
  text:
    "[Image omitted — this model cannot read images. Do not retry with the same request; " +
    "if image data is essential, ask the user for a textual description instead.]",
};

function filterContentArray(
  content: unknown[],
  stripSet: Set<string>
): { filtered: unknown[]; removedParts: number } {
  let removedParts = 0;
  const filtered: unknown[] = [];

  for (const part of content) {
    const partRecord = asRecord(part);

    if (shouldStripPart(partRecord, stripSet)) {
      removedParts += 1;
      continue;
    }

    if (Array.isArray(partRecord.content)) {
      const nested = filterContentArray(partRecord.content, stripSet);
      removedParts += nested.removedParts;
      if (nested.filtered.length === 0) {
        filtered.push({ ...partRecord, content: [DIRECTIVE_PLACEHOLDER] });
      } else if (nested.removedParts > 0) {
        filtered.push({ ...partRecord, content: nested.filtered });
      } else {
        filtered.push(part);
      }
      continue;
    }

    filtered.push(part);
  }

  return { filtered, removedParts };
}

export function stripIncompatibleMessageContent(
  messages: unknown,
  stripTypes: readonly string[]
): { messages: unknown; removedParts: number } {
  if (!Array.isArray(messages) || stripTypes.length === 0) {
    return { messages, removedParts: 0 };
  }

  const stripSet = new Set(stripTypes);
  let totalRemoved = 0;
  const sanitizedMessages = messages.map((message) => {
    const record = asRecord(message);
    if (!Array.isArray(record.content)) {
      return message;
    }

    const { filtered, removedParts } = filterContentArray(record.content, stripSet);
    if (removedParts === 0) {
      return message;
    }
    totalRemoved += removedParts;

    if (filtered.length === 0) {
      return { ...record, content: [DIRECTIVE_PLACEHOLDER] };
    }

    return { ...record, content: filtered };
  });

  return { messages: sanitizedMessages, removedParts: totalRemoved };
}

export function getStripTypesForProviderModel(providerId: string, modelId: string): string[] {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return getModelStripTypes(alias, modelId);
}
