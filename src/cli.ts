#!/usr/bin/env -S npx tsx
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { RelayServer } from "./relay/server.js";
import { NodeHost } from "./node/host.js";
import { buildTransport, type TransportConfig } from "./node/build.js";
import { AutonomousAgent } from "./agent/runtime.js";
import { startSelfUpdate } from "./node/self-update.js";
import { echoBrain } from "./agent/brains/rule.js";
import { generateIdentity, signData, type Identity } from "./core/identity.js";
import type { AgentCard, Envelope } from "./core/types.js";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const cmd = argv[0] ?? "help";
  const args: Args = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else if (args["_sub"] === undefined) {
      // first bare token after the command, e.g. `board add` -> _sub="add"
      args["_sub"] = a;
    }
  }
  return { cmd, args };
}

const str = (a: Args, k: string, d = ""): string => (typeof a[k] === "string" ? (a[k] as string) : d);
const dataHome = (a: Args): string => str(a, "data", path.join(os.homedir(), ".conclave"));
const CYAN = "[36m";
const RESET = "[0m";

function transportFromArgs(a: Args, agentName: string): TransportConfig {
  const kind = str(a, "transport", "relay") as "relay" | "git";
  if (kind === "git") {
    return {
      kind: "git",
      repoDir: str(a, "repo"),
      agentDir: str(a, "agent-dir", agentName),
      remote: a["remote"] !== false && a["local"] !== true,
      pollMs: a["poll"] ? Number(a["poll"]) : undefined,
    };
  }
  return { kind: "relay", url: str(a, "url", "ws://127.0.0.1:8787"), token: str(a, "token") || process.env.CONCLAVE_TOKEN || undefined };
}

type StoredIdentity = Identity & { zones?: string[] };

/** Load this device's enrolled identity (from --identity <file> or <data>/identity.json), if any. */
function deviceIdentity(a: Args): StoredIdentity | undefined {
  if (str(a, "identity") === "none") return undefined;
  const file = str(a, "identity") || path.join(dataHome(a), "identity.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredIdentity;
  } catch {
    return undefined;
  }
}

/**
 * Build a NodeHost from flags, injecting the enrolled identity (signs envelopes + the
 * connection hello) and the agent's zone (scopes its traffic) when present.
 */
function buildHost(a: Args, name: string, opts?: { persistState?: boolean }): NodeHost {
  const ident = deviceIdentity(a);
  const zone = ident?.zones?.[0] ?? (str(a, "zone") || undefined);
  const cfg = transportFromArgs(a, name);
  if (ident && cfg.kind === "relay") cfg.identity = ident;
  const card = makeCard(a, name);
  if (ident) {
    card.id = ident.id;
    card.name = ident.name;
  }
  return new NodeHost({ card, transport: buildTransport(cfg), dataDir: dataHome(a), identity: ident, zone, persistState: opts?.persistState });
}

function makeCard(a: Args, name: string): AgentCard {
  // Default id is the bare name so `--to <name>` just works. Pass --id agent://name@host
  // explicitly when you need to disambiguate two agents that share a name across devices.
  const caps = str(a, "capabilities") || str(a, "caps");
  return {
    id: str(a, "id", `agent://${name}`),
    name,
    device: { host: os.hostname() },
    model: a["model"] ? { runtime: str(a, "model") } : undefined,
    capabilities: caps ? caps.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    status: "available",
    realtime: str(a, "transport", "relay") === "git" ? "poll" : "push",
  };
}

// Built-in fleet self-update for the long-running node roles. ON by default so a deployed node
// stays on the latest pushed code with zero manual steps forever; --no-self-update to pin.
function maybeStartSelfUpdate(a: Args, canRestart?: () => boolean): () => void {
  if (a["no-self-update"] === true || process.env.CONCLAVE_NO_SELF_UPDATE) {
    console.log("[conclave] self-update OFF (--no-self-update)");
    return () => {};
  }
  const mins = a["self-update-interval"] ? Number(str(a, "self-update-interval")) : 60;
  console.log(`[conclave] self-update ON — checks origin/main every ${mins}m, restarts on change`);
  return startSelfUpdate({ intervalMs: mins * 60_000, canRestart });
}

async function cmdUp(a: Args) {
  const port = a["port"] ? Number(a["port"]) : 8787;
  const logFile = str(a, "log", path.join(dataHome(a), "relay.log"));
  const relay = new RelayServer({ port, logFile, token: str(a, "token") || process.env.CONCLAVE_TOKEN || undefined });
  await relay.start();
  console.log(`[conclave] relay listening on ws://0.0.0.0:${relay.port()}`);
  console.log(`[conclave] durable log: ${logFile}`);
  console.log(`[conclave] join it:  conclave join --as <name> --url ws://<this-host>:${relay.port()}`);
  process.on("SIGINT", () => {
    void relay.stop().then(() => process.exit(0));
  });
}

