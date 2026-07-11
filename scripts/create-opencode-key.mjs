#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * create-opencode-key.mjs — one-shot helper to mint an OmniRoute API key
 * for the OpenCode integration. Uses the same createApiKey() function
 * the dashboard uses, so the key works the same way.
 *
 * Usage:
 *   node --import tsx/esm scripts/create-opencode-key.mjs [label] [scope]
 *
 * Output: prints `sk-…` to stdout (one line), nothing else. Capture with
 * a shell redirect and chmod 600 the result.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const label = process.argv[2] || "opencode";
const scope = process.argv[3] || "chat";

// createApiKey() needs API_KEY_SECRET in env — load it from .env if not set.
if (!process.env.API_KEY_SECRET) {
  for (const candidate of [resolve(process.cwd(), ".env"), "/home/jferm/OmniRoute/.env"]) {
    try {
      for (const line of readFileSync(candidate, "utf8").splitlines()) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) {
          let v = m[2];
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          process.env[m[1]] = v;
        }
      }
      break;
    } catch {
      // try next
    }
  }
}

const { getDbInstance } = await import("../src/lib/db/core.ts");
const { createApiKey } = await import("../src/lib/db/apiKeys.ts");
getDbInstance();
const created = await createApiKey(label, randomUUID(), [scope]);

if (!created || !created.key) {
  console.error("failed to create key");
  process.exit(1);
}

const out = resolve(process.env.HOME || "~", ".config", "opencode", "omniroute.key");
try {
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(out, created.key + "\n");
  chmodSync(out, 0o600);
  console.log(`key written to ${out}`);
  console.log(`length: ${created.key.length}`);
  console.log(`prefix: ${(created.keyPrefix || created.key.slice(0, 8)) + "…"}`);
} catch {
  // fall back to stdout (still safe — caller can redirect)
  process.stdout.write(created.key + "\n");
}
