import { test } from "node:test";
import assert from "node:assert/strict";
import { ConclaveServer } from "../src/server/conclave-server.js";
import { NodeHost } from "../src/node/host.js";
import { RelayWSTransport } from "../src/transports/relay-ws.js";
import { generateIdentity, signData, type Identity } from "../src/core/identity.js";
import { tmpDir, wait, until } from "./helpers.js";

const CT = "connect-token";
const AT = "admin-token";

async function enroll(base: string, name: string, zones: string[]): Promise<Identity> {
  const inv = (await (await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${AT}` },
    body: JSON.stringify({ name, zones }),
  })).json()) as { enrollToken: string };
  const id = generateIdentity(name);
  await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CT}` },
    body: JSON.stringify({ token: inv.enrollToken, publicKey: id.publicKey, proof: signData(id.privateKey, inv.enrollToken) }),
  });
  return id;
}

test("zones: zone-broadcast reaches same-zone members only; P2P crosses zones", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const aliceId = await enroll(base, "alice", ["s-A"]);
  const bobId = await enroll(base, "bob", ["s-A"]);
  const carolId = await enroll(base, "carol", ["s-B"]);

  const mkHost = async (id: Identity, zone: string) => {
    const host = new NodeHost({
      card: { id: id.id, name: id.name },
      transport: new RelayWSTransport(wsUrl, CT, id), // identity → connection authenticates → routed
      dataDir: await tmpDir(),
      identity: id,
      zone,
      heartbeatMs: 60000,
    });
    return host;
  };

  const alice = await mkHost(aliceId, "s-A");
  const bob = await mkHost(bobId, "s-A");
  const carol = await mkHost(carolId, "s-B");

  const bobGot: unknown[] = [];
  const carolGot: unknown[] = [];
  bob.subscribe("topic://room");
  carol.subscribe("topic://room");
  bob.onMessage((e) => {
    bobGot.push(e.body);
  });
  carol.onMessage((e) => {
    carolGot.push(e.body);
  });

  await alice.start();
  await bob.start();
  await carol.start();
  await wait(400);

  // Zone broadcast from alice (zone s-A) → only same-zone bob gets it; cross-zone carol does not.
  await alice.send(["topic://room"], { body: "hello zone A" });
  await wait(700);
  assert.ok(bobGot.includes("hello zone A"), "same-zone peer receives the zone broadcast");
  assert.ok(!carolGot.includes("hello zone A"), "other-zone peer does NOT receive it (isolation)");

  // Point-to-point crosses zones (explicit addressing).
  await alice.send([carolId.id], { body: "direct to carol" });
  await wait(700);
  assert.ok(carolGot.includes("direct to carol"), "P2P delivered across zones");
  assert.ok(!bobGot.includes("direct to carol"), "P2P not delivered to a non-recipient");

  // The hub is a wildcard receiver → its roster sees every agent regardless of zone.
  const roster = (await (await fetch(`${base}/`, { headers: { authorization: `Bearer ${CT}` } })).json()) as { roster: { id: string }[] };
  const ids = roster.roster.map((r) => r.id);
  for (const want of ["agent://alice", "agent://bob", "agent://carol"]) assert.ok(ids.includes(want), `hub roster has ${want}`);

  await alice.stop();
  await bob.stop();
  await carol.stop();
  await server.stop();
});

