#!/usr/bin/env node
import Database from "better-sqlite3";
import crypto from "crypto";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// Mirror OmniRoute's encryption module
const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const STATIC_SALT = "omniroute-field-encryption-v1";

function getStaticKey() {
  const secret = process.env.STORAGE_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.scryptSync(secret, STATIC_SALT, KEY_LENGTH);
}

function encrypt(plaintext) {
  if (!plaintext || plaintext.startsWith(PREFIX)) return plaintext;
  const key = getStaticKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${PREFIX}${iv.toString("hex")}:${encrypted}:${tag}`;
}

const DATA_DIR = process.env.DATA_DIR || "./data";
const dbPath = resolve(DATA_DIR, "storage.sqlite");
console.log("[sql-import] Opening DB:", dbPath);
const db = new Database(dbPath);

// Read credentials
const credsPath = resolve(DATA_DIR, "import_credentials.json");
if (!existsSync(credsPath)) {
  console.error("[sql-import] Missing", credsPath);
  process.exit(1);
}
const data = JSON.parse(readFileSync(credsPath, "utf8"));
console.log(
  "[sql-import] Loaded",
  data.cloudflare_accounts.length,
  "CF,",
  data.nvidia_accounts.length,
  "NVIDIA,",
  data.proxies.length,
  "proxies"
);

// Clean up old
console.log("[sql-import] Cleaning existing resources...");
db.prepare("DELETE FROM combos WHERE name = ?").run("rotated-cf-nvidia");
const oldCf = db
  .prepare(
    "SELECT id FROM provider_connections WHERE name LIKE 'cloudflare-ai-%' OR name LIKE 'nvidia-%'"
  )
  .all();
for (const r of oldCf) {
  db.prepare("DELETE FROM proxy_assignments WHERE scope='account' AND scope_id = ?").run(r.id);
  db.prepare("DELETE FROM provider_connections WHERE id = ?").run(r.id);
}
const oldProxies = db
  .prepare("SELECT id FROM proxy_registry WHERE name LIKE 'nvidia-proxy-%'")
  .all();
for (const p of oldProxies) {
  db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(p.id);
  db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(p.id);
}

// Helper to insert provider_connection
function insertProvider({
  provider,
  auth_type,
  name,
  apiKey,
  is_active = 1,
  proxy_enabled = 1,
  accountId = null,
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const encrypted = encrypt(apiKey);
  const psd = accountId
    ? JSON.stringify({ accountId, baseUrl: "https://api.cloudflare.com/client/v4/accounts" })
    : null;
  db.prepare(
    `
    INSERT INTO provider_connections (
      id, provider, auth_type, name, priority, is_active, access_token, refresh_token,
      expires_at, token_expires_at, scope, project_id, test_status, error_code, last_error,
      last_error_at, last_error_type, last_error_source, backoff_level, rate_limited_until,
      health_check_interval, last_health_check_at, last_tested, api_key, id_token,
      provider_specific_data, expires_in, display_name, global_priority, default_model,
      token_type, consecutive_use_count, rate_limit_protection, last_used_at,
      "group", max_concurrent, proxy_enabled, per_key_proxy_enabled, quota_window_thresholds_json,
      rate_limit_overrides_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL, 'active', NULL, NULL,
              NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, NULL, ?, NULL, ?, NULL, NULL,
              NULL, 0, 1, NULL, NULL, NULL, ?, 0, NULL, NULL, ?, ?)
  `
  ).run(
    id,
    provider,
    auth_type,
    name,
    is_active,
    encrypted,
    psd,
    name,
    proxy_enabled,
    new Date().toISOString(),
    new Date().toISOString()
  );
  return id;
}

// Helper to insert proxy_registry
function insertProxy({
  name,
  type,
  host,
  port,
  username = "",
  password = "",
  status = "active",
  source = "manual",
}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO proxy_registry (id, name, type, host, port, username, password, status, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(id, name, type, host, port, username || "", password || "", status, source, now, now);
  return id;
}

// Helper to insert proxy_assignments
function insertProxyAssignment(proxyId, scope, scopeId, position) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO proxy_assignments (proxy_id, scope, scope_id, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `
  ).run(
    String(proxyId),
    String(scope),
    scopeId ? String(scopeId) : null,
    Number(position),
    String(now),
    String(now)
  );
  return null;
}

// 1. Insert 4 proxies
console.log("[sql-import] Inserting 4 proxies...");
const proxyIds = [];
for (const p of data.proxies) {
  const id = insertProxy(p);
  console.log(`  + proxy: ${p.name} -> ${p.host}:${p.port} (${id})`);
  proxyIds.push(id);
}

// 2. Insert 13 Cloudflare
console.log("[sql-import] Inserting 13 Cloudflare connections...");
const cfIds = [];
for (let i = 0; i < data.cloudflare_accounts.length; i++) {
  const a = data.cloudflare_accounts[i];
  const id = insertProvider({
    provider: "cloudflare-ai",
    auth_type: "apikey",
    name: a.name,
    apiKey: a.apiToken,
    accountId: a.accountId,
    is_active: 1,
    proxy_enabled: 0,
  });
  console.log(`  + CF: ${a.name} (${id})`);
  cfIds.push(id);
}

// 3. Insert 4 NVIDIA, each with proxy assignment
console.log("[sql-import] Inserting 4 NVIDIA + proxy assignments...");
const nvidiaIds = [];
for (let i = 0; i < data.nvidia_accounts.length; i++) {
  const a = data.nvidia_accounts[i];
  const id = insertProvider({
    provider: "nvidia",
    auth_type: "apikey",
    name: a.name,
    apiKey: a.apiKey,
    is_active: 1,
    proxy_enabled: 1,
  });
  console.log(`  + NVIDIA: ${a.name} (${id})`);
  nvidiaIds.push(id);
  // Assign proxy under 'account' scope
  insertProxyAssignment(proxyIds[i], "account", id, 0);
  console.log(`    -> assigned proxy ${data.proxies[i].name} (${proxyIds[i]})`);
}

// 4. Insert combo
console.log("[sql-import] Inserting combo rotated-cf-nvidia...");
const comboId = crypto.randomUUID();
const modelsList = [];
for (const cfId of cfIds) {
  modelsList.push({
    kind: "model",
    provider: "cloudflare-ai",
    model: "@cf/zai-org/glm-5.2",
    connectionId: cfId,
    weight: 0,
  });
}
for (const nvId of nvidiaIds) {
  modelsList.push({
    kind: "model",
    provider: "nvidia",
    model: "z-ai/glm-5.2",
    connectionId: nvId,
    weight: 0,
  });
}
const comboPayload = {
  name: "rotated-cf-nvidia",
  strategy: "round-robin",
  models: modelsList,
  config: {},
};
const now = new Date().toISOString();
db.prepare(
  `
  INSERT INTO combos (id, name, data, sort_order, created_at, updated_at)
  VALUES (?, ?, ?, 0, ?, ?)
`
).run(comboId, comboPayload.name, JSON.stringify(comboPayload), now, now);
console.log(`  + combo: ${comboPayload.name} (${comboId}) with ${modelsList.length} targets`);

console.log("[sql-import] Deleting credentials file...");
try {
  unlinkSync(credsPath);
  console.log("  + cleaned");
} catch (e) {
  console.log("  ! delete failed:", e.message);
}

console.log("\n[sql-import] DONE: 17 connections + 4 proxies + 1 combo + 4 assignments seeded.");
