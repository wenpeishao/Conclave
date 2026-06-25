import { WebSocketServer, type WebSocket } from "ws";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Envelope } from "../core/types.js";

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

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private logFile: string;
  private wantPort: number;
  private count = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private token?: string;
  private verify?: (env: Envelope) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>;

  constructor(o: RelayOpts) {
    this.wantPort = o.port;
    this.logFile = o.logFile;
    this.token = o.token;
  }

  /** Install an authorization gate: a publish that fails it is dropped (never logged or broadcast). */
  onVerify(fn: (env: Envelope) => { ok: boolean; reason?: string } | Promise<{ ok: boolean; reason?: string }>) {
    this.verify = fn;
  }

  port(): number {
    const addr = this.wss?.address();
    return addr && typeof addr === "object" ? addr.port : this.wantPort;
  }

  async start(): Promise<void> {
    await fs.mkdir(path.dirname(this.logFile), { recursive: true });
    this.count = await countLines(this.logFile);
    this.wss = new WebSocketServer({ port: this.wantPort });
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
    ws.on("message", (data) => {
      let msg: { t?: string; cursor?: string | null; env?: Envelope };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.t === "hello") void this.replay(ws, msg.cursor ?? null);
      else if (msg.t === "pub" && msg.env) void this.handlePub(ws, msg.env);
    });
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
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
        sendFrame(ws, { t: "env", env, cursor: String(i) });
      } catch {
        /* skip corrupt line */
      }
    }
  }

  private async handlePub(ws: WebSocket, env: Envelope): Promise<void> {
    if (this.verify) {
      const v = await this.verify(env);
      if (!v.ok) {
        // Tell the sender its message was rejected, then drop it.
        sendFrame(ws, { t: "err", reason: v.reason ?? "unauthorized", id: env.id });
        return;
      }
    }
    await this.publish(env);
  }

  private publish(env: Envelope): Promise<void> {
    // Serialize appends so line index == cursor stays consistent under concurrency.
    this.appendChain = this.appendChain.then(async () => {
      await fs.appendFile(this.logFile, JSON.stringify(env) + "\n");
      this.count++;
      const frame = { t: "env" as const, env, cursor: String(this.count) };
      for (const c of this.clients) if (c.readyState === c.OPEN) sendFrame(c, frame);
    });
    return this.appendChain;
  }
}

type ServerFrame =
  | { t: "env"; env: Envelope; cursor: string }
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
