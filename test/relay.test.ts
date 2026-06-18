import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { RelayServer } from "../src/relay/server.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { NodeHost } from "../src/node/host.js";
import { tmpDir, card, until } from "./helpers.js";

test("relay: cross-connection A→B over WebSocket", async () => {
  const dir = await tmpDir();
  const relay = new RelayServer({ port: 0, logFile: path.join(dir, "relay.log") });
  await relay.start();
  const url = `ws://127.0.0.1:${relay.port()}`;

  const A = new NodeHost({ card: card("A"), transport: new RelayWSTransport(url), dataDir: dir, heartbeatMs: 60000 });
  const B = new NodeHost({ card: card("B"), transport: new RelayWSTransport(url), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  B.onMessage((e) => {
    got.push(String(e.body));
  });
  await A.start();
  await B.start();

  await A.send([B.card.id], { subject: "ping", body: "over-the-wire" });
  await until(() => got.length === 1);
  assert.deepEqual(got, ["over-the-wire"]);

  await A.stop();
  await B.stop();
  await relay.stop();
});

test("relay: durable replay — B catches a message it missed while offline", async () => {
  const dir = await tmpDir();
  const relay = new RelayServer({ port: 0, logFile: path.join(dir, "relay.log") });
  await relay.start();
  const url = `ws://127.0.0.1:${relay.port()}`;

  const A = new NodeHost({ card: card("A"), transport: new RelayWSTransport(url), dataDir: dir, heartbeatMs: 60000 });
  await A.start();

  // B connects once (so its state dir + cursor exist), then goes offline.
  let bGot: string[] = [];
  const B1 = new NodeHost({ card: card("B"), transport: new RelayWSTransport(url), dataDir: dir, heartbeatMs: 60000 });
  B1.onMessage((e) => {
    bGot.push(String(e.body));
  });
  await B1.start();
  await until(() => A.getRoster().length >= 0); // settle
  await B1.stop();

  // A sends while B is down — it lands in the relay log only.
  await A.send([B1.card.id], { body: "while-you-were-out" });
  await new Promise((r) => setTimeout(r, 100));

  // B restarts with the SAME dataDir → resumes from its persisted cursor and replays.
  bGot = [];
  const B2 = new NodeHost({ card: card("B"), transport: new RelayWSTransport(url), dataDir: dir, heartbeatMs: 60000 });
  B2.onMessage((e) => {
    bGot.push(String(e.body));
  });
  await B2.start();
  await until(() => bGot.includes("while-you-were-out"));
  assert.ok(bGot.includes("while-you-were-out"), "missed message replayed on reconnect");

  await A.stop();
  await B2.stop();
  await relay.stop();
});
