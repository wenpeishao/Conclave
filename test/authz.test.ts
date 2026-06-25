import { test } from "node:test";
import assert from "node:assert/strict";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { generateIdentity, signData, signEnvelope, type Identity } from "../src/core/identity.js";
import { makeEnvelope } from "../src/core/envelope.js";
import { ulid } from "../src/core/ulid.js";
import { tmpDir, until, wait } from "./helpers.js";

const CT = "connect-token";
const AT = "admin-token";

async function enrollRole(base: string, name: string, role: string): Promise<Identity> {
  const inv = (await (await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ name, role }),
  })).json()) as { enrollToken: string };
  const id = generateIdentity(name);
  await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CT}` },
    body: JSON.stringify({ token: inv.enrollToken, publicKey: id.publicKey, proof: signData(id.privateKey, inv.enrollToken) }),
  });
  return id;
}

async function taskById(base: string, id: string) {
  const tasks = ((await (await fetch(`${base}/tasks`, { headers: { authorization: `Bearer ${CT}` } })).json()) as { tasks: { id: string; status: string; claimedBy?: string }[] }).tasks;
  return tasks.find((t) => t.id === id);
}

test("authz: a wrong-role agent cannot claim a role-tagged task; the right role can", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const deployer = await enrollRole(base, "deployer", "deploy");
  const reviewer = await enrollRole(base, "reviewer", "reviewer");

  const mk = async (id: Identity) => {
    const host = new NodeHost({ card: { id: id.id, name: id.name }, transport: new RelayWSTransport(wsUrl, CT, id), dataDir: await tmpDir(), identity: id, heartbeatMs: 60000 });
    const board = new TaskBoard(host);
    await host.start();
    return { host, board };
  };
  const dep = await mk(deployer);
  const rev = await mk(reviewer);

  // Admin posts a deploy-only task.
  const created = (await (await fetch(`${base}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ title: "deploy prod", for: "deploy" }),
  })).json()) as { id: string };
  await until(async () => (await taskById(base, created.id)) !== undefined, 4000);

  // The reviewer (wrong role) tries to claim it — the relay must reject the claim.
  await rev.board.claim(created.id);
  await wait(800);
  let t = await taskById(base, created.id);
  assert.equal(t?.status, "open", "reviewer's claim was rejected — task still open");
  assert.notEqual(t?.claimedBy, "agent://reviewer", "reviewer is not recorded as claimer");

  // The deployer (right role) claims it — accepted.
  await dep.board.claim(created.id);
  await until(async () => (await taskById(base, created.id))?.status === "claimed", 4000);
  t = await taskById(base, created.id);
  assert.equal(t?.claimedBy, "agent://deployer", "deployer claim accepted");

  await dep.host.stop();
  await rev.host.stop();
  await server.stop();
});

test("authz: a forged minimal-ULID claim cannot hijack ownership (first-claim-wins)", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const aliceId = await enrollRole(base, "alice", "worker");
  const malloryId = await enrollRole(base, "mallory", "worker"); // same role → in-scope attacker

  const alice = new NodeHost({ card: { id: aliceId.id, name: "alice" }, transport: new RelayWSTransport(wsUrl, CT, aliceId), dataDir: await tmpDir(), identity: aliceId, heartbeatMs: 60000 });
  const aliceBoard = new TaskBoard(alice);
  await alice.start();

  const created = (await (await fetch(`${base}/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${AT}` }, body: JSON.stringify({ title: "run job", for: "worker" }) })).json()) as { id: string };
  await until(async () => (await taskById(base, created.id)) !== undefined, 4000);

  // Alice legitimately claims it.
  await aliceBoard.claim(created.id);
  await until(async () => (await taskById(base, created.id))?.claimedBy === "agent://alice", 4000);

  // Mallory (same role) forges a claim with a minimal ULID (fresh time, all-zero random suffix)
  // that would win the old min-ULID tie-break, and publishes it on a raw authenticated socket.
  const mt = new RelayWSTransport(wsUrl, CT, malloryId);
  mt.onEnvelope(() => {});
  await mt.start(null);
  await wait(300); // let the challenge-response bind the connection
  const forge = (op: "claim" | "done", result?: string) => {
    let e = makeEnvelope({ from: malloryId.id, to: ["topic://tasks"], kind: "event", subject: "task", body: result !== undefined ? { op, id: created.id, result } : { op, id: created.id } });
    e = { ...e, id: ulid(Date.now()).slice(0, 10) + "0".repeat(16) }; // fresh time prefix, minimal suffix
    return signEnvelope(e, malloryId.privateKey);
  };
  await mt.publish(forge("claim"));
  await mt.publish(forge("done", "ATTACKER-CONTROLLED OUTPUT"));
  await wait(900);

  // Ownership and result are unchanged — the forged claim/done were rejected server-side.
  const t = await taskById(base, created.id);
  assert.equal(t?.claimedBy, "agent://alice", "forged minimal-ULID claim did NOT hijack ownership");
  assert.notEqual((t as { result?: string })?.result, "ATTACKER-CONTROLLED OUTPUT", "forged done was rejected");

  await mt.stop();
  await alice.stop();
  await server.stop();
});
