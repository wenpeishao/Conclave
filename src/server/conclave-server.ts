import * as http from "node:http";
import * as path from "node:path";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import * as readline from "node:readline";
import { RelayServer, type ConnBinding } from "../relay/server.js";
import { NodeHost } from "../node/host.js";
import { RelayWSTransport } from "../transports/relay-ws.js";
import { TaskBoard, isTaskOp, type Task } from "../agent/task-board.js";
import type { Envelope, AgentCard } from "../core/types.js";
import { AgentRegistry } from "./registry.js";
import { generateIdentity, verifyData, signData, type Identity } from "../core/identity.js";

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
  adminToken?: string; // if set, turns on SECURE MODE: per-agent enrolled identities +
  // ed25519-signed envelopes are required, and /admin/* endpoints are gated by this token
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
  private adminToken?: string;
  private registry?: AgentRegistry;
  private hubIdentity?: Identity;
  // Streaming relay rendezvous: a channel waits for its other half, then bytes pipe
  // straight through (sender request body -> receiver response body). Nothing is stored.
  private waitingRecv = new Map<string, http.ServerResponse>();
  private waitingSend = new Map<string, { req: http.IncomingMessage; reply: (code: number) => void }>();
  private relayWaitMs = 120000;

  constructor(o: ConclaveServerOpts) {
    this.dataDir = o.dataDir;
    this.logFile = path.join(o.dataDir, "relay.log");
    this.blobsDir = path.join(o.dataDir, "blobs");
    this.wantHttpPort = o.httpPort;
    this.token = o.token;
    this.adminToken = o.adminToken;
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

    // SECURE MODE: an admin token turns on per-agent identity + signature enforcement.
    if (this.adminToken && !this.token) {
      throw new Error(
        "secure mode (--admin-token) also requires a connect token (--token): without it the WS bus " +
          "accepts anonymous connections (full read of all traffic) and bus-mutating HTTP endpoints are ungated.",
      );
    }
    if (this.adminToken) {
      this.registry = new AgentRegistry(this.dataDir);
      await this.registry.load();
      this.hubIdentity = await this.loadOrMakeHubIdentity();
      // Trust the hub's own key so its presence/board envelopes pass verification.
      if (!this.registry.get(this.hubIdentity.id)) {
        const inv = this.registry.invite({ name: "hub", role: "server", canRun: true });
        this.registry.enroll(inv.token, this.hubIdentity.publicKey, signData(this.hubIdentity.privateKey, inv.token));
      }
      // Gate every publish: valid signature from a known agent (identity) AND the action is
      // allowed for that agent's role/zone (policy). The registry record is consumed here,
      // not discarded — that is what makes role/canRun/zone real instead of decorative.
      this.relay.onVerify((env) => this.authorizePolicy(env));
      // Bind each connection to its authenticated identity + zones → scoped routing
      // (directed/zone/global) instead of broadcast-to-all.
      this.relay.onAuthenticate((hello) => this.authenticateConn(hello));
      // Never replay a forged/unsigned historical line as authentic (e.g. a legacy log).
      this.relay.onReplayVerify((env) => this.registry!.authorize(env).ok);
    }

    await this.relay.start();
    // A loopback bus participant that owns the canonical board view.
    this.host = new NodeHost({
      card: { id: "agent://hub", name: "hub", capabilities: ["server"] },
      transport: new RelayWSTransport(`ws://127.0.0.1:${this.relay.port()}`, this.token, this.hubIdentity),
      dataDir: path.join(this.dataDir, "hub"),
      heartbeatMs: 15000,
      identity: this.hubIdentity,
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

  /**
   * The secure-mode authorization policy — runs on every publish. Identity first (signature
   * by a known, non-revoked key), then ACTION authorization using the agent's registry record:
   *   - presence may only advertise the sender's OWN id (no roster spoofing);
   *   - a task claim requires the claimer's role to match the task's `for` role;
   *   - a task done may only come from the agent that holds the claim;
   *   - zone-scoped envelopes must be stamped with a zone the sender belongs to.
   * The hub (the server's own identity) is the trusted control plane and bypasses action checks.
   */
  private authorizePolicy(env: Envelope): { ok: boolean; reason?: string } {
    const decision = this.registry!.authorize(env);
    if (!decision.ok || !decision.record) return decision;
    const rec = decision.record;
    if (env.from === this.hubIdentity?.id) return { ok: true }; // trusted control plane

    // A sender may only stamp a zone it is a member of (enables safe zone routing).
    if (env.zone && !(rec.zones ?? []).includes(env.zone)) {
      return { ok: false, reason: `not a member of ${env.zone}` };
    }
    // Presence cannot impersonate another agent's roster entry (fixes roster spoofing).
    if (env.kind === "presence") {
      const card = env.body as AgentCard | undefined;
      if (!card || card.id !== env.from) return { ok: false, reason: "presence id must equal from" };
    }
    // Board action authorization — role/canRun are enforced here, not just advised client-side.
    if (env.kind === "event" && env.subject === "task" && isTaskOp(env.body)) {
      const op = env.body;
      if (op.op === "claim") {
        const task = this.board.list().find((t) => t.id === op.id);
        if (task?.for && task.for !== rec.role) {
          return { ok: false, reason: `role '${rec.role ?? "-"}' may not claim a task for '${task.for}'` };
        }
      } else if (op.op === "done") {
        const task = this.board.list().find((t) => t.id === op.id);
        if (task?.claimedBy && task.claimedBy !== env.from) {
          return { ok: false, reason: "only the claiming agent may complete a task" };
        }
      }
    }
    return { ok: true };
  }

  /** Authenticate a connection's signed, timestamped hello → its routing binding, or null. */
  private authenticateConn(hello: { id?: string; cursor?: string | null; ts?: string; sig?: string }): ConnBinding | null {
    if (!hello.id || !hello.sig) return null;
    const t = Date.parse(hello.ts ?? "");
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 600000) return null; // freshness → bounds hello replay
    const rec = this.registry!.get(hello.id);
    if (!rec || rec.revoked) return null;
    if (!verifyData(rec.publicKey, { id: hello.id, cursor: hello.cursor ?? null, ts: hello.ts }, hello.sig)) return null;
    return { id: hello.id, zones: rec.zones ?? [], wildcard: hello.id === this.hubIdentity?.id };
  }

  private async loadOrMakeHubIdentity(): Promise<Identity> {
    const file = path.join(this.dataDir, "hub-identity.json");
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as Identity;
    } catch {
      const id = generateIdentity("hub");
      await fs.writeFile(file, JSON.stringify(id));
      return id;
    }
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
    // Admin + enrollment endpoints carry their OWN credentials (admin token / one-time
    // enrollment token), so they bypass the coarse connect-token gate.
    const authBearer = (() => {
      const auth = req.headers["authorization"];
      return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    })();
    const presented = authBearer ?? (req.headers["x-conclave-token"] as string | undefined) ?? url.searchParams.get("token") ?? undefined;
    const adminPresented = (req.headers["x-conclave-admin"] as string | undefined) ?? authBearer;
    const isAdmin = !!this.adminToken && adminPresented === this.adminToken;

    const selfAuthed = p === "/enroll" || p.startsWith("/admin/");
    if (this.token && !selfAuthed) {
      // The admin token is strictly more privileged, so it also satisfies the connect gate.
      if (presented !== this.token && !isAdmin) return send(401, { error: "unauthorized" });
    }
    // In secure mode, endpoints that publish bus traffic AS THE HUB are admin-only — a mere
    // connect-token holder must not be able to launder content into hub-signed envelopes.
    const busMutating =
      (req.method === "POST" && (p === "/tasks" || p === "/messages")) ||
      (req.method === "POST" && /^\/tasks\/[^/]+\/(claim|done)$/.test(p));
    if (this.registry && busMutating && !isAdmin) {
      return send(403, { error: "secure mode: bus-mutating HTTP endpoints require the admin token (agents publish over the signed bus instead)" });
    }

    // --- identity / enrollment (secure mode) ---
    // Device redeems a one-time enrollment token by registering its public key.
    if (req.method === "POST" && p === "/enroll") {
      if (!this.registry) return send(409, { error: "server not in secure mode" });
      const body = await readJson(req);
      const token = String(body.token ?? "");
      const publicKey = String(body.publicKey ?? "");
      const proof = body.proof ? String(body.proof) : undefined;
      if (!token || !publicKey) return send(400, { error: "token and publicKey required" });
      try {
        const rec = this.registry.enroll(token, publicKey, proof);
        return send(200, { id: rec.id, name: rec.name, role: rec.role, canRun: rec.canRun, zones: rec.zones });
      } catch (e) {
        return send(400, { error: (e as Error).message });
      }
    }
    // Admin endpoints — gated by the admin token (x-conclave-admin or Bearer).
    if (p === "/admin/invite" || p === "/admin/revoke" || p === "/admin/agents") {
      if (!this.registry || !this.adminToken) return send(409, { error: "server not in secure mode" });
      const auth = req.headers["authorization"];
      const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const admin = (req.headers["x-conclave-admin"] as string | undefined) ?? bearer;
      if (admin !== this.adminToken) return send(401, { error: "admin token required" });

      if (req.method === "GET" && p === "/admin/agents") {
        return send(200, { agents: this.registry.list() });
      }
      if (req.method === "POST" && p === "/admin/invite") {
        const body = await readJson(req);
        if (!body.name) return send(400, { error: "name required" });
        try {
          const inv = this.registry.invite({
            name: String(body.name),
            role: body.role ? String(body.role) : undefined,
            canRun: body.canRun === true,
            zones: Array.isArray(body.zones) ? body.zones.map(String) : undefined,
            ttlMs: body.ttlMs ? Number(body.ttlMs) : undefined,
          });
          return send(200, { enrollToken: inv.token, id: inv.id, role: inv.role, canRun: inv.canRun, zones: inv.zones, expTs: inv.expTs });
        } catch (e) {
          return send(400, { error: (e as Error).message });
        }
      }
      if (req.method === "POST" && p === "/admin/revoke") {
        const body = await readJson(req);
        const ok = this.registry.revoke(String(body.name ?? ""));
        return send(ok ? 200 : 404, ok ? { revoked: true } : { error: "agent not found" });
      }
      return send(405, { error: "method not allowed" });
    }

    // status
    if (req.method === "GET" && p === "/") {
      return send(200, {
        service: "conclave-server",
        secure: !!this.registry,
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
      const buf = await readBody(req, 64 * 1024 * 1024); // blobs are the data path — allow up to 64 MiB
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

    // STREAMING RELAY (data exchange, NOTHING STORED) — a rendezvous channel. The sender
    // (PUT/POST /relay/:ch) and receiver (GET /relay/:ch) meet on a channel name; the
    // server pipes the sender's body straight into the receiver's response (TCP backpressure,
    // no disk, ~one chunk in memory). Whoever arrives first waits (up to relayWaitMs) for
    // the other. Use this instead of /blobs when you don't want the server holding bytes.
    const relayM = p.match(/^\/relay\/([A-Za-z0-9._-]{1,128})$/);
    if (relayM) {
      const ch = relayM[1];
      if (req.method === "GET") return this.relayReceive(ch, res, send);
      if (req.method === "PUT" || req.method === "POST") return this.relaySend(ch, req, send);
      return send(405, { error: "use GET to receive, PUT/POST to send" });
    }

    send(404, { error: "not found" });
  }

  private relayReceive(ch: string, res: http.ServerResponse, send: (c: number, o: unknown) => void): void {
    const sender = this.waitingSend.get(ch);
    if (sender) {
      this.waitingSend.delete(ch);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      sender.req.pipe(res);
      sender.req.on("end", () => sender.reply(200));
      sender.req.on("error", () => { sender.reply(500); res.destroy(); });
      return;
    }
    // No sender yet — hold the receiver open until one arrives or we time out.
    if (this.waitingRecv.has(ch)) return send(409, { error: "channel busy" });
    this.waitingRecv.set(ch, res);
    const to = setTimeout(() => {
      if (this.waitingRecv.get(ch) === res) {
        this.waitingRecv.delete(ch);
        send(504, { error: "no sender within timeout" });
      }
    }, this.relayWaitMs);
    res.on("close", () => {
      clearTimeout(to);
      if (this.waitingRecv.get(ch) === res) this.waitingRecv.delete(ch);
    });
  }

  private relaySend(ch: string, req: http.IncomingMessage, send: (c: number, o: unknown) => void): void {
    const recv = this.waitingRecv.get(ch);
    if (recv) {
      this.waitingRecv.delete(ch);
      recv.writeHead(200, { "content-type": "application/octet-stream" });
      req.pipe(recv);
      req.on("end", () => send(200, { ok: true, relayed: true, stored: false }));
      req.on("error", () => { recv.destroy(); send(500, { error: "relay error" }); });
      return;
    }
    // No receiver yet — hold the sender's body (backpressured) until one arrives.
    if (this.waitingSend.has(ch)) return send(409, { error: "channel busy" });
    let to: ReturnType<typeof setTimeout>;
    let replied = false;
    const reply = (code: number) => {
      if (replied) return;
      replied = true;
      clearTimeout(to);
      send(code, code === 200 ? { ok: true, relayed: true, stored: false } : { error: "relay failed" });
    };
    this.waitingSend.set(ch, { req, reply });
    to = setTimeout(() => {
      if (this.waitingSend.get(ch)?.req === req) {
        this.waitingSend.delete(ch);
        reply(504);
      }
    }, this.relayWaitMs);
    req.on("close", () => {
      if (this.waitingSend.get(ch)?.req === req) this.waitingSend.delete(ch);
    });
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
        // In secure mode, only surface authentically-signed history (never forged log lines).
        if (this.registry && !this.registry.authorize(e).ok) continue;
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

// Bounded body read: aborts once the cumulative size exceeds `maxBytes`, so a single huge
// request can't OOM the process (the JSON endpoints stay small; /blobs gets a larger cap).
function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(c));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, 256 * 1024);
  if (!buf.length) return {};
  return JSON.parse(buf.toString()) as Record<string, unknown>;
}
