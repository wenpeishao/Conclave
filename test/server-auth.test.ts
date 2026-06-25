import { test } from "node:test";
import assert from "node:assert/strict";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { uploadBlob } from "../src/server/blob-client.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { tmpDir, card, until, wait } from "./helpers.js";

const TOKEN = "s3cr3t-shared-token";

test("server-auth: HTTP rejects without the token, accepts with it", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: TOKEN });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;

  // No token → 401 on every protected endpoint.
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/tasks`)).status, 401);
  assert.equal(
    (await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    401,
  );

  // With the token (Bearer) → works.
  const ok = await fetch(`${base}/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);

  // Blob client with the token round-trips.
  const ref = await uploadBlob(base, "secret-bytes", TOKEN);
  assert.ok(ref.sha256);
  // Wrong token → 401.
  assert.equal((await fetch(`${base}/blobs`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "x" })).status, 401);

  await server.stop();
});

test("server-auth: WS bus refuses agents without the token, admits them with it", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: TOKEN });
  await server.start();
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  // Post a task via the (authenticated) HTTP API so there's board state to observe.
  const created = (await (await fetch(`http://127.0.0.1:${server.httpPort()}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ title: "secret task" }),
  })).json()) as { id: string };

  // Agent WITHOUT the token: connection is closed by the relay, so it never receives the task.
  const badHost = new NodeHost({ card: card("intruder"), transport: new RelayWSTransport(wsUrl), dataDir: dir, heartbeatMs: 60000 });
  const badBoard = new TaskBoard(badHost);
  await badHost.start();
  await wait(800);
  assert.equal(badBoard.list().length, 0, "unauthenticated agent sees nothing");
  await badHost.stop();

  // Agent WITH the token: admitted, sees the board.
  const goodHost = new NodeHost({ card: card("member"), transport: new RelayWSTransport(wsUrl, TOKEN), dataDir: dir, heartbeatMs: 60000 });
  const goodBoard = new TaskBoard(goodHost);
  await goodHost.start();
  await until(() => goodBoard.list().some((t) => t.id === created.id), 4000);
  assert.ok(goodBoard.list().some((t) => t.id === created.id), "authenticated agent sees the task");

  await goodHost.stop();
  await server.stop();
});
