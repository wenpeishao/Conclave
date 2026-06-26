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
  replayFromZero?: boolean; // ignore the persisted cursor/seen → full replay each start (the
  // server hub uses this so its in-memory board fully rebuilds from the durable log on restart)
  persistState?: boolean; // default true. false = read the cursor on start but NEVER advance it on
  // disk — for one-shot senders (send/board) that share a --data dir with `inbox`, so they don't
  // consume the inbox's durable read cursor (silent message loss for the human running both).
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
  private replayFromZero: boolean;
  private persistState: boolean;

  private seq = 0;
  private cursor: string | null = null;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private roster = new Map<string, RosterEntry>();
  private handlers: MsgHandler[] = [];
  private rejectHandlers: ((id: string) => void)[] = [];
  private ackHandlers: ((id: string) => void)[] = [];
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private outboundChain: Promise<void> = Promise.resolve();
  private saveCounter = 0;

  constructor(o: HostOpts) {
    this.card = o.card;
    this.t = o.transport;
    this.dataDir = path.join(o.dataDir, sanitize(o.card.name));
    this.topics = new Set(o.topics ?? []);
    this.heartbeatMs = o.heartbeatMs ?? 10000;
    this.identity = o.identity;
    this.zone = o.zone;
    this.replayFromZero = o.replayFromZero ?? false;
    this.persistState = o.persistState ?? true;
  }

  /** Register a sink for messages addressed to this agent. */
  onMessage(h: MsgHandler) {
    this.handlers.push(h);
  }

  /** Register a sink notified when the server rejected one of OUR published envelopes (by id). */
  onReject(h: (id: string) => void) {
    this.rejectHandlers.push(h);
  }

  /** Register a sink notified when the server positively ACKed one of OUR publishes (by id). */
  onAck(h: (id: string) => void) {
    this.ackHandlers.push(h);
  }

  /** Known agents and whether they are currently online (heartbeat within 3 beats). */
  getRoster(): (AgentCard & { online: boolean })[] {
    const now = Date.now();
    // Liveness is judged against OUR heartbeat interval, but a peer may beat slower than we do —
    // a generous floor keeps a slower-beating-but-alive agent from flickering offline between beats.
    const window = Math.max(this.heartbeatMs * 3, 90_000);
    return [...this.roster.values()].map((r) => ({
      ...r.card,
      online: now - r.lastSeen < window,
    }));
  }

  subscribe(topic: string) {
    this.topics.add(topic);
  }

  /** True in secure mode (this host signs + the server enforces/acks) → board claims are
   *  ack-confirmed rather than best-effort min-ULID. */
  get secure(): boolean {
    return !!this.identity;
  }

  /** Force a full replay from the durable log on (re)start instead of resuming from the saved
   *  cursor. A convergent overlay (TaskBoard) holds its reduced state only in memory, so on a
   *  fresh process it must re-read the WHOLE log to rebuild — a saved cursor would skip the
   *  history it needs. Call before start(). (The server hub does the same for its board.) */
  requireFullReplay(): void {
    this.replayFromZero = true;
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
    this.t.onReject?.((id) => {
      for (const cb of this.rejectHandlers) cb(id);
    });
    this.t.onAck?.((id) => {
      for (const cb of this.ackHandlers) cb(id);
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
      zone?: string; // override the host's default zone (must be one the agent belongs to);
      // lets a MULTI-ZONE agent answer into the right zone instead of always its first zone
      wantAck?: boolean; // ask the server to positively confirm acceptance (→ onAck)
    } = {},
  ): Promise<Envelope> {
    let env = makeEnvelope({ from: this.card.id, to, seq: ++this.seq, ...opts });
    const zone = opts.zone ?? this.zone;
    if (zone) env.zone = zone;
    if (this.identity) env = signEnvelope(env, this.identity.privateKey);
    this.markSeen(env.id); // never deliver our own message back to ourselves
    this.scheduleSave();
    // Fire the publish synchronously (the ws.send runs before the first await) so concurrent
    // fire-and-forget sends go on the wire in seq/call order. The WAL append is SERIALIZED on a
    // chain — ordered, and no appendFile storm — but does not gate the publish.
    const pub = this.t.publish(env, opts.wantAck);
    this.outboundChain = this.outboundChain
      .then(() => this.append("outbound.ndjson", env))
      .catch((e) => console.error("[conclave] outbound WAL error:", e));
    await pub;
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
      body: { ...this.card }, // SNAPSHOT — never sign a live reference (setStatus mutates the card;
      // a queued presence beat flushed after a status change would otherwise fail verification)
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
    if (!card || !card.id) return;
    // Use the beat's OWN timestamp, not receipt time — so a REPLAYED historical presence beat
    // (from the durable log on a fresh connect) reflects when the agent actually beat and ages out
    // correctly, instead of every ever-seen agent looking "online". max() guards out-of-order replay.
    const ts = typeof e.ts === "number" ? e.ts : Date.now();
    const prev = this.roster.get(card.id);
    this.roster.set(card.id, { card, lastSeen: Math.max(ts, prev?.lastSeen ?? 0) });
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
      // replayFromZero: keep cursor=null + empty seen so start() does a FULL replay and the
      // in-memory board rebuilds from the whole durable log (otherwise a restored cursor points
      // past every event and the board would stay empty).
      if (!this.replayFromZero) {
        this.cursor = s.cursor ?? null;
        this.seenOrder = s.seen ?? [];
        this.seen = new Set(this.seenOrder);
      }
      for (const r of s.roster ?? []) this.roster.set(r.card.id, { card: r.card, lastSeen: 0 });
    } catch {
      /* fresh start */
    }
  }

  private saveFailures = 0;
  private scheduleSave(): Promise<void> {
    if (!this.persistState) return Promise.resolve(); // one-shot senders never advance the on-disk cursor
    this.saveChain = this.saveChain
      .then(() => this.flush())
      .then(() => { this.saveFailures = 0; })
      .catch((e) => {
        // A persistent save failure means cursor+seen aren't durable → on the next reconnect the host
        // re-replays and RE-DELIVERS already-handled messages. Surface it loudly (not a silent one-off).
        this.saveFailures++;
        if (this.saveFailures === 1 || this.saveFailures % 10 === 0)
          console.error(`[conclave] STATE SAVE FAILING (${this.saveFailures}x) — cursor not durable, duplicate delivery likely: ${(e as Error).message}`);
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
    // BOTH the tmp write and the atomic rename can hit EPERM/EACCES/EBUSY on Windows (AV / indexer /
    // a concurrent reader). Retry both — covering only the rename left writeFile able to fail straight
    // through, dropping the cursor → duplicate delivery, the exact failure the retry was added for.
    await withSaveRetry(() => fs.writeFile(tmp, JSON.stringify(s)));
    try {
      await withSaveRetry(() => fs.rename(tmp, dst));
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {}); // don't leak the tmp on a hard failure
      throw e;
    }
  }
}

async function withSaveRetry<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EACCES" || code === "EBUSY") && attempt < 10) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
