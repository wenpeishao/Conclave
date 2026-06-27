import { WebSocketServer, type WebSocket } from "ws";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Envelope } from "../core/types.js";
import { randomToken } from "../core/identity.js";
import { decodeUlidTime } from "../core/ulid.js";

/**
 * The relay: a tiny broadcast hub with a durable append-only log.
 *
 * Wire frames (JSON):
 *   client -> server : { t:"hello", cursor } | { t:"pub", env }
 *   server -> client : { t:"env", env, cursor }
 *
 * cursor == line index in the log. On "hello", we replay every line past the
 * client's cursor, then add it to the live fan-out. Persistence means the relay
 * can restart and clients re-sync from where they were. It is intentionally
 * single-process (PoC scale) — for HA, point the same node hosts at the GitBus
 * transport instead, or run NATS behind a future transport.
 */
export interface RelayOpts {
  port: number; // 0 = pick a free port (read it back via .port())
  logFile: string;
  token?: string; // if set, clients must connect with ?token=<token> or are refused
}

/** What the relay knows about an authenticated connection — drives scoped routing. */
export interface ConnBinding {
  id: string; // the authenticated agent id this socket speaks for
  zones: string[]; // zone memberships → which zone-scoped traffic it receives
  wildcard?: boolean; // receives everything (the hub / control plane)
}

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private logFile: string;
  private wantPort: number;
  private count = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private token?: string;
  private verify?: (env: Envelope) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;
  private replayVerify?: (env: Envelope) => boolean;
  private authenticate?: (hello: { id?: string; cursor?: string | null; nonce?: string; sig?: string }) => ConnBinding | null;
  private bindings = new Map<WebSocket, ConnBinding>();
  private challenges = new Map<WebSocket, string>(); // per-connection one-time nonce
  // Anti-replay: two rotating sets swapped every freshnessMs, so an id is remembered for at
  // least one full freshness window (covering the replay window) with bounded memory.
  private recentA = new Set<string>();
  private recentB = new Set<string>();
  private rotateTimer: ReturnType<typeof setInterval> | null = null;
  private freshnessMs = 600000; // ±10 min clock window for accepting an envelope
  private rates = new Map<WebSocket, { n: number; t: number }>(); // per-connection pub rate
  private maxPubPerSec = 300;
  private handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private maxConnections = 2000;

  constructor(o: RelayOpts) {
    this.wantPort = o.port;
    this.logFile = o.logFile;
    this.token = o.token;
  }

  /** Install an authorization gate: a publish that fails it is dropped (never logged or broadcast). */
  onVerify(fn: (env: Envelope) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>) {
    this.verify = fn;
  }

  /**
   * Turn on SCOPED ROUTING. With this set, a connection must authenticate its `hello`
   * (returning its id + zones); thereafter the relay delivers each envelope only to the
   * connections that should receive it (directed → that agent; zone topic → zone members;
   * "*"/global → everyone) instead of broadcasting to all. Without it, the relay
   * broadcasts to every client (legacy behavior) and clients filter locally.
   */
  onAuthenticate(fn: (hello: { id?: string; cursor?: string | null; nonce?: string; sig?: string }) => ConnBinding | null) {
    this.authenticate = fn;
  }

  /** Re-verify each stored line before replaying it, so a forged/unsigned historical line is
   *  never served as authentic to a (re)connecting client. */
  onReplayVerify(fn: (env: Envelope) => boolean) {
    this.replayVerify = fn;
  }

  /**
   * Force-close every live socket bound to an agent id (returns how many). Revocation must drop the
   * connection, not just the registry record — otherwise a revoked/compromised key that simply keeps
   * its socket open keeps RECEIVING every directed message and zone broadcast (routeOk reads the
   * persisted binding, not the registry). Returns the number of sockets closed.
   */
  closeAgent(id: string): number {
    let n = 0;
    for (const [ws, b] of this.bindings) {
      if (b.id === id) {
        sendFrame(ws, { t: "err", reason: "revoked" });
        ws.close(1008, "revoked");
        n++;
      }
    }
    return n;
  }

  port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === "object" ? addr.port : this.wantPort;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
    this.count = await countLines(this.logFile);
    this.wss = new WebSocketServer({ port: this.wantPort, maxPayload: 512 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConn(ws, req));
    this.rotateTimer = setInterval(() => {
      this.recentB = this.recentA;
      this.recentA = new Set();
    }, this.freshnessMs);
    if (this.rotateTimer.unref) this.rotateTimer.unref();
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", () => resolve());
      this.wss!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.rotateTimer) clearInterval(this.rotateTimer);
    for (const t of this.handshakeTimers.values()) clearTimeout(t);
    this.handshakeTimers.clear();
    for (const c of this.clients) c.close();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  private onConn(ws: WebSocket, req: IncomingMessage) {
    if (this.token) {
      const got = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
      if (got !== this.token) {
        ws.close(1008, "unauthorized");
        return;
      }
    }
    // Bound total concurrent connections (so the per-connection rate limit can't be multiplied
    // by opening unlimited sockets, and half-open sockets can't exhaust memory).
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, "server at capacity");
      return;
    }
    this.clients.add(ws);
    // Handshake deadline: a socket that never completes a valid hello is reaped (slowloris guard).
    this.handshakeTimers.set(
      ws,
      setTimeout(() => ws.close(1008, "handshake timeout"), 10000),
    );
    // Secure mode: issue a one-time challenge nonce. The client must echo it in a signed
    // hello, so a captured hello cannot be replayed to bind a different socket to an id.
    if (this.authenticate) {
      const nonce = randomToken(16);
      this.challenges.set(ws, nonce);
      sendFrame(ws, { t: "challenge", nonce });
    }
    ws.on("message", (data) => {
      let msg: { t?: string; cursor?: string | null; env?: Envelope; id?: string; nonce?: string; sig?: string; ack?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === "hello") void this.onHello(ws, msg);
      else if (msg.t === "pub" && msg.env) void this.handlePub(ws, msg.env, msg.ack === true);
    });
    const drop = () => {
      this.clients.delete(ws);
      this.bindings.delete(ws);
      this.challenges.delete(ws);
      this.rates.delete(ws);
      const t = this.handshakeTimers.get(ws);
      if (t) {
        clearTimeout(t);
        this.handshakeTimers.delete(ws);
      }
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  private async onHello(ws: WebSocket, msg: { id?: string; cursor?: string | null; nonce?: string; sig?: string }) {
    const ht = this.handshakeTimers.get(ws); // handshake reached — cancel the reaper
    if (ht) {
      clearTimeout(ht);
      this.handshakeTimers.delete(ws);
    }
    if (this.authenticate) {
      const expected = this.challenges.get(ws);
      this.challenges.delete(ws); // one-time
      if (!expected || msg.nonce !== expected) {
        sendFrame(ws, { t: "err", reason: "missing or stale challenge nonce" });
        ws.close(1008, "unauthorized");
        return;
      }
      const binding = this.authenticate(msg);
      if (!binding) {
        sendFrame(ws, { t: "err", reason: "connection authentication failed" });
        ws.close(1008, "unauthorized");
        return;
      }
      this.bindings.set(ws, binding);
    }
    await this.replay(ws, msg.cursor ?? null);
  }

  /** Scoped routing: should this connection receive this envelope? Deny-by-default. */
  private routeOk(ws: WebSocket, env: Envelope): boolean {
    if (!this.authenticate) return true; // legacy: broadcast to all, clients filter locally
    const b = this.bindings.get(ws);
    if (!b) return false; // unauthenticated socket in scoped mode receives nothing
    if (b.wildcard) return true; // the hub / control plane sees everything
    if (env.to === "*") return true; // global discovery broadcast
    if (!Array.isArray(env.to)) return false;
    // Discovery plane is global — but ONLY for a PURE discovery envelope, so a work payload
    // can't ride along by co-listing topic://presence with a secret topic.
    const isDiscovery = (t: string) => t === "topic://presence" || t === "topic://discovery";
    if (env.kind === "presence" || env.to.every(isDiscovery)) return true;
    if (env.to.includes(b.id)) return true; // directed to this agent (crosses zones intentionally)
    if (env.to.some((t) => t.startsWith("topic://"))) {
      // Work topic: zone-scoped → members only; un-zoned → only from global (zone-less) senders.
      return env.zone == null || b.zones.includes(env.zone);
    }
    return false;
  }

  private async replay(ws: WebSocket, cursor: string | null) {
    const from = cursor ? Number(cursor) : 0;
    if (!existsSync(this.logFile)) return;
    const rl = readline.createInterface({ input: createReadStream(this.logFile), crlfDelay: Infinity });
    let i = 0;
    for await (const line of rl) {
      i++;
      if (i <= from || !line.trim()) continue;
      try {
        const env = JSON.parse(line) as Envelope;
        if (this.replayVerify && !this.replayVerify(env)) continue; // don't serve forged history
        if (this.routeOk(ws, env)) sendFrame(ws, { t: "env", env, cursor: String(i) });
      } catch {
        /* skip corrupt line */
      }
    }
  }

  private async handlePub(ws: WebSocket, env: Envelope, wantAck = false): Promise<void> {
    // Per-connection rate limit, checked BEFORE the expensive signature verify, so a flood of
    // bogus frames can't pin the CPU (asymmetric-work DoS).
    const now0 = Date.now();
    const r = this.rates.get(ws);
    if (!r || now0 - r.t >= 1000) this.rates.set(ws, { n: 1, t: now0 });
    else if (++r.n > this.maxPubPerSec) {
      sendFrame(ws, { t: "err", reason: "rate limit exceeded", id: env.id });
      return;
    }
    // Freshness: ts must be present, parseable, and within the clock window (a missing/garbage
    // ts must NOT skip the check). Bounds how long a captured envelope can be replayed.
    const now = Date.now();
    const ts = Date.parse(env.ts);
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.freshnessMs) {
      sendFrame(ws, { t: "err", reason: "stale or malformed ts", id: env.id });
      return;
    }
    // env.id must be a real ULID whose embedded time is fresh AND agrees with env.ts (within a
    // tight bound) — so it can't be back-dated independently of ts. (Board ownership no longer
    // relies on this id; first-claim-wins is enforced server-side. This is defense-in-depth.)
    const idTime = decodeUlidTime(env.id);
    if (!Number.isFinite(idTime) || Math.abs(now - idTime) > this.freshnessMs || Math.abs(idTime - ts) > 60000) {
      sendFrame(ws, { t: "err", reason: "envelope id is not a fresh ULID consistent with ts", id: env.id });
      return;
    }
    // Replay: reserve the id synchronously BEFORE the await so two identical ids in flight can't
    // both pass the check (a burned id is never legitimately reused, so no rollback is needed).
    if (this.recentA.has(env.id) || this.recentB.has(env.id)) {
      sendFrame(ws, { t: "err", reason: "duplicate envelope id", id: env.id });
      return;
    }
    this.markRecent(env.id);
    if (this.verify) {
      const v = await this.verify(env);
      if (!v.ok) {
        sendFrame(ws, { t: "err", reason: v.reason ?? "unauthorized", id: env.id });
        return;
      }
    }
    // Positive ACK so a claimer knows it is the CONFIRMED owner. Sent right after authorization
    // (the claim is already accepted — claimedTasks is set in verify), NOT gated behind the
    // durable append/broadcast, so a claimer isn't left waiting under load and orphaning the task.
    // Only in authorized (secure) mode, where exactly one claim per task is accepted — in legacy
    // mode there is no such server-side exclusivity, so the board falls back to min-ULID.
    if (wantAck && this.verify) sendFrame(ws, { t: "ack", id: env.id });
    await this.publish(env);
  }

  private markRecent(id: string) {
    this.recentA.add(id);
    // Bound memory: if a flood inflates the active set, rotate early (the displaced set still
    // covers one freshness window, so replay protection holds).
    if (this.recentA.size > 200000) {
      this.recentB = this.recentA;
      this.recentA = new Set();
    }
  }

  private publish(env: Envelope): Promise<void> {
    // Serialize appends so line index == cursor stays consistent under concurrency.
    this.appendChain = this.appendChain.then(async () => {
      await fs.appendFile(this.logFile, JSON.stringify(env) + "\n");
      this.count++;
      const frame = { t: "env" as const, env, cursor: String(this.count) };
      for (const c of this.clients) if (c.readyState === c.OPEN && this.routeOk(c, env)) sendFrame(c, frame);
    });
    return this.appendChain;
  }
}

type ServerFrame =
  | { t: "env"; env: Envelope; cursor: string }
  | { t: "challenge"; nonce: string }
  | { t: "ack"; id: string }
  | { t: "err"; reason: string; id?: string };

function sendFrame(ws: WebSocket, frame: ServerFrame) {
  ws.send(JSON.stringify(frame));
}

async function countLines(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  let n = 0;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  return n;
}
