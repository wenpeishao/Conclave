import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/server/registry.js";
import { generateIdentity, signEnvelope } from "../src/core/identity.js";
import { makeEnvelope } from "../src/core/envelope.js";
import { tmpDir } from "./helpers.js";

test("registry: invite -> enroll -> authorize signed envelope", async () => {
  const reg = new AgentRegistry(await tmpDir());
  await reg.load();

  const inv = reg.invite({ name: "coder", role: "coder", canRun: false });
  assert.ok(inv.token);
  assert.equal(reg.active, true);

  // Device generates its own keypair, enrolls its public key.
  const id = generateIdentity("coder");
  const rec = reg.enroll(inv.token, id.publicKey);
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
  reg.enroll(reg.invite({ name: "coder" }).token, coder.publicKey);

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
  reg.enroll(inv.token, id.publicKey);
  assert.throws(() => reg.enroll(inv.token, id.publicKey), /invalid or already-used/);
});

test("registry: persists across reload", async () => {
  const dir = await tmpDir();
  const reg1 = new AgentRegistry(dir);
  await reg1.load();
  const id = generateIdentity("home-gpu");
  reg1.enroll(reg1.invite({ name: "home-gpu", role: "deploy", canRun: true }).token, id.publicKey);
  await new Promise((r) => setTimeout(r, 50)); // let the async save flush

  const reg2 = new AgentRegistry(dir);
  await reg2.load();
  const rec = reg2.get("agent://home-gpu");
  assert.equal(rec?.canRun, true);
  assert.equal(rec?.role, "deploy");
});
