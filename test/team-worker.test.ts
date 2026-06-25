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
