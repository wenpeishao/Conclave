import { WebSocketServer, type WebSocket } from "ws";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Envelope } from "../core/types.js";
import { randomToken } from "../core/identity.js";

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
  private recentIds = new Set<string>(); // anti-replay: ids already accepted
  private recentOrder: string[] = [];
  private freshnessMs = 600000; // ±10 min clock window for accepting an envelope
  private rates = new Map<WebSocket, { n: number; t: number }>(); // per-connection pub rate
  private maxPubPerSec = 300;

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

  port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === "object" ? addr.port : this.wantPort;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
    this.count = await countLines(this.logFile);
    this.wss = new WebSocketServer({ port: this.wantPort, maxPayload: 512 * 1024 });
    this.wss.on("connection", (ws, req) => this.onConn(ws, req));
    await new Promise<void>((resolve, reject) => {
      this.wss!.once("listening", () => resolve());
      this.wss!.once("error", reject);
    });
  }

  async stop(): Promise<void> {
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
    this.clients.add(ws);
    // Secure mode: issue a one-time challenge nonce. The client must echo it in a signed
    // hello, so a captured hello cannot be replayed to bind a different socket to an id.
    if (this.authenticate) {
      const nonce = randomToken(16);
      this.challenges.set(ws, nonce);
      sendFrame(ws, { t: "challenge", nonce });
    }
    ws.on("message", (data) => {
      let msg: { t?: string; cursor?: string | null; env?: Envelope; id?: string; nonce?: string; sig?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === "hello") void this.onHello(ws, msg);
      else if (msg.t === "pub" && msg.env) void this.handlePub(ws, msg.env);
    });
    const drop = () => {
      this.clients.delete(ws);
      this.bindings.delete(ws);
      this.challenges.delete(ws);
      this.rates.delete(ws);
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  private async onHello(ws: WebSocket, msg: { id?: string; cursor?: string | null; nonce?: string; sig?: string }) {
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
    // Discovery plane is global regardless of any zone stamp (roster + global queries).
    if (env.to.some((t) => t === "topic://presence" || t === "topic://discovery")) return true;
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

  private async handlePub(ws: WebSocket, env: Envelope): Promise<void> {
    // Per-connection rate limit, checked BEFORE the expensive signature verify, so a flood of
    // bogus frames can't pin the CPU (asymmetric-work DoS).
    const now0 = Date.now();
    const r = this.rates.get(ws);
    if (!r || now0 - r.t >= 1000) this.rates.set(ws, { n: 1, t: now0 });
    else if (++r.n > this.maxPubPerSec) {
      sendFrame(ws, { t: "err", reason: "rate limit exceeded", id: env.id });
      return;
    }
    // Freshness: reject envelopes whose timestamp is far outside the clock window. This bounds
    // how long a captured signed envelope can be replayed for.
    const ts = Date.parse(env.ts);
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > this.freshnessMs) {
      sendFrame(ws, { t: "err", reason: "stale envelope (outside freshness window)", id: env.id });
      return;
    }
    // Replay: an id we've already accepted cannot be re-published (verbatim replay defense).
    if (this.recentIds.has(env.id)) {
      sendFrame(ws, { t: "err", reason: "duplicate envelope id", id: env.id });
      return;
    }
    if (this.verify) {
      const v = await this.verify(env);
      if (!v.ok) {
        sendFrame(ws, { t: "err", reason: v.reason ?? "unauthorized", id: env.id });
        return;
      }
    }
    this.markRecent(env.id);
    await this.publish(env);
  }

  private markRecent(id: string) {
    this.recentIds.add(id);
    this.recentOrder.push(id);
    if (this.recentOrder.length > 50000) {
      const old = this.recentOrder.shift();
      if (old) this.recentIds.delete(old);
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