function printIncoming(e: Envelope) {
  const subj = e.subject ? ` [${e.subject}]` : "";
  const body = typeof e.body === "string" ? e.body : JSON.stringify(e.body);
  process.stdout.write(`\n${CYAN}<- ${e.from}${RESET}${subj} (${e.kind})\n  ${body ?? ""}\n`);
}

async function cmdJoin(a: Args) {
  if (str(a, "enroll")) return cmdEnroll(a); // `join --enroll <token>` = device enrollment
  const name = str(a, "as");
  if (!name) throw new Error("join requires --as <name>");
  const host = buildHost(a, name);
  const card = host.card;
  host.onMessage((e) => printIncoming(e));
  await host.start();
  console.log(`[conclave] joined as ${card.id}`);

  if (a["watch"]) {
    host.subscribe("topic://" + str(a, "topic", "all"));
    console.log("[conclave] watch mode - printing bus traffic. Ctrl-C to exit.");
    return;
  }

  console.log("[conclave] commands: '@<agent> text' | '/all text' | '/roster' | '/quit'");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  rl.on("line", async (line) => {
    const t = line.trim();
    try {
      if (t === "/quit") {
        await host.stop();
        process.exit(0);
      } else if (t === "/roster") {
        for (const r of host.getRoster()) console.log(`  ${r.online ? "*" : "-"} ${r.id}`);
      } else if (t.startsWith("/all ")) {
        await host.send("*", { kind: "event", body: t.slice(5) });
      } else if (t.startsWith("@")) {
        const sp = t.indexOf(" ");
        const to = t.slice(1, sp === -1 ? undefined : sp);
        const body = sp === -1 ? "" : t.slice(sp + 1);
        await host.send([to.startsWith("agent://") ? to : `agent://${to}`], { body });
      } else if (t.length) {
        console.log("  (use '@<agent> text', '/all text', '/roster', or '/quit')");
      }
    } catch (err) {
      console.error("  send failed:", (err as Error).message);
    }
    rl.prompt();
  });
}

async function cmdSend(a: Args) {
  const name = str(a, "as", "cli");
  const to = str(a, "to");
  if (!to) throw new Error("send requires --to <agent>");
  // persistState:false → a one-shot send reads the cursor (to replay/sign correctly) but never
  // ADVANCES the on-disk inbox cursor, so it can't silently swallow unread messages from `inbox`.
  const host = buildHost(a, name, { persistState: false }); // signed identity → works in secure mode
  // Confirm REAL acceptance instead of always printing "sent": a secure server ACKs a message it
  // accepted and REJECTs one it didn't (unsigned / not enrolled / unauthorized). Register before send.
  let acked = false;
  let rejected = false;
  let sentId = "";
  host.onAck((id) => { if (id === sentId) acked = true; });
  host.onReject((id) => { if (id === sentId) rejected = true; });
  await host.start();
  // "*" is the broadcast address (string), NOT an agent id — wrapping it into ["agent://*"] sends
  // to a recipient nobody matches, so the message lands nowhere. Keep it as the literal "*".
  const recipient = to === "*" ? "*" : [to.startsWith("agent://") ? to : `agent://${to}`];
  const env = await host.send(recipient, {
    subject: str(a, "subject") || undefined,
    body: str(a, "body"),
    kind: (str(a, "kind", "message") as Envelope["kind"]) || "message",
    wantAck: true,
  });
  sentId = env.id;
  const settle = str(a, "transport") === "git" ? 1500 : 1500;
  for (let i = 0; i < settle / 100 && !acked && !rejected; i++) await new Promise((r) => setTimeout(r, 100));
  await host.stop();
  if (rejected) throw new Error(`send to ${to} was REJECTED by the server (not enrolled / unauthorized). Enroll first: conclave join --enroll <token>`);
  if (acked) console.log(`[conclave] sent to ${to} ✓ (acknowledged)`);
  else console.log(`[conclave] queued to ${to} — no server ack (a legacy/no-auth server gives none; in secure mode this likely means NOT ENROLLED or unreachable — nothing was delivered)`);
  process.exit(0);
}

// Same-session bus access (no MCP / no reload): "who's online", straight from the server's
// authoritative live roster (the discovery plane — connect-token holders may read it).
async function cmdRoster(a: Args) {
  const base = httpBase(a);
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base}/roster`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch (e) {
    throw new Error(`roster: can't reach ${base} — ${(e as Error).message}. If the server's HTTP isn't on 8088, pass --http-port or --http-url.`);
  }
  if (!res.ok) throw new Error(`roster failed: ${res.status}`);
  const { roster } = (await res.json()) as { roster: (AgentCard & { online: boolean })[] };
  const sorted = roster.sort((x, y) => (y.online ? 1 : 0) - (x.online ? 1 : 0) || x.id.localeCompare(y.id));
  console.log(`roster — ${sorted.filter((r) => r.online).length}/${sorted.length} online:`);
  for (const r of sorted) {
    const z = r.zones?.length ? ` [${r.zones.join(",")}]` : "";
    const caps = r.capabilities?.length ? `  ${r.capabilities.join(", ")}` : "";
    console.log(`  ${r.online ? "●" : "○"} ${r.id}${z}  ${r.status ?? ""}${caps}`);
  }
}

