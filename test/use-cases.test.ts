import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { TeamWorker } from "../src/agent/team-worker.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import { echoBrain, ruleBrain } from "../src/agent/brains/rule.js";
import { uploadBlob, downloadBlob, relaySend, relayReceive } from "../src/server/blob-client.js";
import { generateIdentity, signData, type Identity } from "../src/core/identity.js";
import { tmpDir, until, wait } from "./helpers.js";

// End-to-end use cases driven over the SECURE bus (per-agent signed identities + zones), the
// mode the other suites don't cover. Lifted from a parallel use-case dogfooding battery.
const CT = "connect-token";
const AT = "admin-token";

async function enroll(base: string, name: string, role?: string, zones?: string[]): Promise<Identity> {
  const inv = (await (await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ name, role, zones }),
  })).json()) as { enrollToken: string };
  const id = generateIdentity(name);
  await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CT}` },
    body: JSON.stringify({ token: inv.enrollToken, publicKey: id.publicKey, proof: signData(id.privateKey, inv.enrollToken) }),
  });
  return id;
}

async function secureServer() {
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: await tmpDir(), token: CT, adminToken: AT });
  await server.start();
  return { server, base: `http://127.0.0.1:${server.httpPort()}`, wsUrl: `ws://127.0.0.1:${server.wsPort()}` };
}

async function mkHost(wsUrl: string, id: Identity, zone?: string): Promise<NodeHost> {
  return new NodeHost({ card: { id: id.id, name: id.name }, transport: new RelayWSTransport(wsUrl, CT, id), dataDir: await tmpDir(), identity: id, zone, heartbeatMs: 60000 });
}

test("use case: cross-zone discovery query + P2P reply (find-each-other)", async () => {
  const { server, base, wsUrl } = await secureServer();
  const [aId, bId, cId] = [await enroll(base, "alpha", undefined, ["s-1"]), await enroll(base, "bravo", undefined, ["s-2"]), await enroll(base, "charlie", undefined, ["s-3"])];
  const A = await mkHost(wsUrl, aId, "s-1");
  const B = await mkHost(wsUrl, bId, "s-2");
  const C = await mkHost(wsUrl, cId, "s-3");

  const aGot: string[] = [];
  const cGot: string[] = [];
  B.subscribe("topic://discovery");
  C.subscribe("topic://discovery");
  A.onMessage((e) => {
    if (e.subject === "discovery-reply") aGot.push(e.from);
  });
  C.onMessage((e) => {
    cGot.push(String(e.subject));
  });
  // B answers a discovery query with a P2P reply to the asker.
  B.onMessage(async (e) => {
    if (e.subject === "discovery-query") await B.send([e.from], { subject: "discovery-reply", body: "i can search" });
  });
  await A.start();
  await B.start();
  await C.start();
  await wait(400);

  // A broadcasts a global discovery query; B (other zone) replies P2P.
  await A.send(["topic://discovery"], { subject: "discovery-query", body: "who-can-search" });
  await until(() => aGot.includes(bId.id), 4000);
  assert.ok(aGot.includes(bId.id), "asker got B's cross-zone P2P reply");
  assert.ok(cGot.includes("discovery-query"), "discovery is global — C saw the query");
  assert.ok(!aGot.includes(cId.id), "C did not send a P2P reply");
  // Global presence: A sees B across zones.
  assert.ok(A.getRoster().some((r) => r.id === bId.id), "global roster shows a different-zone agent");

  await A.stop();
  await B.stop();
  await C.stop();
  await server.stop();
});

