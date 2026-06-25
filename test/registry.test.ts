import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/server/registry.js";
import { generateIdentity, signEnvelope, signData } from "../src/core/identity.js";
import { makeEnvelope } from "../src/core/envelope.js";
import { tmpDir } from "./helpers.js";

// Enrollment now requires proof-of-possession: a signature over the token by the new key.
const pop = (privateKey: string, token: string) => signData(privateKey, token);

test("registry: invite -> enroll -> authorize signed envelope", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();

  const inv = reg.invite({ name: "coder", role: "coder", canRun: false });
  assert.ok(inv.token);
  assert.equal(reg.active, true);

  // Device generates its own keypair, enrolls its public key.
  const id = generateIdentity("coder");
  const rec = reg.enroll(inv.token, id.publicKey, pop(id.privateKey, inv.token));
  assert.equal(rec.id, "agent://coder");
  assert.equal(rec.role, "coder");

  // A properly signed envelope from coder is authorized.
  const env = signEnvelope(makeEnvelope({ from: "agent://coder", to: "*", body: "hi" }), id.privateKey);
  assert.equal(reg.authorize(env).ok, true);
});

test("registry: forgery, revocation, and unsigned are all rejected", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();
  const coder = generateIdentity("coder");
  const mallory = generateIdentity("mallory");
  const ct = reg.invite({ name: "coder" }).token;
  reg.enroll(ct, coder.publicKey, pop(coder.privateKey, ct));

  // Forged: Mallory signs an envelope claiming to be coder.
  const forged = signEnvelope(makeEnvelope({ from: "agent://coder", to: "*", body: "evil" }), mallory.privateKey);
  assert.equal(reg.authorize(forged).ok, false, "forged sender rejected");

  // Unknown agent.
  const unknown = signEnvelope(makeEnvelope({ from: "agent://ghost", to: "*" }), mallory.privateKey);
  assert.equal(reg.authorize(unknown).ok, false, "unknown agent rejected");

  // Unsigned.
  const unsigned = makeEnvelope({ from: "agent://coder", to: "*" });
  assert.equal(reg.authorize(unsigned).ok, false, "unsigned rejected");

  // Valid until revoked, then locked out even with the right key.
  const good = signEnvelope(makeEnvelope({ from: "agent://coder", to: "*" }), coder.privateKey);
  assert.equal(reg.authorize(good).ok, true);
  assert.equal(reg.revoke("coder"), true);
  const after = signEnvelope(makeEnvelope({ from: "agent://coder", to: "*" }), coder.privateKey);
  assert.equal(reg.authorize(after).ok, false, "revoked agent locked out despite valid key");
});

test("registry: enrollment tokens are one-time and expiring", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();
  const id = generateIdentity("box");

  // Expired token rejected.
  const expired = reg.invite({ name: "box", ttlMs: -1 });
  assert.throws(() => reg.enroll(expired.token, id.publicKey), /expired/);

  // Fresh token works once, then is consumed.
  const inv = reg.invite({ name: "box" });
  reg.enroll(inv.token, id.publicKey, pop(id.privateKey, inv.token));
  assert.throws(() => reg.enroll(inv.token, id.publicKey, pop(id.privateKey, inv.token)), /invalid or already-used/);
});

test("registry: enroll requires proof-of-possession and a valid key", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();
  const id = generateIdentity("dev");
  const other = generateIdentity("other");

  const inv = reg.invite({ name: "dev" });
  // No proof → rejected.
  assert.throws(() => reg.enroll(inv.token, id.publicKey), /proof-of-possession/);
  // Proof signed by a DIFFERENT key (attacker enrolling a key they don't control) → rejected.
  assert.throws(() => reg.enroll(inv.token, id.publicKey, pop(other.privateKey, inv.token)), /proof-of-possession/);
  // Garbage key → rejected.
  assert.throws(() => reg.enroll(inv.token, "not-a-key", pop(id.privateKey, inv.token)), /valid ed25519/);
  // Correct proof → ok.
  assert.ok(reg.enroll(inv.token, id.publicKey, pop(id.privateKey, inv.token)));
});

test("registry: revoke burns pending tokens so a leaked one can't resurrect the name", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();
  const coder = generateIdentity("coder");
  const attacker = generateIdentity("coder");

  // Two tokens minted before enrollment (a duplicate / leaked invite).
  const t1 = reg.invite({ name: "coder" }).token;
  const t2 = reg.invite({ name: "coder" }).token;
  reg.enroll(t1, coder.publicKey, pop(coder.privateKey, t1)); // coder enrolled; t2 still pending
  assert.equal(reg.revoke("coder"), true); // revocation must also burn t2

  // The still-pending leaked token can no longer resurrect the revoked name onto a new key.
  assert.throws(() => reg.enroll(t2, attacker.publicKey, pop(attacker.privateKey, t2)), /invalid or already-used/);
});

test("registry: a pinned invite only accepts the pinned key (defeats token interception)", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();
  const device = generateIdentity("dev"); // the intended device pre-generates its key
  const attacker = generateIdentity("dev"); // an interceptor with their own key

  const inv = reg.invite({ name: "dev", pin: device.publicKey });
  // The interceptor holds the token + a valid proof for THEIR key, but it isn't the pinned key.
  assert.throws(() => reg.enroll(inv.token, attacker.publicKey, pop(attacker.privateKey, inv.token)), /pinned device key/);
  // Only the pinned device can enroll.
  assert.ok(reg.enroll(inv.token, device.publicKey, pop(device.privateKey, inv.token)));
});

test("registry: persists across reload", async () => {
  const dir = await tmpDir();
  const reg1 = new AgentRegistry(dir);
  await reg1.load();
  const id = generateIdentity("home-gpu");
  const hgt = reg1.invite({ name: "home-gpu", role: "deploy", canRun: true }).token;
  reg1.enroll(hgt, id.publicKey, pop(id.privateKey, hgt));
  await new Promise((r) => setTimeout(r, 50)); // let the async save flush

  const reg2 = new AgentRegistry(dir);
  await reg2.load();
  const rec = reg2.get("agent://home-gpu");
  assert.equal(rec?.canRun, true);
  assert.equal(rec?.role, "deploy");
});