// Same-session inbox: connect, replay messages missed since last check (durable cursor in --data),
// print them, exit. Run it again to see only newer ones.
async function cmdInbox(a: Args) {
  const name = str(a, "as") || os.hostname();
  const host = buildHost(a, name);
  const msgs: Envelope[] = [];
  // Events are hidden by default (board / topic machine traffic). But an explicit broadcast
  // (to:"*" — `send --to "*" --kind event`, or the human `/all`) means "everyone read this", so
  // always surface it; --events additionally reveals topic-scoped machine events.
  host.onMessage((e) => { if (a["events"] || e.kind !== "event" || e.to === "*") msgs.push(e); });
  await host.start(); // replays from the persisted cursor → catches messages sent while offline
  await new Promise((r) => setTimeout(r, a["wait"] ? Number(str(a, "wait")) : 1500));
  if (!msgs.length) console.log("(inbox empty — nothing new since last check)");
  else for (const e of msgs) console.log(`  ${e.from}${e.subject ? " · " + e.subject : ""}: ${typeof e.body === "string" ? e.body : JSON.stringify(e.body)}`);
  await host.stop(); // persists the advanced cursor
  process.exit(0);
}

async function cmdAgent(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("agent requires --as <name>");
  const host = buildHost(a, name);
  const brainKind = str(a, "brain", "echo");
  let brain;
  if (brainKind === "anthropic") {
    // Loaded lazily so `conclave agent --brain echo` needs no API key / SDK.
    const { anthropicBrain } = await import("./agent/brains/anthropic.js");
    brain = anthropicBrain({ system: str(a, "system") || undefined, model: str(a, "model") || undefined });
  } else if (brainKind === "local" || brainKind === "openai" || brainKind === "ollama" || brainKind === "lmstudio") {
    const { openaiCompatBrain, ollamaBrain, lmStudioBrain } = await import("./agent/brains/openai-compat.js");
    const model = str(a, "model");
    if (!model) throw new Error(`--brain ${brainKind} requires --model <name>`);
    const apiKey = str(a, "api-key") || process.env.OPENAI_API_KEY;
    if (brainKind === "ollama") brain = ollamaBrain(model, { apiKey });
    else if (brainKind === "lmstudio") brain = lmStudioBrain(model, { apiKey });
    else brain = openaiCompatBrain({ baseUrl: str(a, "base-url") || undefined, model, apiKey });
  } else if (brainKind === "claude") {
    // Stateful Claude Code teammate: persistent session (memory across messages), via your
    // CC login (no API key). The "Agent Teams, but cross-device" core.
    const { claudeCodeBrain } = await import("./agent/brains/claude-code.js");
    brain = claudeCodeBrain({
      sessionId: str(a, "session-id") || undefined,
      persona: str(a, "persona") || undefined,
      model: str(a, "model") || undefined,
      effort: str(a, "effort") || undefined,
      permissionMode: str(a, "permission") || undefined, // BUG was: dropped here, so `agent --brain claude --permission bypassPermissions` ran WITHOUT it → every tool call blocked in non-interactive claude -p → 120s timeout
      timeoutMs: a["timeout"] ? Number(str(a, "timeout")) * 1000 : undefined,
    });
  } else if (brainKind === "codex" || brainKind === "gemini" || brainKind === "cli") {
    const { cliBrain, codexBrain, geminiBrain } = await import("./agent/brains/cli.js");
    const shell = a["shell"] === true;
    if (brainKind === "codex") brain = codexBrain({ shell });
    else if (brainKind === "gemini") brain = geminiBrain({ shell });
    else {
      const command = str(a, "command");
      if (!command) throw new Error("--brain cli requires --command <bin>");
      brain = cliBrain({
        command,
        args: str(a, "cmd-args") ? str(a, "cmd-args").split(",") : [],
        promptVia: str(a, "prompt-via", "arg") === "stdin" ? "stdin" : "arg",
        shell,
      });
    }
  } else {
    brain = echoBrain();
  }

  // Optional loop guard: --guard N caps consecutive replies to one peer (bounds discussions).
  const agentOpts: { guard?: import("./agent/loop-guard.js").LoopGuard; watchable?: boolean } = { watchable: a["watchable"] === true };
  if (a["guard"]) {
    const { LoopGuard } = await import("./agent/loop-guard.js");
    agentOpts.guard = new LoopGuard({ maxConsecutivePerPeer: Number(a["guard"]), maxRepliesPerWindow: 200, windowMs: 600000 });
  }

  // Show inbound traffic in this agent's terminal so a discussion is visible live.
  let lastMsgAt = 0;
  host.onMessage((e) => { lastMsgAt = Date.now(); printIncoming(e); });

  const agent = new AutonomousAgent(host, brain, agentOpts);
  await agent.start();
  const stopUpdate = maybeStartSelfUpdate(a, () => Date.now() - lastMsgAt > 15_000); // not mid-conversation
  console.log(`[conclave] autonomous agent ${host.card.id} running with '${brainKind}' brain${a["guard"] ? ` (guard=${a["guard"]})` : ""}`);
  console.log("[conclave] it will react to incoming messages. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    stopUpdate();
    void agent.stop().then(() => process.exit(0));
  });
}

