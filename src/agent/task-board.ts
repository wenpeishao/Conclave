import { ulid } from "../core/ulid.js";
import type { NodeHost } from "../node/host.js";
import type { Envelope } from "../core/types.js";

/**
 * TaskBoard — a shared, convergent task list over the bus. This is the coordination layer
 * that turns "agents chatting" into "a team doing work" (the Agent Teams shared-task-list
 * equivalent): anyone can post a task, anyone can claim it, the claimer marks it done, and
 * every participant sees the same board.
 *
 * It rides one reserved topic (topic://tasks) as a stream of small `event` envelopes
 * ({op:"add"|"claim"|"done", ...}). Each host reduces that stream into the same Task[]:
 * convergence comes from ULID tie-breaks — the earliest (smallest-ULID) add/claim/done
 * wins — so concurrent claims resolve to ONE winner identically on every device,
 * regardless of arrival order. No central lock; eventually consistent and order-independent.
 */
export const TASKS_TOPIC = "topic://tasks";

export type TaskOp =
  | { op: "add"; title: string; for?: string } // `for` = required role/capability (role routing)
  | { op: "claim"; id: string }
  | { op: "done"; id: string; result?: string }
  | { op: "release"; id: string }; // un-claim: voids claims/dones older than it (revoke / lease expiry)

export interface BoardEvent {
  eid: string; // the envelope ULID (global, time-sortable) — the convergence key
  from: string;
  op: TaskOp;
}

export interface Task {
  id: string; // = the add envelope's ULID
  title: string;
  createdBy: string;
  status: "open" | "claimed" | "done";
  claimedBy?: string;
  result?: string;
  for?: string; // required role; only a worker with a matching role claims it (unset = anyone)
}

export function isTaskOp(b: unknown): b is TaskOp {
  if (typeof b !== "object" || b === null) return false;
  const op = (b as { op?: unknown }).op;
  return op === "add" || op === "claim" || op === "done" || op === "release";
}

const minBy = <T>(xs: T[], key: (x: T) => string): T =>
  xs.reduce((a, b) => (key(b) < key(a) ? b : a));

/**
 * Pure, order-independent reducer. For each task: title/creator from the earliest `add`;
 * claimedBy from the earliest `claim`; done (+result) from the earliest `done`. Earliest =
 * smallest ULID, so all hosts converge to the same board no matter what order events arrive.
 */
