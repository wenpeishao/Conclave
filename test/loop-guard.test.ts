import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import type { Brain } from "../src/agent/runtime.js";
import { tmpDir, card, until } from "./helpers.js";

test("LoopGuard: trips on consecutive replies to the same peer", () => {
  const g = new LoopGuard({ maxConsecutivePerPeer: 3, maxRepliesPerWindow: 100, windowMs: 10000 });
  const now = 1000;
  for (let i = 0; i < 3; i++) {
    assert.equal(g.check("agent://b", now + i).ok, true);
    g.record("agent://b", now + i);
  }
  const d = g.check("agent://b", now + 3);
  assert.equal(d.ok, false);
  assert.equal(d.reason, "pingpong");
  // A different peer is unaffected.
  assert.equal(g.check("agent://c", now + 3).ok, true);
});

test("LoopGuard: trips on overall rate", () => {
  const g = new LoopGuard({ maxRepliesPerWindow: 5, maxConsecutivePerPeer: 100, windowMs: 10000 });
  for (let i = 0; i < 5; i++) {
    g.record(`agent://p${i}`, 1000 + i); // distinct peers, so only the rate limit applies
  }
  assert.equal(g.check("agent://new", 1006).reason, "rate");
});

// A brain that ALWAYS replies — two of these would ping-pong forever without a guard.
function parrotBrain(): Brain {
  return {
    async react(ctx) {
      const e = ctx.message;
      if (e.kind === "presence" || e.kind === "ack" || e.kind === "event") return [{ type: "noop" }];
      return [{ type: "send", to: [e.from], body: "pong", kind: "message" }];
    },
  };
}

test("guard halts a two-agent ping-pong and escalates to a human", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const mkGuard = () => new LoopGuard({ maxConsecutivePerPeer: 4, maxRepliesPerWindow: 100, windowMs: 10000 });

  const aHost = new NodeHost({ card: card("A"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bHost = new NodeHost({ card: card("B"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const aGot: string[] = [];
  const bGot: string[] = [];
  aHost.onMessage((e) => {
    if (e.kind === "message") aGot.push(String(e.body));
  });
  bHost.onMessage((e) => {
    if (e.kind === "message") bGot.push(String(e.body));
  });
  const aAgent = new AutonomousAgent(aHost, parrotBrain(), { guard: mkGuard() });
  const bAgent = new AutonomousAgent(bHost, parrotBrain(), { guard: mkGuard() });

  // A human collects loop-guard escalations.
  const humanHost = new NodeHost({ card: card("human"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  humanHost.subscribe("topic://human");
  const escalations: unknown[] = [];
  humanHost.onMessage((e) => {
    if (e.kind === "event" && e.subject === "loop-guard tripped") escalations.push(e.body);
  });

  await aAgent.start();
  await bAgent.start();
  await humanHost.start();

  // Kick off the loop. Without a guard this never stops.
  await aHost.send(["agent://B"], { body: "start" });

  // Wait for at least one escalation (a trip happened), then confirm it settles.
  await until(() => escalations.length >= 1, 5000);
  const snapshot = aGot.length + bGot.length;
  await new Promise((r) => setTimeout(r, 300));
  const after = aGot.length + bGot.length;

  assert.ok(escalations.length >= 1, "a human was notified of the loop");
  assert.equal(after, snapshot, "the ping-pong stopped (no new messages after the trip)");
  assert.ok(after < 30, `bounded message count, got ${after}`);

  await aAgent.stop();
  await bAgent.stop();
  await humanHost.stop();
});