// Live remote observability: stream an agent's inbound/outbound activity. The agent must run with
// --watchable (it broadcasts a one-line trace per message); this subscribes and prints it.
async function cmdWatch(a: Args) {
  const target = str(a, "agent") || "";
  const id = target ? (target.startsWith("agent://") ? target : `agent://${target}`) : null;
  const name = str(a, "as") || "watcher";
  const host = buildHost(a, name, { persistState: false });
  host.onMessage((e) => {
    if (e.kind !== "event" || e.subject !== "watch") return;
    const w = e.body as { agent?: string; dir?: string; peer?: string; subj?: string; preview?: string };
    if (id && w.agent !== id) return;
    const t = new Date().toISOString().slice(11, 19);
    console.log(`${t}  ${w.agent} ${w.dir === "in" ? "←" : "→"} ${w.peer}  ${w.subj ? "[" + w.subj + "] " : ""}${w.preview ?? ""}`);
  });
  await host.start();
  console.log(`[conclave] watching ${id ?? "all watchable agents"} — live activity. Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    void host.stop().then(() => process.exit(0));
  });
}

async function cmdHost(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("host requires --as <name>");
  const commanders = new Set(
    (str(a, "commander") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((c) => (c.startsWith("agent://") ? c : `agent://${c}`)),
  );
  if (!commanders.size) throw new Error("host requires --commander <agent-id>[,<id>…] (who may command this device)");
  const url = str(a, "url") || "ws://127.0.0.1:8787";
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN || "";
  const host = buildHost(a, name);
  const { DeviceAgent } = await import("./agent/device-agent.js");
  const { fileURLToPath } = await import("node:url");
  const agent = new DeviceAgent({
    host,
    commanders,
    url,
    token,
    httpPort: str(a, "http-port") || undefined,
    httpUrl: str(a, "http-url") || undefined,
    cliPath: fileURLToPath(import.meta.url),
    dataRoot: dataHome(a),
    startedAt: Date.now(),
  });
  await host.start();
  agent.start();
  console.log(`[conclave] device agent ${host.card.id} up — commanders: ${[...commanders].join(", ")}. Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    void agent.stopAll().then(() => process.exit(0));
  });
}

async function cmdServe(a: Args) {
  const wsPort = a["port"] ? Number(a["port"]) : 8787;
  const httpPort = a["http"] ? Number(a["http"]) : 8088;
  const dataDir = str(a, "data", path.join(dataHome(a), "server"));
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN || undefined;
  const adminToken = str(a, "admin-token") || process.env.CONCLAVE_ADMIN_TOKEN || undefined;
  if (adminToken && !token) {
    throw new Error("secure mode (--admin-token) also requires --token (or CONCLAVE_TOKEN): the connect token gates who may open a WS connection / reach the HTTP API at all.");
  }
  const { ConclaveServer } = await import("./server/conclave-server.js");
  const server = new ConclaveServer({ wsPort, httpPort, dataDir, token, adminToken });
  await server.start();
  const mode = adminToken
    ? "SECURE (per-agent signed identities required)"
    : token
      ? "auth: shared token"
      : "NO AUTH — set --token / --admin-token before exposing";
  console.log(`[conclave] server up [${mode}]`);
  console.log(`[conclave]   bus  (agents):   ws://0.0.0.0:${server.wsPort()}`);
  console.log(`[conclave]   http (api/data): http://0.0.0.0:${server.httpPort()}`);
  console.log(`[conclave]   tasks: GET/POST /tasks · history: GET /messages · data: POST/GET /blobs`);
  if (adminToken) console.log(`[conclave]   onboard: conclave invite --role <r> · device: conclave join --enroll <token>`);
  console.log(`[conclave]   data dir: ${dataDir}`);
  process.on("SIGINT", () => {
    void server.stop().then(() => process.exit(0));
  });
}

function httpBase(a: Args): string {
  // Derive the HTTP API base from the ws --url (ws://host:8787 -> http://host:8088), or --http-url.
  if (str(a, "http-url")) return str(a, "http-url").replace(/\/$/, "");
  const ws = str(a, "url", "ws://127.0.0.1:8787");
  const m = ws.match(/^wss?:\/\/([^/:]+)(?::(\d+))?/);
  const host = m?.[1] ?? "127.0.0.1";
  const scheme = ws.startsWith("wss") ? "https" : "http";
  const httpPort = str(a, "http-port", "8088");
  return `${scheme}://${host}:${httpPort}`;
}

// When invite/enroll get "server not in secure mode", the HTTP request reached a server that
// isn't running secure mode — almost always a config issue. Make it debuggable instead of cryptic.
function secureHint(err: string | undefined, base: string): string {
  if (!/secure mode/i.test(err ?? "")) return "";
  return (
    `\n  → the HTTP server at ${base} is not in SECURE mode. Check:` +
    `\n     1. the server was started with BOTH --token AND --admin-token (secure mode needs both),` +
    `\n     2. --http-port (default 8088) / --http-url matches the server's --http port,` +
    `\n     3. nothing else (e.g. a stray 'conclave serve' with no auth) is listening on that port.`
  );
}

// Device: pre-generate a keypair and print its public key, so an admin can PIN it at invite
// time (defeats enrollment-token interception — only this exact key can enroll the name).
async function cmdKeygen(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("keygen requires --as <name>");
  const file = str(a, "identity") || path.join(dataHome(a), "identity.json");
  if (existsSync(file) && !a["force"]) throw new Error(`identity already exists at ${file} (use --force to overwrite)`);
  const ident = generateIdentity(name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...ident, zones: [] }, null, 2));
  console.log(`[conclave] generated identity for ${ident.id} → ${file}`);
  console.log(`\nGive this public key to the admin to PIN your enrollment:\n  ${ident.publicKey}\n`);
  console.log(`Admin runs:  conclave invite --as ${name} --pin ${ident.publicKey} --admin-token <a> --url <ws>`);
}

