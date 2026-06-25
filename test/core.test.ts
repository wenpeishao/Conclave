import { test } from "node:test";
import assert from "node:assert/strict";
import { ulid, decodeUlidTime } from "../src/core/ulid.js";
import { makeEnvelope, validateEnvelope, deliverableTo } from "../src/core/envelope.js";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { tmpDir, card, until } from "./helpers.js";

test("ulid: 26 chars, monotonic, lexicographically time-sortable", () => {
  const a = ulid(1000);
  const b = ulid(1000); // same ms → monotonic increment
  const c = ulid(2000);
  assert.equal(a.length, 26);
  assert.ok(a < b, "same-ms ulids increase");
  assert.ok(b < c, "later-ms ulid sorts after");
});

test("ulid: decodeUlidTime recovers the timestamp and rejects forgeries", () => {
  // The relay binds env.id's embedded time to the freshness window; a forged tiny id decodes
  // to a far-past time and is rejected, defeating the min-ULID board-claim hijack.
  assert.equal(decodeUlidTime(ulid(1700000000000)), 1700000000000);
  assert.equal(decodeUlidTime("0".repeat(26)), 0, "forged all-zero ULID decodes to epoch 0 (far past → relay rejects)");
  assert.ok(Number.isNaN(decodeUlidTime("not-a-ulid")), "wrong length → NaN (relay rejects)");
  assert.ok(Number.isNaN(decodeUlidTime("0".repeat(24) + "IL")), "out-of-alphabet chars → NaN");
});

test("envelope: make + validate + addressing", () => {
  const e = makeEnvelope({ from: "agent://A", to: ["agent://B"], subject: "hi", body: 1 });
  assert.deepEqual(validateEnvelope(e), []);
  assert.equal(e.v, "1");
  assert.equal(e.kind, "message");
  assert.ok(deliverableTo(e, "agent://B", new Set()));
  assert.ok(!deliverableTo(e, "agent://C", new Set()));

  const bcast = makeEnvelope({ from: "agent://A", to: "*", kind: "event" });
  assert.ok(deliverableTo(bcast, "agent://anyone", new Set()));

  const topic = makeEnvelope({ from: "agent://A", to: ["topic://builds"], kind: "event" });
  assert.ok(deliverableTo(topic, "agent://B", new Set(["topic://builds"])));
  assert.ok(!deliverableTo(topic, "agent://B", new Set()));

  assert.deepEqual(validateEnvelope({ from: "x" }).length > 0, true);
});

test("memory transport: A→B delivery", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();
  const A = new NodeHost({ card: card("A"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const B = new NodeHost({ card: card("B"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  B.onMessage((e) => {
    got.push(String(e.body));
  });
  await A.start();
  await B.start();
  await A.send([B.card.id], { subject: "hi", body: "hello-1" });
  await until(() => got.length === 1);
  assert.deepEqual(got, ["hello-1"]);
  await A.stop();
  await B.stop();
});

test("dedup: a redelivered envelope is handled once", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();
  const A = new NodeHost({ card: card("A"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const B = new NodeHost({ card: card("B"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  let count = 0;
  B.onMessage(() => {
    count++;
  });
  await A.start();
  await B.start();
  const env = await A.send([B.card.id], { body: "once" });
  // Simulate a duplicate redelivery from the transport.
  await hub.connect().publish(env);
  await until(() => count >= 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count, 1, "duplicate ULID delivered only once");
  await A.stop();
  await B.stop();
});

test("roster: B appears in A's roster after a heartbeat", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();
  const A = new NodeHost({ card: card("A"), transport: hub.connect(), dataDir: dir, heartbeatMs: 50 });
  const B = new NodeHost({ card: card("B"), transport: hub.connect(), dataDir: dir, heartbeatMs: 50 });
  await A.start();
  await B.start();
  await until(() => A.getRoster().some((r) => r.id === "agent://B" && r.online));
  assert.ok(A.getRoster().some((r) => r.id === "agent://B"));
  await A.stop();
  await B.stop();
});
