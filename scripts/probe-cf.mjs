import { DatabaseSync } from "node:sqlite";
import { scryptSync, createDecipheriv } from "crypto";

const KEY = "ae37a91f780da4fafc38f32f908b12a98f234ea98e444cd05470ee9dab9dac04";
const SALT = "omniroute-field-encryption-v1";
const k = scryptSync(KEY, SALT, 32);
function decrypt(s) {
  if (!s || !s.startsWith("enc:v1:")) return s;
  const [iv, ct, tag] = s.slice(7).split(":");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  try {
    return Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString();
  } catch (e) {
    return null;
  }
}

const db = new DatabaseSync("/home/jferm/.omniroute/storage.sqlite");
const names = [
  "cloudflare-ai-1",
  "cloudflare-ai-2",
  "cloudflare-ai-4",
  "cloudflare-ai-13",
  "account-04",
  "account-09",
  "account-11",
  "account-12",
  "account-13",
];
for (const name of names) {
  const r = db
    .prepare("SELECT api_key, provider_specific_data FROM provider_connections WHERE name = ?")
    .get(name);
  if (!r) {
    console.log(name, "— missing");
    continue;
  }
  const psd = JSON.parse(r.provider_specific_data || "{}");
  const key = decrypt(r.api_key);
  const aid = psd.accountId;
  if (!aid || !key) {
    console.log(name, "— missing aid/key");
    continue;
  }
  try {
    const resp = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + aid + "/ai/run/@cf/zai-org/glm-5.2",
      {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], max_tokens: 3 }),
      }
    );
    const b = await resp.json().catch(() => ({}));
    const ok = resp.ok ? "✓ OK" : "✗ " + resp.status;
    console.log(
      `${name.padEnd(18)} acc=${aid.slice(0, 8)} key=${key.slice(0, 12)} → ${ok.padEnd(8)} ${(b.errors?.[0]?.message || "").slice(0, 60)}`
    );
  } catch (e) {
    console.log(name, "FETCH_ERR:", e.message);
  }
}
db.close();
