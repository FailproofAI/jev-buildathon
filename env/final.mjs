// The sealed final round.
//
// Each agent ships `final.enc`: new tasks and the world data they need,
// encrypted with a passphrase the organisers announce near the end of the
// event. `buildathon unlock <passphrase>` writes `final.json` next to it, and
// the agent's world merges that file in. `final.json` is part of the agent's
// fingerprint, so a changed final world is visible in every tool result.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAGIC = "jevfinal1";

export function seal(plaintext, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [MAGIC, salt.toString("base64"), iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function unseal(sealed, passphrase) {
  const [magic, salt, iv, tag, body] = sealed.trim().split(".");
  if (magic !== MAGIC) throw new Error("not a sealed final-round file");
  const key = scryptSync(passphrase, Buffer.from(salt, "base64"), 32);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

/** The unlocked final round for an agent folder, or null before unlock. */
export function finalRound(agentDir) {
  const p = join(agentDir, "final.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

/** Merge a final round's world additions into a freshly built world. Arrays
 *  are appended to; objects are shallow-merged; `patch` edits records by id. */
export function withFinal(world, agentDir) {
  return withFinalData(world, finalRound(agentDir));
}

export function withFinalData(world, f) {
  if (!f?.world) return world;
  for (const [k, v] of Object.entries(f.world)) {
    if (k === "patch") continue;
    if (Array.isArray(world[k])) world[k] = [...world[k], ...v];
    else if (world[k] && typeof world[k] === "object") world[k] = { ...world[k], ...v };
    else world[k] = v;
  }
  for (const p of f.world.patch ?? []) {
    const rec = (world[p.collection] ?? []).find((x) => x.id === p.id || x.name === p.id);
    if (rec) Object.assign(rec, p.set);
  }
  return world;
}
