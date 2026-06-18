/**
 * Demo: two services on two machines keeping their API contract aligned.
 *
 * The scenario from the design discussion: service A (orders) owns an OpenAPI contract;
 * when A changes it, service B (inventory) must regenerate its client immediately rather
 * than drift until the next manual pull.
 *
 * The CONTRACT itself is the source of truth (a file referenced as an artifact, by URI +
 * hash — it does NOT travel inline). Conclave is the *notification* layer: A emits an
 * `event`, B reacts the moment it lands. That two-layer split (durable contract in git +
 * real-time nudge over the bus) is the whole point.
 *
 * Run with zero setup (in-process MemoryHub):   npx tsx examples/api-alignment/demo.ts
 * Cross-device, swap MemoryHub for a RelayWSTransport(url) or GitBusTransport(...) — the
 * NodeHost code below does not change at all.
 */
import { MemoryHub } from "../../src/transports/memory.js";
import { NodeHost } from "../../src/node/host.js";
import * as os from "node:os";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "conclave-demo-"));
  const hub = new MemoryHub();

  const orders = new NodeHost({
    card: {
      id: "agent://orders",
      name: "orders",
      capabilities: ["service:orders"],
      owns: ["contract:openapi/orders.yaml"],
    },
    transport: hub.connect(),
    dataDir,
    heartbeatMs: 60000,
  });

  const inventory = new NodeHost({
    card: { id: "agent://inventory", name: "inventory", capabilities: ["service:inventory"] },
    transport: hub.connect(),
    dataDir,
    heartbeatMs: 60000,
  });

  // B reacts to contract-change events by "regenerating its client" from the artifact.
  inventory.onMessage((e) => {
    if (e.kind === "event" && e.subject?.startsWith("contract-changed")) {
      const art = e.artifacts?.[0];
      console.log(`\n[inventory] heard "${e.subject}" from ${e.from}`);
      console.log(`[inventory] regenerating client from ${art?.uri} (sha256 ${art?.sha256?.slice(0, 12)}…)`);
      console.log(`[inventory] ✓ client regenerated, breaking-change check queued in CI`);
    }
  });

  await orders.start();
  await inventory.start();
  console.log("[demo] both services on the bus. orders changes the contract…");

  // A changed its contract → commit it to git (out of band), then nudge B with a
  // reference (NOT the file contents).
  await orders.send("*", {
    kind: "event",
    subject: "contract-changed: POST /v2/orders now requires idempotency_key",
    body: "Added required header idempotency_key to POST /v2/orders. Regenerate clients.",
    artifacts: [
      {
        uri: "git+ssh://git@github.com/acme/contracts#a1b2c3d",
        sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        desc: "openapi/orders.yaml @ a1b2c3d",
      },
    ],
  });

  await wait(100);
  console.log("\n[demo] done. The contract lived in git; the bus only carried the nudge.");
  await orders.stop();
  await inventory.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
