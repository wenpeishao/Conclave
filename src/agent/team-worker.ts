import type { NodeHost } from "../node/host.js";
import type { Brain, BrainContext } from "./runtime.js";
import { makeEnvelope } from "../core/envelope.js";
import type { TaskBoard, Task } from "./task-board.js";

/**
 * TeamWorker — turns a teammate into a self-organizing worker on the shared task board.
 * Instead of only replying to messages, it actively WORKS the board: poll → claim the
 * earliest open task → run its brain to do it → mark it done with the result → repeat.
 *
 * Run one TeamWorker per device pointed at the same bus and a posted goal gets decomposed
 * across the team: each teammate claims different tasks (the board's earliest-ULID claim
 * + a settle window prevent two machines doing the same one) and reports results back to
 * the shared board — coordinated work across devices, no human relaying each message.
 */
export interface TeamWorkerEvent {
  type: "claim" | "done" | "lost";
  task?: Task;
  result?: string;
}

export interface TeamWorkerOpts {
  pollMs?: number;
  settleMs?: number; // wait after claiming to confirm ownership across devices
  role?: string; // only claim tasks tagged for this role (plus untagged ones)
  handoffTo?: string; // after finishing, post a new task (for this role) carrying the result
  onEvent?: (ev: TeamWorkerEvent) => void;
}

export class TeamWorker {
  private stopped = false;
  private busy = false;

  constructor(
    private host: NodeHost,
    private board: TaskBoard,
    private brain: Brain,
    private opts: TeamWorkerOpts = {},
  ) {}

  async start(): Promise<void> {
    await this.host.start();
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.host.stop();
  }

  private async loop(): Promise<void> {
    const pollMs = this.opts.pollMs ?? 2500;
    const settleMs = this.opts.settleMs ?? 1500;
    const role = this.opts.role;
    while (!this.stopped) {
      if (!this.busy && this.board.open(role).length > 0) {
        const task = await this.board.claimNext(settleMs, role);
        if (task) {
          this.busy = true;
          this.host.setStatus("busy"); // surface availability on the global roster
          this.opts.onEvent?.({ type: "claim", task });
          let result: string;
          try {
            result = await this.runTask(task.title);
          } catch (e) {
            result = `error: ${(e as Error).message}`;
          }
          await this.board.done(task.id, result);
          this.opts.onEvent?.({ type: "done", task, result });
          // Pipeline handoff: pass the work product to the next role as a new task.
          if (this.opts.handoffTo) await this.board.add(result, { for: this.opts.handoffTo });
          this.busy = false;
          this.host.setStatus("available");
          continue; // immediately look for the next task
        }
        this.opts.onEvent?.({ type: "lost" }); // someone else won the claim
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Execute a task by asking the brain (a synthesized "do this" message from the board). */
  private async runTask(title: string): Promise<string> {
    const env = makeEnvelope({ from: "agent://board", to: [this.host.card.id], kind: "request", subject: "task", body: title });
    const ctx: BrainContext = { self: this.host.card, message: env, roster: this.host.getRoster(), history: [] };
    const res = await this.brain.react(ctx);
    const actions = Array.isArray(res) ? res : res.actions;
    const send = actions.find((a) => a.type === "send");
    return send && send.type === "send" ? send.body : "(no result)";
  }
}
