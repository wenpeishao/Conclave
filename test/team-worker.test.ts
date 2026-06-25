import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { TaskBoard } from "../src/agent/task-board.js";
import { TeamWorker } from "../src/agent/team-worker.js";
import type { Brain } from "../src/agent/runtime.js";
import { tmpDir, card, until } from "./helpers.js";

test("two TeamWorkers self-distribute board tasks with no double-work", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // A brain that "executes" a task by echoing a result, counting total executions.
  let execs = 0;
  const mkBrain = (): Brain => ({
    async react(ctx) {
      execs++;
      await new Promise((r) => setTimeout(r, 10));
      return { actions: [{ type: "send", to: [ctx.message.from], body: `R(${String(ctx.message.body)})`, kind: "response" }] };
    },
  });

  const h1 = new NodeHost({ card: card("w1"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const h2 = new NodeHost({ card: card("w2"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const b1 = new TaskBoard(h1);
  const b2 = new TaskBoard(h2);
  const w1 = new TeamWorker(h1, b1, mkBrain(), { pollMs: 40, settleMs: 25 });
  const w2 = new TeamWorker(h2, b2, mkBrain(), { pollMs: 40, settleMs: 25 });

  // A poster that only adds tasks (its own board view tracks completion).
  const hp = new NodeHost({ card: card("poster"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bp = new TaskBoard(hp);

  await w1.start();
  await w2.start();
  await hp.start();

  await bp.add("task one");
  await bp.add("task two");
  await bp.add("task three");

  // All three tasks reach "done" — claimed and completed by the workers across the bus.
  await until(() => bp.list().filter((t) => t.status === "done").length === 3, 6000);

  const done = bp.list().filter((t) => t.status === "done");
  assert.equal(done.length, 3, "all 3 tasks done");
  assert.ok(done.every((t) => t.result?.startsWith("R(")), "each task has a worker result");
  assert.ok(done.every((t) => t.claimedBy === "agent://w1" || t.claimedBy === "agent://w2"), "each claimed by a worker");
  assert.equal(execs, 3, "each task executed exactly once (no double-work)");

  await w1.stop();
  await w2.stop();
  await hp.stop();
});

test("role pipeline: coder does code tasks then hands off to the deployer", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const codeBrain = (): Brain => ({
    async react(ctx) {
      return { actions: [{ type: "send", to: [ctx.message.from], body: `CODE(${String(ctx.message.body)})`, kind: "response" }] };
    },
  });
  const deployBrain = (): Brain => ({
    async react(ctx) {
      return { actions: [{ type: "send", to: [ctx.message.from], body: `DEPLOYED(${String(ctx.message.body)})`, kind: "response" }] };
    },
  });

  const hc = new NodeHost({ card: card("coder"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const hd = new NodeHost({ card: card("deployer"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bc = new TaskBoard(hc);
  const bd = new TaskBoard(hd);
  const coder = new TeamWorker(hc, bc, codeBrain(), { pollMs: 40, settleMs: 25, role: "code", handoffTo: "deploy" });
  const deployer = new TeamWorker(hd, bd, deployBrain(), { pollMs: 40, settleMs: 25, role: "deploy" });

  const hp = new NodeHost({ card: card("lead"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bp = new TaskBoard(hp);

  await coder.start();
  await deployer.start();
  await hp.start();

  await bp.add("build feature X", { for: "code" });

  // Pipeline completes: a code task AND a handed-off deploy task, both done.
  await until(() => bp.list().filter((t) => t.status === "done").length === 2, 6000);
  const tasks = bp.list();
  const codeTask = tasks.find((t) => t.for === "code");
  const deployTask = tasks.find((t) => t.for === "deploy");

  assert.equal(codeTask?.status, "done");
  assert.equal(codeTask?.claimedBy, "agent://coder", "coder did the code task");
  assert.equal(codeTask?.result, "CODE(build feature X)");

  assert.ok(deployTask, "coder handed off a deploy task");
  assert.equal(deployTask?.status, "done");
  assert.equal(deployTask?.claimedBy, "agent://deployer", "deployer did the deploy task");
  assert.equal(deployTask?.result, "DEPLOYED(CODE(build feature X))", "deployer ran the coder's output");

  await coder.stop();
  await deployer.stop();
  await hp.stop();
});
