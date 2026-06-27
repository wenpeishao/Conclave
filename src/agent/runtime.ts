import type { NodeHost } from "../node/host.js";
import type { Envelope, AgentCard, Kind } from "../core/types.js";
import { LoopGuard } from "./loop-guard.js";
import { TokenBudget, estimateTokens } from "./token-budget.js";

/**
 * AutonomousAgent — turns a NodeHost into a model-driven actor.
 *
 * A NodeHost on its own just moves envelopes. Wrap it in an AutonomousAgent with a
 * `Brain` and it *reacts*: every inbound message is handed to the brain, which decides
 * what (if anything) to send back. Swap the brain and you swap the model/policy driving
 * the agent — a deterministic rule engine, a Claude model, a local model, anything that
 * implements `Brain`. That is how heterogeneous models share one bus: each is just a
 * different Brain behind the same NodeHost + Transport.
 */
export interface BrainContext {
  self: AgentCard;
  message: Envelope; // the inbound envelope that triggered this reaction
  roster: (AgentCard & { online: boolean })[];
  history: Envelope[]; // recent inbound + outbound, oldest first
}

export interface SendAction {
  type: "send";
  to: string[] | "*";
  body: string;
  subject?: string;
  kind?: Kind;
  corr?: string;
}
export type Action = SendAction | { type: "noop" };

/** A brain may return a bare action list, or actions plus the real tokens it spent. */
export interface BrainReply {
  actions: Action[];
  usageTokens?: number;
}
export type BrainResult = Action[] | BrainReply;

export interface Brain {
  react(ctx: BrainContext): Promise<BrainResult>;
}

export interface AgentOpts {
  maxHistory?: number;
  /** Loop protection. Suppresses runaway brain replies; omit to disable. */
  guard?: LoopGuard;
  /** Token spend cap. Stops invoking the brain once exhausted; omit for unbounded. */
  budget?: TokenBudget;
  /** Topic to notify when the guard/budget trips (default topic://human). */
  escalateTo?: string;
  /** If true, broadcast this agent's inbound/outbound activity as `watch` events (for `conclave watch`). */
  watchable?: boolean;
}

export class AutonomousAgent {
  private host: NodeHost;
  private brain: Brain;
  private history: Envelope[] = [];
  private maxHistory: number;
  private guard?: LoopGuard;
  private budget?: TokenBudget;
  private escalateTo: string;
  private lastEscalateAt = 0;
  private watchable: boolean;

  constructor(host: NodeHost, brain: Brain, opts: AgentOpts = {}) {
    this.host = host;
    this.brain = brain;
    this.maxHistory = opts.maxHistory ?? 40;
    this.guard = opts.guard;
    this.budget = opts.budget;
    this.escalateTo = opts.escalateTo ?? "topic://human";
    this.watchable = opts.watchable ?? false;
  }

  /** Broadcast a one-line trace of this agent's activity so `conclave watch` can stream it live. */
  private emitWatch(dir: "in" | "out", peer: string, kind: string | undefined, subject: string | undefined, body: unknown): void {
    if (!this.watchable) return;
    if (kind === "event" || kind === "presence" || kind === "ack") return; // trace conversation only — never watch/presence events (would feed back into a storm)
    const preview = renderBody(body).replace(/\s+/g, " ").slice(0, 180);
    void this.host.send("*", { kind: "event", subject: "watch", body: { agent: this.host.card.id, dir, peer, kind, subj: subject, preview } });
  }

  get card(): AgentCard {
    return this.host.card;
  }

  async start(): Promise<void> {
    this.host.onMessage((e) => this.handle(e));
    await this.host.start();
  }

  async stop(): Promise<void> {
    await this.host.stop();
  }

  private async handle(e: Envelope): Promise<void> {
    this.record(e);
    this.emitWatch("in", e.from, e.kind, e.subject, e.body);

    // Budget gate: once exhausted, stop spending on inference and hand off to a human.
    if (this.budget && this.budget.exhausted()) {
      await this.escalate("budget", e.from);
      return;
    }

    const ctx: BrainContext = {
      self: this.host.card,
      message: e,
      roster: this.host.getRoster(),
      history: [...this.history],
    };
    let result: BrainResult;
    try {
      result = await this.brain.react(ctx);
    } catch (err) {
      console.error("[conclave] brain error:", err);
      return;
    }
    const actions = Array.isArray(result) ? result : result.actions;
    const reportedUsage = Array.isArray(result) ? undefined : result.usageTokens;

    // The brain call cost tokens whether or not we end up sending — charge it now.
    if (this.budget) {
      const replyText = actions.map((a) => (a.type === "send" ? a.body : "")).join("");
      this.budget.charge(reportedUsage ?? estimateTokens(renderBody(e.body), replyText));
    }

    for (const a of actions) {
      if (a.type !== "send") continue;
      const peer = Array.isArray(a.to) ? (a.to[0] ?? "*") : "*";
      if (this.guard) {
        const decision = this.guard.check(peer);
        if (!decision.ok) {
          await this.escalate(decision.reason ?? "rate", peer);
          continue; // suppress the runaway reply
        }
      }
      try {
        const sent = await this.host.send(a.to, {
          body: a.body,
          subject: a.subject,
          kind: a.kind,
          corr: a.corr,
        });
        this.emitWatch("out", peer, a.kind, a.subject, a.body);
        this.guard?.record(peer);
        this.record(sent);
      } catch (err) {
        console.error("[conclave] agent send failed:", err);
      }
    }
  }

  /** Notify a human (once per window) that this agent hit a loop limit. */
  private async escalate(reason: string, peer: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastEscalateAt < 30000) return; // don't spam escalations
    this.lastEscalateAt = now;
    console.error(`[conclave] loop guard tripped (${reason}) on ${this.host.card.id} -> ${peer}; reply suppressed`);
    try {
      // Sent directly (not through the guard) so escalation itself can't be throttled.
      await this.host.send([this.escalateTo], {
        kind: "event",
        subject: "loop-guard tripped",
        body: { agent: this.host.card.id, peer, reason },
      });
    } catch {
      /* escalation is best-effort */
    }
  }

  private record(e: Envelope) {
    this.history.push(e);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
  }
}

/** Render an envelope body to a short string for prompts / logs. */
export function renderBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}