// Admin: mint a one-time enrollment token for a new agent identity.
async function cmdInvite(a: Args) {
  const name = str(a, "as") || str(a, "name");
  if (!name) throw new Error("invite requires --as <agent-name>");
  const admin = str(a, "admin-token") || process.env.CONCLAVE_ADMIN_TOKEN;
  if (!admin) throw new Error("invite requires --admin-token (or CONCLAVE_ADMIN_TOKEN)");
  const base = httpBase(a);
  const zones = str(a, "zone") ? str(a, "zone").split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const res = await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name, role: str(a, "role") || undefined, canRun: a["can-run"] === true, zones, pin: str(a, "pin") || undefined }),
  });
  const j = (await res.json()) as { enrollToken?: string; error?: string; role?: string; canRun?: boolean; zones?: string[] };
  if (!res.ok) throw new Error(`invite failed: ${j.error ?? res.status}${secureHint(j.error, base)}`);
  const wsUrl = str(a, "url", "ws://127.0.0.1:8787");
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN || "<connect-token>";
  console.log(`[conclave] invited agent://${name} (role=${j.role ?? "-"}, canRun=${j.canRun ?? false})`);
  console.log(`\nGive this to the device — it enrolls a local keypair (private key never leaves it):\n`);
  console.log(`  conclave join --as ${name} --url ${wsUrl} --token ${token} --enroll ${j.enrollToken}\n`);
}

// Device: redeem an enrollment token — generate a local keypair, register the public key, save identity.
async function cmdEnroll(a: Args) {
  const enroll = str(a, "enroll");
  const name = str(a, "as");
  if (!enroll || !name) throw new Error("join requires --as <name> --enroll <token>");
  const base = httpBase(a);
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN;
  // Reuse a pre-generated identity (from `conclave keygen`, whose pubkey the admin may have
  // pinned) if present; otherwise mint a fresh one (trust-on-first-use).
  const ident = deviceIdentity(a) ?? generateIdentity(name);
  const proof = signData(ident.privateKey, enroll); // prove we hold the private key for this pubkey
  const res = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ token: enroll, publicKey: ident.publicKey, proof }),
  });
  const j = (await res.json()) as { id?: string; role?: string; canRun?: boolean; zones?: string[]; error?: string };
  if (!res.ok) throw new Error(`enroll failed: ${j.error ?? res.status}${secureHint(j.error, base)}`);
  const file = str(a, "identity") || path.join(dataHome(a), "identity.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...ident, zones: j.zones ?? [] }, null, 2));
  console.log(`[conclave] enrolled ${j.id} (role=${j.role ?? "-"}, canRun=${j.canRun ?? false}, zones=[${(j.zones ?? []).join(", ")}])`);
  console.log(`[conclave] identity saved to ${file} — this device can now sign as ${j.id}.`);
  console.log(`[conclave] next: conclave work --as ${name} --url ${str(a, "url", "ws://127.0.0.1:8787")} --token ${token ?? "<token>"} --role ${j.role ?? "..."}`);
}

