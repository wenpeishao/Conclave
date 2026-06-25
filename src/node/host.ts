import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Transport } from "../core/transport.js";
import type { Envelope, AgentCard, Kind, Artifact } from "../core/types.js";
import { makeEnvelope, deliverableTo } from "../core/envelope.js";
import { signEnvelope, type Identity } from "../core/identity.js";

/**
 * NodeHost — the per-device daemon. Bare process, NO Docker. It wraps one Transport
 * and one local agent (via an adapter) and provides:
 *   - idempotent delivery (dedup by ULID across restarts)
 *   - durable cursor + inbound/outbound WAL under dataDir
 *   - presence heartbeats → a live roster of who else is on the bus
 *   - topic subscriptions + directed/broadcast addressing
 *
 * Two hosts on two machines pointed at the same Transport == a cross-device team.
 */
export interface HostOpts {
  card: AgentCard;
  transport: Transport;
  dataDir: string; // per-agent state lands in dataDir/<name>/
  topics?: string[]; // topic:// addresses to receive (presence is always handled)
  heartbeatMs?: number;
  identity?: Identity; // if set, every outgoing envelope is ed25519-signed
  zone?: string; // if set, outgoing envelopes are stamped with this zone (scoped delivery)
}

type MsgHandler = (e: Envelope) => void | Promise<void>;

interface RosterEntry {
  card: AgentCard;
  lastSeen: number;
}

const SEEN_CAP = 5000;

export class NodeHost {
  readonly card: AgentCard;
  private t: Transport;
  private dataDir: string;
  private topics: Set<string>;
  private heartbeatMs: number;
  private identity?: Identity;
  private zone?: string;

  private seq = 0;
  private cursor: string | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private roster = new Map<string, RosterEntry>();
  private handlers: MsgHandler[] = [];
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private saveCounter = 0;

  constructor(o: HostOpts) {
    this.card = o.card;
    this.t = o.transport;
    this.dataDir = path.join(o.dataDir, sanitize(o.card.name));
    this.topics = new Set(o.topics ?? []);
    this.heartbeatMs = o.heartbeatMs ?? 10000;
    this.identity = o.identity;
    this.zone = o.zone;
  }

  /** Register a sink for messages addressed to this agent. */
  onMessage(h: MsgHandler) {
    this.handlers.push(h);
  }

  /** Known agents and whether they are currently online (heartbeat within 3 beats). */
  getRoster(): (AgentCard & { online: boolean })[] {
    const now = Date.now();
    return [...this.roster.values()].map((r) => ({
      ...r.card,
      online: now - r.lastSeen < this.heartbeatMs * 3,
    }));
  }

  subscribe(topic: string) {
    this.topics.add(topic);
  }

  /** Update this agent's advertised availability and re-announce it on the global roster. */
  setStatus(status: string): void {
    this.card.status = status;
    void this.announce();
  }

  async start(): Promise<void> {
    if (!this.card.status) this.card.status = "available";
    if (this.zone && !this.card.zones) this.card.zones = [this.zone];
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.loadState();
    this.t.onEnvelope((e, c) => {
      void this.onEnvelope(e, c);
    });
    await this.t.start(this.cursor);
    await this.announce();
    this.hbTimer = setInterval(() => {
      void this.announce();
    }, this.heartbeatMs);
  }

  async stop(): Promise<void> {
    if (this.hbTimer) clearInterval(this.hbTimer);
    await this.t.stop();
    await this.scheduleSave(); // final save, serialized on the same chain as all others
  }

  /** Send a message. Returns the envelope that went on the wire. */
  async send(
    to: string[] | "*",
    opts: {
      subject?: string;
      body?: unknown;
      kind?: Kind;
      corr?: string;
      content_type?: string;
      artifacts?: Artifact[];
    } = {},
  ): Promise<Envelope> {
    let env = makeEnvelope({ from: this.card.id, to, seq: ++this.seq, ...opts });
    if (this.zone) env.zone = this.zone;
    if (this.identity) env = signEnvelope(env, this.identity.privateKey);
    this.markSeen(env.id); // never deliver our own message back to ourselves
    await this.append("outbound.ndjson", env);
    this.scheduleSave();
    await this.t.publish(env);
    return env;
  }

  private async onEnvelope(e: Envelope, c: string | null) {
    if (c !== null) this.cursor = c;
    if (this.seen.has(e.id)) {
      this.scheduleSave();
      return;
    }
    this.markSeen(e.id);
    // Own echo: drop our own messages/requests (so the agent runtime doesn't react to itself),
    // but DELIVER our own `event`s — convergent state like the task board must see its own ops
    // when a fresh process replays history it posted in a previous run.
    if (e.from === this.card.id && e.kind !== "event") {
      this.scheduleSave();
      return;
    }
    if (e.kind === "presence") {
      this.updateRoster(e);
      this.scheduleSave();
      return;
    }
    if (!deliverableTo(e, this.card.id, this.topics)) {
      this.scheduleSave();
      return;
    }
    await this.append("inbound.ndjson", e);
    for (const h of this.handlers) {
      try {
        await h(e);
      } catch (err) {
        console.error("[conclave] message handler error:", err);
      }
    }
    this.scheduleSave();
  }

  private async announce() {
    // Presence is the GLOBAL discovery plane: it is NOT zone-stamped, so every agent sees the
    // full roster (who is online, their capabilities, available/busy) across zones.
    let env = makeEnvelope({
      from: this.card.id,
      to: ["topic://presence"],
      kind: "presence",
      body: this.card,
    });
    if (this.identity) env = signEnvelope(env, this.identity.privateKey);
    try {
      await this.t.publish(env);
    } catch {
      /* transport down — next heartbeat retries */
    }
  }

  private updateRoster(e: Envelope) {
    const card = e.body as AgentCard | undefined;
    if (card && card.id) this.roster.set(card.id, { card, lastSeen: Date.now() });
  }

  private markSeen(id: string) {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > SEEN_CAP) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  private async append(file: string, e: Envelope) {
    await fs.appendFile(path.join(this.dataDir, file), JSON.stringify(e) + "\n");
  }

  private async loadState() {
    try {
      const raw = await fs.readFile(path.join(this.dataDir, "state.json"), "utf8");
      const s = JSON.parse(raw) as {
        seq?: number;
        cursor?: string | null;
        seen?: string[];
        roster?: { card: AgentCard }[];
      };
      this.seq = s.seq ?? 0;
      this.cursor = s.cursor ?? null;
      this.seenOrder = s.seen ?? [];
      this.seen = new Set(this.seenOrder);
      for (const r of s.roster ?? []) this.roster.set(r.card.id, { card: r.card, lastSeen: 0 });
    } catch {
      /* fresh start */
    }
  }

  private scheduleSave(): Promise<void> {
    this.saveChain = this.saveChain
      .then(() => this.flush())
      .catch((e) => {
        console.error("[conclave] state save error:", e);
      });
    return this.saveChain;
  }

  private async flush() {
    const s = {
      seq: this.seq,
      cursor: this.cursor,
      seen: this.seenOrder.slice(-SEEN_CAP),
      roster: [...this.roster.values()].map((r) => ({ card: r.card })),
    };
    // Unique tmp name per write so concurrent flushes never rename the same file twice.
    const tmp = path.join(this.dataDir, `state.${process.pid}.${++this.saveCounter}.tmp`);
    const dst = path.join(this.dataDir, "state.json");
    await fs.writeFile(tmp, JSON.stringify(s));
    await fs.rename(tmp, dst); // atomic — a crash mid-write can't corrupt state
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
