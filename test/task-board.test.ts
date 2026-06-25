import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceBoard, TaskBoard, type BoardEvent } from "../src/agent/task-board.js";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { tmpDir, card, until } from "./helpers.js";

test("reduceBoard: earliest-claim-wins + done + order-independent", () => {
  const TID = "task-0001"; // task id = the add envelope's id
  const base: BoardEvent[] = [
    { eid: TID, from: "agent://x", op: { op: "add", title: "ship it" } },
    { eid: "claim-2", from: "agent://bob", op: { op: "claim", id: TID } },
    { eid: "claim-1", from: "agent://alice", op: { op: "claim", id: TID } },
  ];
  const r1 = reduceBoard(base);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].id, TID);
  assert.equal(r1[0].status, "claimed");
  assert.equal(r1[0].claimedBy, "agent://alice", "smallest-ULID claim (claim-1) wins");

  // Order independence: shuffling the event log must not change the result.
  const r2 = reduceBoard([...base].reverse());
  assert.deepEqual(r2, r1);

  // A done event finalizes it.
  const withDone: BoardEvent[] = [...base, { eid: "done-1", from: "agent://alice", op: { op: "done", id: TID, result: "shipped" } }];
  const r3 = reduceBoard(withDone);
  assert.equal(r3[0].status, "done");
  assert.equal(r3[0].result, "shipped");

  // A claim/done for an unknown task is ignored (no phantom task).
  assert.equal(reduceBoard([{ eid: "c", from: "agent://y", op: { op: "claim", id: "ghost" } }]).length, 0);
});

test("TaskBoard converges across two hosts over the bus", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();
  const aHost = new NodeHost({ card: card("A"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bHost = new NodeHost({ card: card("B"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const aBoard = new TaskBoard(aHost);
  const bBoard = new TaskBoard(bHost);
  await aHost.start();
  await bHost.start();

  // A posts a task → B sees it (open).
  const id = await aBoard.add("write the tests");
  await until(() => bBoard.list().some((t) => t.id === id), 4000);
  assert.equal(bBoard.list().find((t) => t.id === id)?.status, "open");

  // B claims it → A sees the claim.
  await bBoard.claim(id);
  await until(() => aBoard.list().find((t) => t.id === id)?.claimedBy === "agent://B", 4000);
  assert.equal(aBoard.list().find((t) => t.id === id)?.status, "claimed");

  // B finishes → A sees done + result.
  await bBoard.done(id, "tests written");
  await until(() => aBoard.list().find((t) => t.id === id)?.status === "done", 4000);
  assert.equal(aBoard.list().find((t) => t.id === id)?.result, "tests written");

  await aHost.stop();
  await bHost.stop();
});

test("TaskBoard: claimNext claims the earliest open task", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();
  const host = new NodeHost({ card: card("solo"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const board = new TaskBoard(host);
  await host.start();

  const id1 = await board.add("first");
  await board.add("second");
  const claimed = await board.claimNext();
  assert.equal(claimed?.id, id1, "claims the earliest open task");
  assert.equal(board.list().find((t) => t.id === id1)?.claimedBy, "agent://solo");
  assert.equal(board.open().length, 1, "one task remains open");

  await host.stop();
});
