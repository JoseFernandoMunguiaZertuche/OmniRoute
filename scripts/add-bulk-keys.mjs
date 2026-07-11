#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * add-bulk-keys.mjs — add multiple API-key connections for a single provider.
 *
 * Reads specs from STDIN, one per line: `provider:key[:label]`
 *   - The key is NEVER echoed to stdout/logs.
 *   - Use `nvidia:KEY:nvidia-N` for each NVIDIA NIM key (or any provider).
 *   - Existing rows are updated, not duplicated (idempotent on the key hash).
 *
 * Usage:
 *   printf 'nvidia:KEY1:nvidia-1\nnvidia:KEY2:nvidia-2\n' \
 *     | node --import tsx/esm scripts/add-bulk-keys.mjs
 *
 *   # Or from a temp file you wipe immediately after:
 *   node --import tsx/esm scripts/add-bulk-keys.mjs < /tmp/keys.txt
 *   rm /tmp/keys.txt
 *
 * Uses createProviderConnection() from src/lib/db/providers.ts — encryption,
 * dedup, and provider-specific normalization go through the proper domain
 * module. No raw SQL.
 */

import { createInterface } from "node:readline";
import { createProviderConnection, getProviderConnections } from "@/lib/db/providers";
import { logger } from "@omniroute/open-sse/utils/logger.ts";

const log = logger("add-bulk-keys");

function mask(key) {
  if (!key || key.length < 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function existingKeys(provider) {
  const rows = await getProviderConnections({ provider });
  return new Set((rows || []).map((r) => r.apiKey).filter(Boolean));
}

async function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let processed = 0;
  let added = 0;
  let updated = 0;
  let skipped = 0;
  const failed = [];

  const before = new Map();
  for await (const lineRaw of rl) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    processed += 1;

    const firstColon = line.indexOf(":");
    if (firstColon < 1) {
      failed.push({ line: mask(line), error: "missing `provider:key[:label]` separator" });
      continue;
    }
    const provider = line.slice(0, firstColon).trim();
    const rest = line.slice(firstColon + 1);
    const lastColon = rest.lastIndexOf(":");
    let key, label;
    if (
      lastColon > 0 &&
      rest.slice(lastColon + 1).length > 0 &&
      !rest.slice(lastColon + 1).includes(" ")
    ) {
      key = rest.slice(0, lastColon);
      label = rest.slice(lastColon + 1).trim();
    } else {
      key = rest;
      label = undefined;
    }
    if (!provider || !key) {
      failed.push({ line: mask(`${provider}:${key}`), error: "empty provider or key" });
      continue;
    }

    try {
      if (!before.has(provider)) before.set(provider, await existingKeys(provider));
      const seen = before.get(provider);
      const result = await createProviderConnection({
        provider,
        apiKey: key,
        name: label || `${provider}-${processed}`,
        authType: "apikey",
        priority: 100,
        isActive: true,
      });
      if (seen.has(key)) {
        updated += 1;
      } else {
        added += 1;
      }
      console.log(
        `OK  ${provider}  ${mask(key)}  →  ${label || "(no label)"}  (id=${result?.id ?? "?"})`
      );
    } catch (err) {
      failed.push({ line: mask(key), error: err?.message || String(err) });
    }
  }

  console.error(
    `\nbulk add summary: ${processed} parsed, ${added} added, ${updated} updated, ${skipped} skipped, ${failed.length} failed`
  );
  if (failed.length) {
    console.error("failures (keys masked):");
    for (const f of failed) console.error(`  - ${f.line}: ${f.error}`);
    process.exit(1);
  }
  log.info("bulk add complete", { processed, added, updated, failed: failed.length });
}

main().catch((err) => {
  console.error("fatal:", err?.message || err);
  process.exit(2);
});
