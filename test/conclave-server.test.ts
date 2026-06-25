import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { promises as fs } from "node:fs";
import { uploadBlob, downloadBlob, relaySend, relayReceive } from "../src/server/blob-client.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { tmpDir, card, until } from "./helpers.js";

test("ConclaveServer: HTTP tasks API is consistent with a WS agent's board", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir });
  await server.start();
  const httpBase = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  // A real agent on the WS bus with its own TaskBoard.
  const agentHost = new NodeHost({ card: card("worker"), transport: new RelayWSTransport(wsUrl), dataDir: dir, heartbeatMs: 60000 });
  const agentBoard = new TaskBoard(agentHost);
  await agentHost.start();

  // Post a task via HTTP — the WS agent should see it on its board.
  const created = (await (await fetch(`${httpBase}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "ship the docs", for: "writer" }),
  })).json()) as { id: string };
  assert.ok(created.id);

  await until(() => agentBoard.list().some((t) => t.id === created.id), 4000);
  const t = agentBoard.list().find((x) => x.id === created.id);
  assert.equal(t?.title, "ship the docs");
  assert.equal(t?.for, "writer");

  // The agent claims+finishes over the bus — the server's HTTP view reflects it.
  await agentBoard.claim(created.id);
  await agentBoard.done(created.id, "done by worker");
  await until(async () => {
    const tasks = ((await (await fetch(`${httpBase}/tasks`)).json()) as { tasks: { id: string; status: string }[] }).tasks;
    return tasks.find((x) => x.id === created.id)?.status === "done";
  }, 4000);
  const viaHttp = ((await (await fetch(`${httpBase}/tasks`)).json()) as { tasks: { id: string; status: string; claimedBy?: string; result?: string }[] }).tasks;
  const done = viaHttp.find((x) => x.id === created.id);
  assert.equal(done?.status, "done");
  assert.equal(done?.claimedBy, "agent://worker");
  assert.equal(done?.result, "done by worker");

  await agentHost.stop();
  await server.stop();
});

test("ConclaveServer: blob data-exchange round-trips with sha256 integrity", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir });
  await server.start();
  const httpBase = `http://127.0.0.1:${server.httpPort()}`;

  const payload = "checkpoint-bytes-".repeat(1000); // ~17KB stand-in for a big artifact
  const ref = await uploadBlob(httpBase, payload);
  assert.equal(ref.sha256, createHash("sha256").update(payload).digest("hex"), "content-addressed by sha256");
  assert.equal(ref.uri, `conclave://blobs/${ref.sha256}`);

  const got = await downloadBlob(httpBase, ref.uri); // fetch by the conclave:// uri
  assert.equal(new TextDecoder().decode(got), payload, "downloaded bytes match the upload");

  assert.equal((await (await fetch(`${httpBase}/blobs/${"0".repeat(64)}`)).status), 404, "missing blob 404s");

  await server.stop();
});

test("ConclaveServer: streaming relay transits bytes WITHOUT storing them", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;

  const payload = "stream-this-through-".repeat(2000); // ~40KB

  // Receiver arrives first and waits; sender connects; bytes pipe straight through.
  const recvP = relayReceive(base, "chan-A");
  await new Promise((r) => setTimeout(r, 50));
  await relaySend(base, "chan-A", payload);
  const got = new TextDecoder().decode(await recvP);
  assert.equal(got, payload, "receiver got exactly what the sender streamed");

  // Order-independent: sender can arrive first too.
  const sendP = relaySend(base, "chan-B", payload);
  await new Promise((r) => setTimeout(r, 50));
  const got2 = new TextDecoder().decode(await relayReceive(base, "chan-B"));
  await sendP;
  assert.equal(got2, payload);

  // The crux: NOTHING was written to the server's blob store (disk stays empty).
  const blobsDir = path.join(dir, "blobs");
  const stored = await fs.readdir(blobsDir).catch(() => []);
  assert.equal(stored.length, 0, "relay left nothing on disk");

  await server.stop();
});

test("ConclaveServer: conversation history + HTTP message injection", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir });
  await server.start();
  const httpBase = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const agentHost = new NodeHost({ card: card("listener"), transport: new RelayWSTransport(wsUrl), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  agentHost.onMessage((e) => {
    if (e.kind === "message") got.push(String(e.body));
  });
  await agentHost.start();

  // Inject a message via HTTP -> a WS agent receives it, and it shows in history.
  await fetch(`${httpBase}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "listener", subject: "hi", body: "from the http api" }),
  });
  await until(() => got.includes("from the http api"), 4000);

  const hist = ((await (await fetch(`${httpBase}/messages`)).json()) as { messages: { body?: unknown }[] }).messages;
  assert.ok(hist.some((m) => m.body === "from the http api"), "message appears in history");

  await agentHost.stop();
  await server.stop();
});
