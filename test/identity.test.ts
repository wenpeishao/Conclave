import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, signEnvelope, verifyEnvelope, canonicalJSON, agentUri } from "../src/core/identity.js";
import { makeEnvelope } from "../src/core/envelope.js";

test("identity: sign then verify round-trips", () => {
  const id = generateIdentity("coder");
  assert.equal(id.id, "agent://coder");
  const env = makeEnvelope({ from: id.id, to: ["agent://x"], body: "hello", kind: "message" });
  const signed = signEnvelope(env, id.privateKey);
  assert.ok(signed.sig, "envelope got a signature");
  assert.equal(verifyEnvelope(signed, id.publicKey), true, "valid signature verifies");
});

test("identity: tampering breaks the signature", () => {
  const id = generateIdentity("coder");
  const signed = signEnvelope(makeEnvelope({ from: id.id, to: ["agent://x"], body: "transfer 10" }), id.privateKey);

  // Tamper the body — the signature must fail.
  const tampered = { ...signed, body: "transfer 1000" };
  assert.equal(verifyEnvelope(tampered, id.publicKey), false, "modified body fails verification");

  // Tamper the sender (spoof attempt) — must fail.
  const spoofed = { ...signed, from: "agent://admin" };
  assert.equal(verifyEnvelope(spoofed, id.publicKey), false, "changed from fails verification");
});

test("identity: another agent's key cannot verify your envelope", () => {
  const alice = generateIdentity("alice");
  const mallory = generateIdentity("mallory");
  const signed = signEnvelope(makeEnvelope({ from: alice.id, to: "*", body: "hi" }), alice.privateKey);
  assert.equal(verifyEnvelope(signed, alice.publicKey), true);
  assert.equal(verifyEnvelope(signed, mallory.publicKey), false, "wrong key rejects");
});

test("identity: mallory cannot forge alice's from without alice's key", () => {
  const alice = generateIdentity("alice");
  const mallory = generateIdentity("mallory");
  // Mallory builds an envelope claiming to be alice and signs with her OWN key.
  const forged = signEnvelope(makeEnvelope({ from: alice.id, to: "*", body: "drain funds" }), mallory.privateKey);
  // Verified against alice's REGISTERED key (what the server would look up) → rejected.
  assert.equal(verifyEnvelope(forged, alice.publicKey), false, "forged from is caught");
});

test("identity: canonical JSON is key-order independent", () => {
  assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }));
  assert.equal(canonicalJSON({ a: 2, b: 1 }), '{"a":2,"b":1}');
  // Nested objects sort too.
  assert.equal(canonicalJSON({ x: { d: 1, c: 2 } }), '{"x":{"c":2,"d":1}}');
});

test("identity: signing survives a JSON round-trip with undefined-valued fields", () => {
  // Regression: a body field set to undefined (e.g. AgentCard.capabilities) must sign+verify the
  // same before and after JSON serialization (JSON drops undefined; canonicalJSON must too).
  const id = generateIdentity("box");
  const env = signEnvelope(makeEnvelope({ from: id.id, to: "*", body: { id: id.id, capabilities: undefined, status: "available" } }), id.privateKey);
  const roundTripped = JSON.parse(JSON.stringify(env)); // what the relay actually receives
  assert.equal(verifyEnvelope(roundTripped, id.publicKey), true, "verifies after the wire round-trip");
});

test("identity: unsigned envelope never verifies", () => {
  const id = generateIdentity("coder");
  const env = makeEnvelope({ from: id.id, to: "*", body: "no sig" });
  assert.equal(verifyEnvelope(env, id.publicKey), false);
  assert.equal(agentUri("coder"), "agent://coder");
  assert.equal(agentUri("agent://coder"), "agent://coder");
});
