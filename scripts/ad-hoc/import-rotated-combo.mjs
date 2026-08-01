#!/usr/bin/env node
/* eslint-disable no-console */

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

// 1. Load environment variables from .env to obtain encryption keys, etc.
function loadEnvIfNeeded() {
  if (!process.env.STORAGE_ENCRYPTION_KEY || !process.env.DATA_DIR) {
    try {
      const envPath = resolve(process.cwd(), ".env");
      if (existsSync(envPath)) {
        const raw = readFileSync(envPath, "utf8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          const m = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
          if (m && !process.env[m[1]]) {
            let val = m[2].trim();
            if (
              (val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))
            ) {
              val = val.slice(1, -1);
            }
            process.env[m[1]] = val;
          }
        }
      }
    } catch (e) {
      console.warn("[import] Warning: Failed to load .env file:", e.message);
    }
  }
}

async function main() {
  loadEnvIfNeeded();

  // Force data dir to local project data folder where storage.sqlite resides
  process.env.DATA_DIR = "data";
  console.log("[import] Using DATA_DIR:", process.env.DATA_DIR);

  // 2. Read the credentials JSON template
  const credentialsPath = resolve(process.cwd(), "data/import_credentials.json");
  if (!existsSync(credentialsPath)) {
    console.error(`[import] Error: Credentials file not found at ${credentialsPath}`);
    console.error("[import] Please run the template step first or create the file.");
    process.exit(1);
  }

  const content = readFileSync(credentialsPath, "utf8");

  // Guard: make sure user replaced placeholders before proceeding
  if (content.includes("PLACEHOLDER_")) {
    console.error(
      "[import] Error: Please edit 'data/import_credentials.json' and fill in your actual credentials first."
    );
    console.error("[import] Make sure all 'PLACEHOLDER_' values are replaced.");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (e) {
    console.error("[import] Error parsing credentials JSON:", e.message);
    process.exit(1);
  }

  // 3. Import database modules dynamically after setting DATA_DIR env
  const { getDbInstance } = await import("../../src/lib/db/core.ts");
  const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
  const { createProxy, assignProxyToScope } = await import("../../src/lib/db/proxies.ts");
  const { createCombo } = await import("../../src/lib/db/combos.ts");

  const db = getDbInstance();

  // 4. Ensure idempotency by deleting any existing assets from previous runs
  console.log("[import] Cleaning up existing resources to prevent duplicates...");

  // Delete combo
  db.prepare("DELETE FROM combos WHERE name = ?").run("rotated-cf-nvidia");

  // Clean up existing rotated connections
  const connNames = [
    ...Array.from({ length: 13 }, (_, i) => `cloudflare-ai-${i + 1}`),
    ...Array.from({ length: 4 }, (_, i) => `nvidia-${i + 1}`),
  ];
  const connPlaceholders = connNames.map(() => "?").join(",");
  const existingConns = db
    .prepare(`SELECT id FROM provider_connections WHERE name IN (${connPlaceholders})`)
    .all(...connNames);

  for (const conn of existingConns) {
    db.prepare("DELETE FROM proxy_assignments WHERE scope = 'account' AND scope_id = ?").run(
      conn.id
    );
    db.prepare("DELETE FROM provider_connections WHERE id = ?").run(conn.id);
  }

  // Clean up existing rotated proxies
  const proxyNames = Array.from({ length: 4 }, (_, i) => `nvidia-proxy-${i + 1}`);
  const proxyPlaceholders = proxyNames.map(() => "?").join(",");
  const existingProxies = db
    .prepare(`SELECT id FROM proxy_registry WHERE name IN (${proxyPlaceholders})`)
    .all(...proxyNames);

  for (const p of existingProxies) {
    db.prepare("DELETE FROM proxy_assignments WHERE proxy_id = ?").run(p.id);
    db.prepare("DELETE FROM proxy_registry WHERE id = ?").run(p.id);
  }

  console.log("[import] Existing resources cleaned successfully.");

  // 5. Create the 4 Proxies
  console.log("[import] Creating 4 proxies in the registry...");
  const proxyIds = [];
  if (!Array.isArray(data.proxies) || data.proxies.length !== 4) {
    console.error("[import] Error: 'proxies' array in credentials JSON must have exactly 4 items.");
    process.exit(1);
  }

  for (const proxyData of data.proxies) {
    const payload = {
      name: proxyData.name,
      type: proxyData.type || "socks5",
      host: proxyData.host,
      port: Number(proxyData.port),
      username: proxyData.username || "",
      password: proxyData.password || "",
      status: "active",
      source: "manual",
    };
    const createdProxy = await createProxy(payload);
    if (!createdProxy) {
      throw new Error(`Failed to create proxy registry entry for ${proxyData.name}`);
    }
    console.log(
      `[import] Registered proxy: ${proxyData.name} -> ${proxyData.host}:${proxyData.port} (${createdProxy.id})`
    );
    proxyIds.push(createdProxy.id);
  }

  // 6. Create the 13 Cloudflare connections
  console.log("[import] Creating 13 Cloudflare Workers AI connections...");
  const cfConnectionIds = [];
  if (!Array.isArray(data.cloudflare_accounts) || data.cloudflare_accounts.length !== 13) {
    console.error(
      "[import] Error: 'cloudflare_accounts' array in credentials JSON must have exactly 13 items."
    );
    process.exit(1);
  }

  for (let i = 0; i < data.cloudflare_accounts.length; i++) {
    const acct = data.cloudflare_accounts[i];
    const name = `cloudflare-ai-${i + 1}`;
    const payload = {
      provider: "cloudflare-ai",
      authType: "apikey",
      name,
      apiKey: acct.apiToken,
      providerSpecificData: {
        accountId: acct.accountId,
      },
      isActive: true,
      proxyEnabled: true,
    };
    const conn = await createProviderConnection(payload);
    if (!conn) {
      throw new Error(`Failed to create connection for ${name}`);
    }
    console.log(`[import] Registered connection: ${name} (${conn.id})`);
    cfConnectionIds.push(conn.id);
  }

  // 7. Create the 4 NVIDIA connections & map their proxies individually
  console.log("[import] Creating 4 NVIDIA NIM connections and mapping proxies...");
  const nvidiaConnectionIds = [];
  if (!Array.isArray(data.nvidia_accounts) || data.nvidia_accounts.length !== 4) {
    console.error(
      "[import] Error: 'nvidia_accounts' array in credentials JSON must have exactly 4 items."
    );
    process.exit(1);
  }

  for (let i = 0; i < data.nvidia_accounts.length; i++) {
    const acct = data.nvidia_accounts[i];
    const name = `nvidia-${i + 1}`;
    const payload = {
      provider: "nvidia",
      authType: "apikey",
      name,
      apiKey: acct.apiKey,
      isActive: true,
      proxyEnabled: true,
    };
    const conn = await createProviderConnection(payload);
    if (!conn) {
      throw new Error(`Failed to create connection for ${name}`);
    }

    // Link proxy under account scope
    const proxyId = proxyIds[i];
    await assignProxyToScope("account", conn.id, proxyId);

    console.log(
      `[import] Registered connection: ${name} (${conn.id}) -> proxy: ${proxyNames[i]} (${proxyId})`
    );
    nvidiaConnectionIds.push(conn.id);
  }

  // 8. Construct the load-balanced Combo Model
  console.log("[import] Creating Combo Model: rotated-cf-nvidia with round-robin...");
  const modelsList = [];

  // Cloudflare targets
  for (const connId of cfConnectionIds) {
    modelsList.push({
      kind: "model",
      provider: "cloudflare-ai",
      model: "@cf/meta/llama-3.3-70b-instruct",
      connectionId: connId,
      weight: 0,
    });
  }

  // NVIDIA targets
  for (const connId of nvidiaConnectionIds) {
    modelsList.push({
      kind: "model",
      provider: "nvidia",
      model: "nvidia/nemotron-3-super-120b-a12b",
      connectionId: connId,
      weight: 0,
    });
  }

  const comboPayload = {
    name: "rotated-cf-nvidia",
    strategy: "round-robin",
    models: modelsList,
    config: {},
  };

  const combo = await createCombo(comboPayload);
  if (!combo) {
    throw new Error("Failed to create Combo Model");
  }
  console.log(`[import] Registered Combo Model: ${combo.name} (${combo.id}) with 17 targets.`);

  // 9. Securely delete the credentials JSON file
  console.log("[import] Securely deleting data/import_credentials.json...");
  try {
    unlinkSync(credentialsPath);
    console.log("[import] Cleaned up credentials file successfully.");
  } catch (err) {
    console.error("[import] Warning: Failed to delete credentials file:", err.message);
  }

  console.log(
    "\n[import] SUCCESS: Seeded rotated-cf-nvidia combo and configured all 17 connections!"
  );
}

main().catch((e) => {
  console.error("[import] Fatal error during import:", e.stack || e.message || e);
  process.exit(1);
});
