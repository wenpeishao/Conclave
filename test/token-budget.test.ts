import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenBudget, estimateTokens } from "../src/agent/token-budget.js";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import type { Brain } from "../src/agent/runtime.js";
import { tmpDir, card, until } from "./helpers.js";

test("TokenBudget: charge / remaining / exhausted", () => {
  const b = new TokenBudget(100);
  assert.equal(b.exhausted(), false);
  b.charge(40);
  assert.equal(b.remaining(), 60);
  b.charge(60);
  assert.equal(b.exhausted(), true);
  assert.equal(b.remaining(), 0);
  assert.ok(estimateTokens("12345678") >= 2); // ~chars/4
});

// A brain that reports a fixed real token cost per reply.
function meteredBrain(costPerReply: number): Brain {
  return {
    async react(ctx) {
      const e = ctx.message;
      if (e.kind !== "request") return [{ type: "noop" }];
      return { actions: [{ type: "send", to: [e.from], body: "ok", kind: "response" }], usageTokens: costPerReply };
    },
  };
}

test("token budget stops the brain once spent, and escalates to a human", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const budget = new TokenBudget(50);
  const botHost = new NodeHost({ card: card("metered"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, meteredBrain(40), { budget });

  const askHost = new NodeHost({ card: card("asker"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const answers: string[] = [];
  askHost.onMessage((e) => {
    if (e.kind === "response") answers.push(String(e.body));
  });

  const humanHost = new NodeHost({ card: card("human"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  humanHost.subscribe("topic://human");
  const escalations: unknown[] = [];
  humanHost.onMessage((e) => {
    if (e.kind === "event" && e.subject === "loop-guard tripped") escalations.push(e.body);
  });

  await bot.start();
  await askHost.start();
  await humanHost.start();

  // Three requests; budget 50 with 40/reply allows the first two, blocks the third.
  await askHost.send(["agent://metered"], { kind: "request", subject: "q1", body: "one" });
  await until(() => answers.length === 1, 3000);
  await askHost.send(["agent://metered"], { kind: "request", subject: "q2", body: "two" });
  await until(() => answers.length === 2, 3000);
  await askHost.send(["agent://metered"], { kind: "request", subject: "q3", body: "three" });
  await until(() => escalations.length >= 1, 3000);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(answers.length, 2, "budget allowed exactly two replies (40+40 within 50, third blocked)");
  assert.ok(escalations.length >= 1, "human notified when budget exhausted");
  assert.equal(budget.spent(), 80);

  await bot.stop();
  await askHost.stop();
  await humanHost.stop();
});