// The human cockpit: run a Conclave MCP server over stdio so a Claude Code instance becomes a
// bus agent (tools: conclave_roster/send/inbox + inbound push). Uses the device identity/token.
async function cmdMcp(a: Args) {
  const name = str(a, "as") || os.hostname();
  const host = buildHost(a, name); // identity + token + zone from flags / ~/.conclave/identity.json
  const { buildConclaveMcpServer } = await import("./adapters/claude-code/adapter.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { server, setConnected } = buildConclaveMcpServer(host, { push: a["no-push"] !== true });
  await host.start();
  await server.connect(new StdioServerTransport());
  setConnected(true);
  // MUST log to stderr only — stdout is the MCP wire.
  console.error(`[conclave-mcp] ${host.card.id} joined the bus as a Claude Code cockpit`);
}

async function cmdWork(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("work requires --as <name>");
  const host = buildHost(a, name);
  const { TaskBoard } = await import("./agent/task-board.js");
  const { TeamWorker } = await import("./agent/team-worker.js");
  const board = new TaskBoard(host);

  const brainKind = str(a, "brain", "claude");
  let brain;
  if (brainKind === "claude") {
    const { claudeCodeBrain } = await import("./agent/brains/claude-code.js");
    brain = claudeCodeBrain({ persona: str(a, "persona") || undefined, permissionMode: str(a, "permission") || undefined });
  } else {
    brain = echoBrain();
  }

  let busy = false; // gate self-update so it never restarts mid-task
  const worker = new TeamWorker(host, board, brain, {
    pollMs: a["poll"] ? Number(a["poll"]) : 2500,
    settleMs: a["settle"] ? Number(a["settle"]) : 1500,
    role: str(a, "role") || undefined,
    handoffTo: str(a, "handoff") || undefined,
    onEvent: (ev) => {
      if (ev.type === "claim") { busy = true; console.log(`[${name}] claimed: ${ev.task?.title}`); }
      else if (ev.type === "done") { busy = false; console.log(`[${name}] done:    ${ev.task?.title}  =>  ${String(ev.result).replace(/\s+/g, " ").slice(0, 90)}`); }
    },
  });
  await worker.start();
  const stopUpdate = maybeStartSelfUpdate(a, () => !busy);
  console.log(`[conclave] team worker ${host.card.id} (${brainKind}) working the shared board. Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    stopUpdate();
    void worker.stop().then(() => process.exit(0));
  });
}

async function cmdBoard(a: Args) {
  const sub = str(a, "_sub") || "list"; // set by main() from the positional arg
  const name = str(a, "as", "board-cli");
  // persistState:false: board ops share a --data dir with `inbox`; don't advance its read cursor.
  // (TaskBoard still requireFullReplay()s, so the board itself rebuilds completely.)
  const host = buildHost(a, name, { persistState: false });
  const { TaskBoard } = await import("./agent/task-board.js");
  const board = new TaskBoard(host);
  await host.start();

  const printBoard = () => {
    const tasks = board.list();
    if (!tasks.length) {
      console.log("(board empty)");
      return;
    }
    for (const t of tasks) {
      const mark = t.status === "done" ? "[x]" : t.status === "claimed" ? "[~]" : "[ ]";
      const who = t.claimedBy ? ` @${t.claimedBy}` : "";
      const res = t.result ? `  => ${t.result}` : "";
      console.log(`${mark} ${t.id}  ${t.title}${who}${res}`);
    }
  };

  // Give the board time to sync from the bus (replay) before acting/printing. Over the public
  // internet / a large log this can take a couple seconds; --sync overrides it.
  await new Promise((r) => setTimeout(r, a["sync"] ? Number(str(a, "sync")) : str(a, "transport") === "git" ? 1500 : 2000));

  if (sub === "watch") {
    console.log("[conclave] watching task board. Ctrl-C to exit.");
    board.onChange(() => {
      console.log("--- board ---");
      printBoard();
    });
    printBoard();
    return;
  }
  if (sub === "add") {
    const id = await board.add(str(a, "title") || str(a, "body") || "untitled task", str(a, "for") ? { for: str(a, "for") } : {});
    console.log(`added ${id}`);
  } else if (sub === "claim") {
    // --task (not --id): --id is the agent-identity flag consumed by makeCard.
    await board.claim(str(a, "task"));
    console.log(`claimed ${str(a, "task")}`);
  } else if (sub === "done") {
    await board.done(str(a, "task"), str(a, "result") || undefined);
    console.log(`done ${str(a, "task")}`);
  } else {
    printBoard();
  }
  await new Promise((r) => setTimeout(r, str(a, "transport") === "git" ? 1500 : 400));
  await host.stop();
  process.exit(0);
}

async function cmdHuman(a: Args) {
  const name = str(a, "as", "human");
  const host = buildHost(a, name); // signed device identity → the human cockpit works in secure mode
  host.subscribe("topic://human"); // receive loop-guard escalations
  const { HumanServer } = await import("./agent/human-server.js");
  const port = a["port"] ? Number(a["port"]) : 7070;
  const server = new HumanServer({ host, port });
  await server.start();
  console.log(`[conclave] human UI for ${host.card.id} at http://localhost:${server.port()}`);
  console.log("[conclave] open it in a browser; you are now an agent on the bus. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    void server.stop().then(() => process.exit(0));
  });
}

async function cmdTeam(a: Args) {
  const members = str(a, "members")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!members.length) throw new Error("team requires --members alice,bob,carol");
  const port = a["port"] ? Number(a["port"]) : 8787;
  const brainKind = str(a, "brain", "claude");
  const guardN = a["guard"] ? Number(a["guard"]) : 6;
  const dataRoot = path.join(dataHome(a), "team");
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN || undefined;

  const relay = new RelayServer({ port, logFile: path.join(dataRoot, "relay.log"), token });
  await relay.start();
  const url = `ws://127.0.0.1:${relay.port()}`;
  console.log(`[conclave] team relay on ws://0.0.0.0:${relay.port()}`);

  const { LoopGuard } = await import("./agent/loop-guard.js");
  const agents: AutonomousAgent[] = [];
  for (const m of members) {
    const card = makeCard(a, m);
    card.id = `agent://${m}`; // bare id for clean addressing within the team
    const host = new NodeHost({ card, transport: buildTransport({ kind: "relay", url, token }), dataDir: path.join(dataRoot, m) });
    // NOTE: teammates coordinate via direct messages today. Autonomous task-board working
    // (each teammate runs a TaskBoard + claimNext loop, emitting claim/done) is the next
    // step — until then we don't subscribe them to topic://tasks (it would just feed
    // unactable task events to the model).
    let brain;
    if (brainKind === "claude") {
      const { claudeCodeBrain } = await import("./agent/brains/claude-code.js");
      brain = claudeCodeBrain({ persona: str(a, "persona") || undefined });
    } else {
      brain = echoBrain();
    }
    host.onMessage((e) => {
      if (e.from !== card.id) printIncoming(e);
    });
    const agent = new AutonomousAgent(host, brain, {
      guard: new LoopGuard({ maxConsecutivePerPeer: guardN, maxRepliesPerWindow: 200, windowMs: 600000 }),
    });
    await agent.start();
    agents.push(agent);
    console.log(`[conclave]   teammate up: ${card.id} (${brainKind} brain, guard=${guardN})`);
  }

  console.log(`[conclave] team ready (${members.length} members).`);
  console.log(`[conclave]   remote teammates join: conclave agent --as <name> --url ws://<this-host>:${relay.port()}`);
  console.log(`[conclave]   post work:  conclave board --as you --url ${url} add --title "..."`);
  console.log(`[conclave]   watch board: conclave board --as you --url ${url} watch`);
  console.log("[conclave] Ctrl-C to stop the team.");
  process.on("SIGINT", () => {
    void (async () => {
      for (const ag of agents) await ag.stop();
      await relay.stop();
      process.exit(0);
    })();
  });
}