test("use case: data exchange over the secure server (blob store + streaming relay + token gate)", async () => {
  const { server, base } = await secureServer();
  const blobsDir = path.join((server as unknown as { dataDir: string }).dataDir ?? "", "");

  // Blob store round-trip (content-addressed) with the connect token.
  const payload = randomBytes(48 * 1024);
  const sha = createHash("sha256").update(payload).digest("hex");
  const ref = await uploadBlob(base, payload, CT);
  assert.equal(ref.sha256, sha);
  const got = await downloadBlob(base, ref.uri, CT);
  assert.ok(Buffer.from(got).equals(payload), "blob round-trips byte-identical");

  // Streaming relay transits without storing.
  const channel = `chan-${Date.now()}`;
  const recvP = relayReceive(base, channel, CT);
  await wait(50);
  const relayPayload = randomBytes(32 * 1024);
  await relaySend(base, channel, relayPayload, CT);
  assert.ok(Buffer.from(await recvP).equals(relayPayload), "relay delivers exactly the payload");

  // Token gating: no token → 401.
  assert.equal((await fetch(`${base}/blobs/${sha}`)).status, 401, "blob fetch needs the connect token");
  await assert.rejects(() => uploadBlob(base, "x", undefined), /401/);
  void blobsDir;
  await server.stop();
});

test("use case: secure zoned role-handoff pipeline (coder → deploy)", async () => {
  const { server, base, wsUrl } = await secureServer();
  const coderId = await enroll(base, "coder", "coder", ["s-x"]);
  const deployId = await enroll(base, "deployer", "deploy", ["s-x"]);
  const leadId = await enroll(base, "lead", "lead", ["s-x"]);

  const hCoder = await mkHost(wsUrl, coderId, "s-x");
  const hDeploy = await mkHost(wsUrl, deployId, "s-x");
  const hLead = await mkHost(wsUrl, leadId, "s-x");
  const bLead = new TaskBoard(hLead);
  const coder = new TeamWorker(hCoder, new TaskBoard(hCoder), echoBrain("CODE: "), { pollMs: 40, settleMs: 60, role: "coder", handoffTo: "deploy" });
  const deployer = new TeamWorker(hDeploy, new TaskBoard(hDeploy), echoBrain("DEPLOYED: "), { pollMs: 40, settleMs: 60, role: "deploy" });

  await coder.start();
  await deployer.start();
  await hLead.start();
  await wait(300);
  await bLead.add("ship the login page", { for: "coder" });

  // Pipeline completes when BOTH a coder task and a handoff deploy task are done.
  await until(() => {
    const ts = bLead.list();
    return ts.some((t) => t.for === "coder" && t.status === "done") && ts.some((t) => t.for === "deploy" && t.status === "done");
  }, 10000);
  const ts = bLead.list();
  assert.equal(ts.find((t) => t.for === "coder")?.claimedBy, "agent://coder", "coder claimed stage 1");
  assert.equal(ts.find((t) => t.for === "deploy")?.claimedBy, "agent://deployer", "deployer claimed the handoff");
  assert.equal(ts.length, 2, "exactly two tasks — no double-work");

  await coder.stop();
  await deployer.stop();
  await hLead.stop();
  await server.stop();
});

test("use case: heterogeneous brains answer on one secure bus", async () => {
  const { server, base, wsUrl } = await secureServer();
  const echoId = await enroll(base, "echoA");
  const ruleId = await enroll(base, "ruleB");
  const userId = await enroll(base, "user");

  const echoAgent = new AutonomousAgent(await mkHost(wsUrl, echoId), echoBrain());
  const ruleAgent = new AutonomousAgent(await mkHost(wsUrl, ruleId), ruleBrain([{ when: (e) => e.kind === "request", reply: (e) => `UPPER: ${String(e.body).toUpperCase()}` }]));
  const userHost = await mkHost(wsUrl, userId);
  const got: { from: string; body: string }[] = [];
  userHost.onMessage((e) => {
    got.push({ from: e.from, body: String(e.body) });
  });

  await echoAgent.start();
  await ruleAgent.start();
  await userHost.start();
  await wait(500);

  await userHost.send([echoId.id], { kind: "request", body: "hello-secure" });
  await userHost.send([ruleId.id], { kind: "request", body: "make me loud" });
  await until(() => got.length >= 2, 6000);
  assert.equal(got.find((g) => g.from === echoId.id)?.body, "echo: hello-secure", "echo brain replied");
  assert.equal(got.find((g) => g.from === ruleId.id)?.body, "UPPER: MAKE ME LOUD", "the other brain replied");
  assert.equal(got.length, 2, "two directed replies, no cross-talk");

  await echoAgent.stop();
  await ruleAgent.stop();
  await userHost.stop();
  await server.stop();
});
