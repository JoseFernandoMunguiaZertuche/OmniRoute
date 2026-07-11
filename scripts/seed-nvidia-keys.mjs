#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * seed-nvidia-keys.mjs — Write NVIDIA NIM API keys directly into OmniRoute's
 * SQLite storage with proper AES-GCM encryption. Bypasses the API/server.
 *
 * Two modes:
 *   1. ENC mode (default) — reads STORAGE_ENCRYPTION_KEY from .env, encrypts
 *      api_key column values with AES-256-GCM using the same scheme as
 *      src/lib/db/encryption.ts (scrypt-derived key, static salt "omniroute-field-encryption-v1",
 *      iv length 16, auth tag length 16, format enc:v1:<iv_hex>:<ct_hex>:<tag_hex>).
 *   2. PLAINTEXT mode — stores api_key as plaintext. ONLY use if
 *      STORAGE_ENCRYPTION_KEY isn't set in your .env (the server's
 *      encryptConnectionFields() falls back to passthrough in that case).
 *
 * Reads NVIDIA keys from NDKEYS environment variable as a JSON array
 * `[{name,apiKey}, ...]` so the keys never appear in argv / shell history.
 *
 * Usage:
 *   export $(grep -v '^#' .env | xargs)
 *   NDKEYS='[{"name":"nvidia-1","apiKey":"KEY1"},...]' \
 *     node --import tsx/esm scripts/seed-nvidia-keys.mjs
 *
 * The target DB path is set via SQLITE_FILE env var, defaulting to the
 * DATA_DIR-aware path used by the running OmniRoute server.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scryptSync, randomBytes, createCipheriv } from "node:crypto";

const PREFIX = "enc:v1:";
const STATIC_SALT = "omniroute-field-encryption-v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function deriveKey() {
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret) return null;
  return scryptSync(secret, STATIC_SALT, KEY_LENGTH);
}

function encryptField(plaintext, key) {
  if (!plaintext.startsWith(PREFIX) && key) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    let ct = cipher.update(plaintext, "utf8", "hex");
    ct += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    plaintext = `${PREFIX}${iv.toString("hex")}:${ct}:${tag}`;
  }
  return plaintext;
}

function loadEnvIfNeeded() {
  if (!process.env.STORAGE_ENCRYPTION_KEY || !process.env.DATA_DIR) {
    try {
      const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      for (const line of raw.splitlines()) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
    } catch {
      /* ok */
    }
  }
}

function defaultSqlitePath() {
  const dataDir = process.env.DATA_DIR || "/home/jferm/OmniRoute/data";
  return resolve(dataDir, "storage.sqlite");
}

function uuid() {
  return crypto.randomUUID();
}

async function main() {
  loadEnvIfNeeded();
  const key = deriveKey();
  if (!key) {
    console.warn(
      "[seed] STORAGE_ENCRYPTION_KEY not set — writing api_key in plaintext (server will passthrough too)."
    );
  } else {
    console.log("[seed] STORAGE_ENCRYPTION_KEY loaded — will AES-256-GCM encrypt api_key values.");
  }

  const sqliteFile = process.env.SQLITE_FILE || defaultSqlitePath();
  console.log("[seed] Target SQLite file:", sqliteFile);

  const raw = process.env.NDKEYS;
  if (!raw) {
    console.error("[seed] NDKEYS env var is required. Example:");
    console.error('  NDKEYS=\'[{"name":"nvidia-1","apiKey":"nvapi-..."}]\'');
    process.exit(2);
  }

  let keys;
  try {
    keys = JSON.parse(raw);
    if (!Array.isArray(keys) || !keys.length) throw new Error("expected non-empty array");
  } catch (e) {
    console.error("[seed] NDKEYS parse failed:", e.message);
    process.exit(2);
  }

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(sqliteFile);

  // Make sure schema is there (create tables only if missing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      auth_type TEXT,
      name TEXT,
      email TEXT,
      priority INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      token_expires_at TEXT,
      scope TEXT,
      project_id TEXT,
      test_status TEXT,
      error_code TEXT,
      last_error TEXT,
      last_error_at TEXT,
      last_error_type TEXT,
      last_error_source TEXT,
      backoff_level INTEGER DEFAULT 0,
      rate_limited_until TEXT,
      health_check_interval INTEGER,
      last_health_check_at TEXT,
      last_tested TEXT,
      api_key TEXT,
      id_token TEXT,
      provider_specific_data TEXT,
      expires_in INTEGER,
      display_name TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO provider_connections (
      id, provider, auth_type, name, priority, is_active, api_key, created_at, updated_at
    ) VALUES (@id, @provider, 'apikey', @name, @priority, 1, @api_key, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      api_key = excluded.api_key,
      priority = excluded.priority,
      is_active = 1,
      updated_at = excluded.updated_at
  `);
  const findByName = db.prepare(
    `SELECT id FROM provider_connections WHERE provider='nvidia' AND auth_type='apikey' AND name=?`
  );

  let added = 0;
  let updated = 0;

  // Better-sqlite3 needs node:crypto's randomUUID in this older node — fall back if needed
  const _uuid = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : null;
  function id() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
          (c ^ (crypto.randomBytes(1)[0] & (15 >> (c / 4)))).toString(16)
        );
  }

  for (const k of keys) {
    const name = String(k.name || "").trim();
    const apiKey = String(k.apiKey || "").trim();
    if (!name || !apiKey) {
      console.warn("[seed] skip invalid entry:", name);
      continue;
    }
    const stored = encryptField(apiKey, key);
    const existing = findByName.get(name);
    let rowId;
    if (existing) {
      rowId = existing.id;
      db.prepare(
        `UPDATE provider_connections SET api_key=?, priority=?, is_active=1, updated_at=? WHERE id=?`
      ).run(stored, 100, now, rowId);
      updated += 1;
    } else {
      rowId = id();
      insert.run({ id: rowId, provider: "nvidia", name, priority: 100, api_key: stored, now });
      added += 1;
    }
    const masked = apiKey.length > 12 ? apiKey.slice(0, 4) + "…" + apiKey.slice(-4) : "***";
    console.log(`[seed] OK ${name.padEnd(10)} id=${rowId.slice(0, 8)} api_key=${masked}`);
  }

  db.close();

  console.log(`\n[seed] summary: ${added} added, ${updated} updated, ${keys.length} total`);
  console.log(
    "[seed] Run `SELECT name, is_active, priority FROM provider_connections WHERE provider='nvidia';` to verify."
  );
}

main().catch((e) => {
  console.error("[seed] fatal:", e?.message || e);
  process.exit(1);
});