function help() {
  console.log(`conclave - cross-device agent bus

  conclave up    [--port 8787] [--log <file>]
        start a bare relay (durable WebSocket hub).

  conclave serve [--port 8787] [--http 8088] [--data <dir>] [--token <t>] [--admin-token <a>]
        full coordination server: WS bus + HTTP API for tasks (GET/POST /tasks), conversation
        history (GET /messages), data exchange (POST/GET /blobs), and an admin dashboard at
        http://<http>/dashboard. --token gates who may connect; adding --admin-token turns on
        SECURE MODE (per-agent enrolled identities + signed envelopes + zones) — secure mode
        needs BOTH --token AND --admin-token. (Also reads CONCLAVE_TOKEN / CONCLAVE_ADMIN_TOKEN.)

  conclave invite --as <name> [--role r] [--zone z] [--can-run] [--pin <pubkey>]
                  --admin-token <a> --url ws://host:8787 [--http-port 8088 | --http-url <u>]
        (admin, secure mode) mint a one-time enrollment token; prints the device's join command.
        --zone scopes the agent to a zone; --pin <pubkey> (from 'conclave keygen') locks enrollment
        to one device key. Talks to the server's HTTP port (default 8088 — pass --http-port if you
        changed --http on serve).

  conclave keygen --as <name>
        (device, optional) pre-generate this device's ed25519 keypair and print its public key,
        so the admin can --pin it at invite time (defeats enrollment-token interception).

  conclave join  --as <name> --enroll <token> --url ws://host:8787 --token <t>
        (device) redeem an enrollment token: generate a local ed25519 keypair, register the
        public key, save the identity. The private key never leaves the device. Afterwards
        every message this device sends is signed; a stolen relay token alone can't act as it.

  conclave join  --as <name> [--transport relay|git]
                 [--url ws://host:port]                       (relay)
                 [--repo <clone> --agent-dir <n> [--local]]   (git)
                 [--watch [--topic all]]
        run a node host. Interactive REPL by default.

  conclave send  --as <name> --to <agent> [--subject s] [--body text]
                 [--kind message|event|request] (transport flags as above)
        fire one signed message and exit.

  conclave roster --as <name> (transport flags as above)
        one-shot "who's online" — connects, prints the live roster (id · zone · status ·
        capabilities), exits. No MCP / no new session needed.

  conclave inbox  --as <name> [--events] (transport flags as above)
        one-shot inbox — prints messages received since your last check (durable cursor), exits.
        Run it again for only newer ones. (send + roster + inbox = full bus access from a shell.)

  conclave agent --as <name> [--brain echo|claude|anthropic|codex|gemini|cli|local|ollama] [--guard N]
        run a model-driven agent that reacts to incoming messages (--guard N bounds
        a back-and-forth: max N consecutive replies to one peer). Brains:
          claude     local 'claude -p' via your CC login (NO API key)
          anthropic  Claude API (needs ANTHROPIC_API_KEY) [--model <id>] [--system <p>]
          codex      OpenAI Codex CLI (codex exec)     [--shell on Windows]
          gemini     Google Gemini CLI (gemini -p)
          cli        any subprocess  --command <bin> [--cmd-args a,b] [--prompt-via arg|stdin]
          local      local model via OpenAI-compatible HTTP  --model <name> [--base-url url]
          ollama     Ollama preset (:11434)  --model <name>
          lmstudio   LM Studio preset (:1234)  --model <name>

  conclave mcp   --as <name> --url ws://host:8787 [--token <t>]
        run a Conclave MCP server (stdio) so a Claude Code instance becomes a bus agent —
        'claude mcp add conclave -- conclave mcp --as me --url ws://host:8787 --token <t>'.
        Tools: conclave_roster / conclave_send / conclave_inbox (+ inbound push).

  conclave human --as <name> [--port 7070] (transport flags as above)
        run a web UI that puts YOU on the bus as an agent (inbox + send form).
        Also receives loop-guard escalations from other agents.

  conclave team  --members alice,bob,carol [--brain claude] [--port 8787] [--guard 6]
        one command: start a relay + persistent Claude Code teammates (no API key).
        Remote teammates join with 'conclave agent --url ws://<host>:<port>'.

  conclave board <add|list|claim|done|watch> --as <name> (transport flags as above)
        shared task board: add --title "..." | list | claim --task X | done --task X [--result R] | watch

  conclave work  --as <name> [--brain claude] [--role R] [--handoff R2]
                 [--permission bypassPermissions] [--persona "..."] [--poll] [--settle]
        self-organizing worker: claims open board tasks (matching --role), does them with
        its brain, marks them done. --handoff R2 posts the result as a new task for role R2
        (a pipeline, e.g. coder --handoff deploy). --permission lets it run/deploy.
        (transport flags as above)

  conclave host  --as <device> --commander <agent-id>[,<id>…] (transport flags as above)
        per-device control plane (a "kubelet"): represents this device on the bus and, on GATED
        command from an allowlisted --commander, spawns/stops/reports the device's worker agents.
        Structured ops only (status/list/spawn/stop) — never arbitrary shell. See docs/device-agent.md.

  conclave watch --agent <id> (transport flags as above)
        live remote observability: stream an agent's inbound/outbound activity (the agent must run
        with --watchable). Your "remote control" view of what a teammate is doing, in real time.

Examples:
  # local, no auth (trusted machine only)
  conclave up --port 8787
  conclave join --as laptop --url ws://localhost:8787

  # secure: server + enroll a node + open the dashboard
  conclave serve --token <connect> --admin-token <admin>            # on the server host
  conclave invite --as gpu --role deploy --zone s-main \\
      --admin-token <admin> --url ws://HOST:8787                    # on the admin machine
  conclave join --as gpu --enroll <token> --url ws://HOST:8787 --token <connect>   # on the device
  #   then open  http://HOST:8088/dashboard  and paste <admin>

  # git transport (no server, firewall-friendly)
  conclave join --as gpubox --transport git --repo ~/bus --agent-dir gpubox
`);
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  // `--help`/`-h` (with or without a command) prints usage and NEVER dispatches — `serve --help`
  // used to start a real NO-AUTH server on 8787/8088 and leave it running (a footgun that then
  // poisoned `invite` by occupying the HTTP port).
  if (cmd === "help" || cmd === "--help" || cmd === "-h" || args["help"] === true || args["h"] === true) {
    help();
    return;
  }
  switch (cmd) {
    case "up":
      return cmdUp(args);
    case "join":
      return cmdJoin(args);
    case "send":
      return cmdSend(args);
    case "roster":
      return cmdRoster(args);
    case "inbox":
      return cmdInbox(args);
    case "agent":
      return cmdAgent(args);
    case "human":
      return cmdHuman(args);
    case "team":
      return cmdTeam(args);
    case "board":
      return cmdBoard(args);
    case "work":
      return cmdWork(args);
    case "host":
      return cmdHost(args);
    case "watch":
      return cmdWatch(args);
    case "serve":
      return cmdServe(args);
    case "invite":
      return cmdInvite(args);
    case "keygen":
      return cmdKeygen(args);
    case "enroll":
      return cmdEnroll(args);
    case "mcp":
      return cmdMcp(args);
    default:
      help();
  }
}

main().catch((e) => {
  console.error("[conclave] error:", (e as Error).message);
  process.exit(1);
});
