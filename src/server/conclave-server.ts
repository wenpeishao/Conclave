import * as http from "node:http";
import * as path from "node:path";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as readline from "node:readline";
import { RelayServer } from "../relay/server.js";
import { NodeHost } from "../node/host.js";
import { RelayWSTransport } from "../transports/relay-ws.js";
import { TaskBoard, type Task } from "../agent/task-board.js";
import type { Envelope } from "../core/types.js";

/**
 * ConclaveServer — a deployable coordination backend. One process, three jobs:
 *
 *   1. BUS + PRESENCE (real-time): the WebSocket relay agents connect to, with a durable
 *      append-only log of every envelope.
 *   2. TASKS + CONVERSATIONS (queryable): an HTTP API over a server-side TaskBoard (which
 *      is itself a bus participant, so it stays consistent with every agent's board) plus
 *      a message-history endpoint backed by the relay log.
 *   3. DATA EXCHANGE: a content-addressed blob store. Big payloads are PUT once, fetched by
 *      sha256, and referenced from bus messages as `conclave://blobs/<sha256>` — so the bus
 *      carries the reference and the server brokers the bytes (never the bus).
 *
 * Deploy it anywhere both sides can reach (a VM, a tailscale node, or behind a tunnel);
 * agents speak WS for live coordination and HTTP for tasks/history/blobs.
 */
export interface ConclaveServerOpts {
  wsPort: number; // 0 = pick free
  httpPort: number; // 0 = pick free
  dataDir: string; // holds relay.log, blobs/, board host state
  token?: string; // shared secret; if set, WS + HTTP both require it
}

export class ConclaveServer {
  private relay: RelayServer;
  private host: NodeHost;
  private board: TaskBoard;
  private httpServer: http.Server | null = null;
  private logFile: string;
  private blobsDir: string;
  private dataDir: string;
  private wantHttpPort: number;
  private token?: string;

  constructor(o: ConclaveServerOpts) {
    this.dataDir = o.dataDir;
    this.logFile = path.join(o.dataDir, "relay.log");
    this.blobsDir = path.join(o.dataDir, "blobs");
    this.wantHttpPort = o.httpPort;
    this.token = o.token;
    this.relay = new RelayServer({ port: o.wsPort, logFile: this.logFile, token: o.token });
    // The internal board participant is wired after the relay is up (needs its port).
    this.host = null as unknown as NodeHost;
    this.board = null as unknown as TaskBoard;
  }

  wsPort(): number {
    return this.relay.port();
  }
  httpPort(): number {
    const a = this.httpServer?.address();
    return a && typeof a === "object" ? a.port : this.wantHttpPort;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.blobsDir, { recursive: true });
    await this.relay.start();
    // A loopback bus participant that owns the canonical board view.
    this.host = new NodeHost({
      card: { id: "agent://hub", name: "hub", capabilities: ["server"] },
      transport: new RelayWSTransport(`ws://127.0.0.1:${this.relay.port()}`, this.token),
      dataDir: path.join(this.dataDir, "hub"),
      heartbeatMs: 15000,
    });
    this.board = new TaskBoard(this.host);
    await this.host.start();

    this.httpServer = http.createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(this.wantHttpPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.httpServer ? this.httpServer.close(() => r()) : r()));
    await this.host.stop();
    await this.relay.stop();
  }

  // ---- HTTP API ----------------------------------------------------------
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // Unauthenticated liveness probe (no sensitive data) — for container HEALTHCHECK / LBs.
    if (req.method === "GET" && p === "/healthz") return send(200, { ok: true });

    // Shared-token auth (Authorization: Bearer <t>, or x-conclave-token, or ?token=).
    if (this.token) {
      const auth = req.headers["authorization"];
      const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const got = bearer ?? (req.headers["x-conclave-token"] as string | undefined) ?? url.searchParams.get("token") ?? undefined;
      if (got !== this.token) return send(401, { error: "unauthorized" });
    }

    // status
    if (req.method === "GET" && p === "/") {
      return send(200, {
        service: "conclave-server",
        ws: `ws://0.0.0.0:${this.wsPort()}`,
        roster: this.host.getRoster(),
        tasks: this.board.list().length,
      });
    }

    // tasks
    if (req.method === "GET" && p === "/tasks") {
      const role = url.searchParams.get("role") ?? undefined;
      const open = url.searchParams.get("open") === "1";
      const tasks = open ? this.board.open(role ?? undefined) : this.board.list();
      return send(200, { tasks });
    }
    if (req.method === "POST" && p === "/tasks") {
      const body = await readJson(req);
      const title = String(body.title ?? "");
      if (!title) return send(400, { error: "title required" });
      const id = await this.board.add(title, body.for ? { for: String(body.for) } : {});
      return send(200, { id });
    }
    const claimM = p.match(/^\/tasks\/([^/]+)\/(claim|done)$/);
    if (req.method === "POST" && claimM) {
      const id = claimM[1];
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      if (claimM[2] === "claim") await this.board.claim(id);
      else await this.board.done(id, body.result !== undefined ? String(body.result) : undefined);
      return send(200, { ok: true });
    }

    // conversation history (message-like envelopes from the durable log)
    if (req.method === "GET" && p === "/messages") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      const msgs = await this.readMessages(since);
      return send(200, { messages: msgs, cursor: since + msgs.length });
    }
    // inject a message onto the bus from an HTTP client (a dashboard / webhook)
    if (req.method === "POST" && p === "/messages") {
      const body = await readJson(req);
      const to = body.to;
      if (!to) return send(400, { error: "to required" });
      const recipients = to === "*" ? ("*" as const) : [String(to).startsWith("agent://") ? String(to) : `agent://${to}`];
      const sent = await this.host.send(recipients, {
        body: body.body,
        subject: body.subject ? String(body.subject) : undefined,
        kind: (body.kind as Envelope["kind"]) ?? "message",
      });
      return send(200, { id: sent.id });
    }

    // blobs (data exchange) — content-addressed by sha256
    if (req.method === "POST" && p === "/blobs") {
      const buf = await readBody(req);
      const sha = createHash("sha256").update(buf).digest("hex");
      await fs.writeFile(path.join(this.blobsDir, sha), buf);
      return send(200, { sha256: sha, size: buf.length, uri: `conclave://blobs/${sha}` });
    }
    const blobM = p.match(/^\/blobs\/([a-f0-9]{64})$/);
    if (req.method === "GET" && blobM) {
      const file = path.join(this.blobsDir, blobM[1]);
      if (!existsSync(file)) return send(404, { error: "blob not found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      createReadStream(file).pipe(res);
      return;
    }
    if (req.method === "GET" && p === "/blobs") {
      const list = existsSync(this.blobsDir) ? await fs.readdir(this.blobsDir) : [];
      return send(200, { blobs: list });
    }

    send(404, { error: "not found" });
  }

  private async readMessages(since: number): Promise<Envelope[]> {
    if (!existsSync(this.logFile)) return [];
    const out: Envelope[] = [];
    const rl = readline.createInterface({ input: createReadStream(this.logFile), crlfDelay: Infinity });
    let i = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      i++;
      if (i <= since) continue;
      try {
        const e = JSON.parse(line) as Envelope;
        if (e.kind === "message" || e.kind === "response" || e.kind === "request" || e.kind === "event") out.push(e);
      } catch {
        /* skip */
      }
    }
    return out;
  }

  list(): Task[] {
    return this.board.list();
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString()) as Record<string, unknown>;
}
