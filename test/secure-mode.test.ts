import { test } from "node:test";
import assert from "node:assert/strict";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { generateIdentity } from "../src/core/identity.js";
import { tmpDir, until, wait } from "./helpers.js";

const CT = "connect-token";
const AT = "admin-token";

async function tasks(base: string): Promise<{ title: string }[]> {
  const r = await fetch(`${base}/tasks`, { headers: { authorization: `Bearer ${CT}` } });
  return ((await r.json()) as { tasks: { title: string }[] }).tasks;
}

test("secure mode: only enrolled+signed agents can act; forged/unsigned/revoked are rejected", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  // Admin mints an enrollment token; the device enrolls its own public key.
  const inv = (await (await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ name: "coder", role: "coder" }),
  })).json()) as { enrollToken: string };
  assert.ok(inv.enrollToken);

  const coder = generateIdentity("coder");
  const enr = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CT}` },
    body: JSON.stringify({ token: inv.enrollToken, publicKey: coder.publicKey }),
  });
  assert.equal(enr.status, 200);

  // Admin endpoint without the admin token is refused.
  assert.equal(
    (await fetch(`${base}/admin/agents`, { headers: { authorization: `Bearer ${CT}` } })).status,
    401,
    "connect token can't reach admin endpoints",
  );

  // (1) Enrolled + signing host → its task is accepted.
  const good = new NodeHost({ card: { id: "agent://coder", name: "coder" }, transport: new RelayWSTransport(wsUrl, CT), dataDir: dir, identity: coder, heartbeatMs: 60000 });
  const goodBoard = new TaskBoard(good);
  await good.start();
  await goodBoard.add("legit task");
  await until(async () => (await tasks(base)).some((t) => t.title === "legit task"), 4000);

  // (2) Unsigned host (no identity, but valid connect token) → rejected by signature gate.
  const intruder = new NodeHost({ card: { id: "agent://intruder", name: "intruder" }, transport: new RelayWSTransport(wsUrl, CT), dataDir: dir, heartbeatMs: 60000 });
  const intruderBoard = new TaskBoard(intruder);
  await intruder.start();
  await intruderBoard.add("unsigned evil task");

  // (3) Forged host: claims agent://coder but signs with a DIFFERENT key → rejected.
  const forger = generateIdentity("coder");
  const forged = new NodeHost({ card: { id: "agent://coder", name: "coder" }, transport: new RelayWSTransport(wsUrl, CT), dataDir: await tmpDir(), identity: forger, heartbeatMs: 60000 });
  const forgedBoard = new TaskBoard(forged);
  await forged.start();
  await forgedBoard.add("forged task");

  await wait(1200);
  const seen = await tasks(base);
  assert.ok(!seen.some((t) => t.title === "unsigned evil task"), "unsigned task rejected");
  assert.ok(!seen.some((t) => t.title === "forged task"), "forged-key task rejected");

  // (4) Revoke coder → even with its real key, it's locked out.
  await fetch(`${base}/admin/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ name: "coder" }),
  });
  await goodBoard.add("post-revoke task");
  await wait(1000);
  assert.ok(!(await tasks(base)).some((t) => t.title === "post-revoke task"), "revoked agent locked out");

  await good.stop();
  await intruder.stop();
  await forged.stop();
  await server.stop();
});

test("secure hardening: --admin-token requires --token; HTTP cannot launder hub-signed content", async () => {
  // Regression for the red-team CRITICAL: --admin-token alone left the WS bus open to anonymous
  // connections and let unauthenticated HTTP POSTs become hub-signed, authorized bus envelopes.
  const adminOnly = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: await tmpDir(), adminToken: AT });
  await assert.rejects(() => adminOnly.start(), /requires a connect token/);

  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: await tmpDir(), token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;

  // Unauthenticated message injection → refused (previously laundered into a hub-signed broadcast).
  const anon = await fetch(`${base}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "*", body: "forged directive" }) });
  assert.ok(anon.status === 401 || anon.status === 403, "anonymous bus injection refused");

  // A mere connect-token holder cannot mutate the board as the privileged hub.
  const ctOnly = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${CT}` }, body: JSON.stringify({ title: "forged" }) });
  assert.equal(ctOnly.status, 403, "connect-token holder cannot act as hub over HTTP");

  // The admin can (legitimate dashboard/webhook path).
  const admin = await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${AT}` }, body: JSON.stringify({ title: "legit admin task" }) });
  assert.equal(admin.status, 200);

  await server.stop();
});

test("secure mode off (no admin token) keeps legacy shared-token behavior", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  // No identity, no signing — still works (backward compatible).
  const host = new NodeHost({ card: { id: "agent://plain", name: "plain" }, transport: new RelayWSTransport(wsUrl, CT), dataDir: dir, heartbeatMs: 60000 });
  const board = new TaskBoard(host);
  await host.start();
  await board.add("plain task");
  await until(async () => (await tasks(base)).some((t) => t.title === "plain task"), 4000);

  // Admin endpoints are inert without secure mode.
  assert.equal((await fetch(`${base}/admin/agents`, { headers: { authorization: `Bearer ${CT}` } })).status, 409);

  await host.stop();
  await server.stop();
});