test("zones: discovery plane is global — presence (capabilities + availability) crosses zones", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const gpuId = await enroll(base, "gpu", ["s-resource"]);
  const labId = await enroll(base, "lab", ["s-lab"]);

  // The resource agent advertises its capabilities; it lives in a different zone than lab.
  const gpu = new NodeHost({ card: { id: gpuId.id, name: "gpu", capabilities: ["gpu:rtx5090-32gb"], status: "available" }, transport: new RelayWSTransport(wsUrl, CT, gpuId), dataDir: await tmpDir(), identity: gpuId, zone: "s-resource", heartbeatMs: 60000 });
  const lab = new NodeHost({ card: { id: labId.id, name: "lab" }, transport: new RelayWSTransport(wsUrl, CT, labId), dataDir: await tmpDir(), identity: labId, zone: "s-lab", heartbeatMs: 60000 });
  await gpu.start();
  await lab.start();
  await wait(700);

  // lab (zone s-lab) can SEE the resource agent in zone s-resource — who is online, what it
  // has, and whether it is available — even though their WORK chatter is isolated.
  const seen = lab.getRoster().find((x) => x.id === "agent://gpu");
  assert.ok(seen, "input zone sees the resource agent across zones (global discovery)");
  assert.deepEqual(seen?.capabilities, ["gpu:rtx5090-32gb"], "capabilities are advertised");
  assert.equal(seen?.status, "available", "availability is visible");

  // Availability updates propagate globally.
  gpu.setStatus("busy");
  await wait(500);
  assert.equal(lab.getRoster().find((x) => x.id === "agent://gpu")?.status, "busy", "busy status reaches other zones");

  await gpu.stop();
  await lab.stop();
  await server.stop();
});

test("zones: a late-joining same-zone member receives prior zone history via replay", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const aliceId = await enroll(base, "alice", ["s-A"]);
  const bobId = await enroll(base, "bob", ["s-A"]);

  // Alice posts a zone-stamped message, then disconnects.
  const alice = new NodeHost({ card: { id: aliceId.id, name: "alice" }, transport: new RelayWSTransport(wsUrl, CT, aliceId), dataDir: await tmpDir(), identity: aliceId, zone: "s-A", heartbeatMs: 60000 });
  await alice.start();
  await wait(300);
  await alice.send(["topic://room"], { body: "earlier zone-A message" });
  await wait(400);
  await alice.stop();

  // Bob joins AFTER, subscribed to the same topic — he must get the history via replay.
  const bobGot: unknown[] = [];
  const bob = new NodeHost({ card: { id: bobId.id, name: "bob" }, transport: new RelayWSTransport(wsUrl, CT, bobId), dataDir: await tmpDir(), identity: bobId, zone: "s-A", heartbeatMs: 60000 });
  bob.subscribe("topic://room");
  bob.onMessage((e) => {
    bobGot.push(e.body);
  });
  await bob.start();
  await until(() => bobGot.includes("earlier zone-A message"), 4000);
  assert.ok(bobGot.includes("earlier zone-A message"), "late joiner replays the zone history");

  await bob.stop();
  await server.stop();
});

test("zones: an agent cannot stamp a zone it is not a member of", async () => {
  const dir = await tmpDir();
  const server = new ConclaveServer({ wsPort: 0, httpPort: 0, dataDir: dir, token: CT, adminToken: AT });
  await server.start();
  const base = `http://127.0.0.1:${server.httpPort()}`;
  const wsUrl = `ws://127.0.0.1:${server.wsPort()}`;

  const mallory = await enroll(base, "mallory", ["s-M"]);
  // mallory belongs to s-M but tries to send into s-VICTIM.
  const host = new NodeHost({
    card: { id: mallory.id, name: mallory.name },
    transport: new RelayWSTransport(wsUrl, CT, mallory),
    dataDir: await tmpDir(),
    identity: mallory,
    zone: "s-VICTIM", // not a member!
    heartbeatMs: 60000,
  });
  let rejected = false;
  // Listen for the relay's rejection of the forged-zone publish.
  await host.start();
  await wait(300);
  await host.send(["topic://room"], { body: "intrusion" });
  await wait(500);
  // The hub never logged it (authorizePolicy rejects a zone the sender isn't in).
  // History is admin-only in secure mode, so read it with the admin token.
  const msgs = (await (await fetch(`${base}/messages`, { headers: { authorization: `Bearer ${AT}` } })).json()) as { messages: { body?: unknown }[] };
  rejected = !msgs.messages.some((m) => m.body === "intrusion");
  assert.ok(rejected, "publish stamped with a non-member zone is dropped");

  await host.stop();
  await server.stop();
});