export function reduceBoard(events: BoardEvent[]): Task[] {
  const adds = new Map<string, { eid: string; from: string; title: string; for?: string }[]>();
  const claims = new Map<string, { eid: string; from: string }[]>();
  const dones = new Map<string, { eid: string; from: string; result?: string }[]>();
  const releases = new Map<string, string[]>(); // task id → release eids
  const push = <T>(m: Map<string, T[]>, id: string, v: T) => {
    const arr = m.get(id);
    if (arr) arr.push(v);
    else m.set(id, [v]);
  };

  for (const { eid, from, op } of events) {
    if (op.op === "add") push(adds, eid, { eid, from, title: op.title, for: op.for }); // task id = add envelope id
    else if (op.op === "claim") push(claims, op.id, { eid, from });
    else if (op.op === "done") push(dones, op.id, { eid, from, result: op.result });
    else if (op.op === "release") push(releases, op.id, eid);
  }

  const tasks: Task[] = [];
  for (const [id, addList] of adds) {
    const add = minBy(addList, (x) => x.eid);
    // A release voids any claim/done with an OLDER ULID, so the task re-opens and a newer claim
    // (after the release) takes over. No release → "" → everything is valid (original behavior).
    const lastRelease = (releases.get(id) ?? []).reduce((a, b) => (b > a ? b : a), "");
    const claimList = (claims.get(id) ?? []).filter((c) => c.eid > lastRelease);
    const doneList = (dones.get(id) ?? []).filter((d) => d.eid > lastRelease);
    const claim = claimList.length ? minBy(claimList, (x) => x.eid) : null;
    const done = doneList.length ? minBy(doneList, (x) => x.eid) : null;
    tasks.push({
      id,
      title: add.title,
      createdBy: add.from,
      claimedBy: claim?.from,
      result: done?.result,
      status: done ? "done" : claim ? "claimed" : "open",
      for: add.for,
    });
  }
  return tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export class TaskBoard {
  private host: NodeHost;
  private events: BoardEvent[] = [];
  private seen = new Set<string>();
  private listeners: ((board: Task[]) => void)[] = [];

  constructor(host: NodeHost) {
    this.host = host;
    host.subscribe(TASKS_TOPIC);
    // The board's reduced state lives only in memory, so a fresh process must re-read the WHOLE
    // log to rebuild it — resuming from a saved cursor would skip pre-cursor task history and
    // silently produce an incomplete board. (The server hub does the same for its own board.)
    host.requireFullReplay();
    host.onMessage((e) => {
      if (e.kind === "event" && e.subject === "task" && isTaskOp(e.body)) {
        this.record(e.id, e.from, e.body);
      }
    });
    // Claim resolution: the server positively ACKs an accepted claim and REJECTS (err) a loser
    // (first-claim-wins). We resolve the pending claim either way — and undo the optimistic local
    // record on rejection — so a worker runs only when it is the CONFIRMED owner, not on a timer.
    host.onAck((id) => {
      this.pendingClaims.get(id)?.("won");
      this.pendingClaims.delete(id);
    });
    host.onReject((id) => {
      this.unrecord(id);
      this.pendingClaims.get(id)?.("lost");
      this.pendingClaims.delete(id);
    });
  }

  private pendingClaims = new Map<string, (v: "won" | "lost" | "timeout") => void>();

  private record(eid: string, from: string, op: TaskOp) {
    if (this.seen.has(eid)) return; // idempotent (a redelivery can't double-apply)
    this.seen.add(eid);
    this.events.push({ eid, from, op });
    const board = this.list();
    for (const cb of this.listeners) cb(board);
  }

  /** Undo an optimistically-recorded op the server rejected (e.g. a lost claim). */
  private unrecord(eid: string) {
    if (!this.seen.has(eid)) return;
    const before = this.events.length;
    this.events = this.events.filter((e) => e.eid !== eid);
    this.seen.delete(eid);
    if (this.events.length !== before) {
      const board = this.list();
      for (const cb of this.listeners) cb(board);
    }
  }

  private async publish(op: TaskOp): Promise<Envelope> {
    const env = await this.host.send([TASKS_TOPIC], { kind: "event", subject: "task", body: op });
    // The host doesn't deliver our own envelopes back to us, so apply locally too.
    this.record(env.id, env.from, op);
    return env;
  }

  /** Post a new task; returns its id. `for` restricts it to workers with that role. */
  async add(title: string, opts: { for?: string } = {}): Promise<string> {
    const env = await this.publish(opts.for ? { op: "add", title, for: opts.for } : { op: "add", title });
    return env.id;
  }

  async claim(id: string): Promise<void> {
    await this.publish({ op: "claim", id });
  }

  async done(id: string, result?: string): Promise<void> {
    await this.publish(result === undefined ? { op: "done", id } : { op: "done", id, result });
  }

  /** Un-claim a task so another worker can re-claim it (e.g. its claimer was revoked). */
  async release(id: string): Promise<void> {
    await this.publish({ op: "release", id });
  }

  list(): Task[] {
    return reduceBoard(this.events);
  }
  /** Open tasks claimable by `role`: untagged tasks (anyone) plus tasks whose `for` matches. */
  open(role?: string): Task[] {
    return this.list().filter((t) => t.status === "open" && (!t.for || t.for === role));
  }
  /**
   * Claim the earliest open task and return it ONLY if we are the confirmed owner, else null.
   *
   * In secure mode the server enforces first-claim-wins and positively ACKs the accepted claim
   * (rejecting losers), so we wait for that verdict — exactly-once holds regardless of contention
   * or timing. Against a legacy relay that doesn't ack, we fall back to the min-ULID local view
   * after `settleMs` (best-effort; treat the claim as a hint there).
   */
  async claimNext(settleMs = 0, role?: string): Promise<Task | null> {
    const next = this.open(role)[0];
    if (!next) return null;

    // Legacy (no secure server / no acks): best-effort optimistic claim + min-ULID settle.
    if (!this.host.secure) {
      await this.claim(next.id);
      if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
      const after = this.list().find((t) => t.id === next.id);
      return after?.claimedBy === this.host.card.id ? after : null;
    }

    // Secure: publish asking the server to positively confirm acceptance, and wait for the
    // verdict (ack=won, reject=lost). Exactly-once holds regardless of contention/timing.
    const env = await this.host.send([TASKS_TOPIC], { kind: "event", subject: "task", body: { op: "claim", id: next.id }, wantAck: true });
    this.record(env.id, env.from, { op: "claim", id: next.id }); // optimistic; undone if rejected
    const verdict = await new Promise<"won" | "lost" | "timeout">((resolve) => {
      this.pendingClaims.set(env.id, resolve);
      setTimeout(() => {
        if (this.pendingClaims.delete(env.id)) resolve("timeout");
      }, Math.max(settleMs, 2500));
    });
    // Only run when positively confirmed the owner; a timeout (the server would have answered)
    // is treated as not-owned to avoid double-execution.
    return verdict === "won" ? (this.list().find((t) => t.id === next.id) ?? next) : null;
  }
  onChange(cb: (board: Task[]) => void): void {
    this.listeners.push(cb);
  }
}

/** Stable id generator for callers that want to pre-mint ids (not used by add()). */
export const newTaskId = ulid;
