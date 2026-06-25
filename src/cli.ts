#!/usr/bin/env -S npx tsx
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { RelayServer } from "./relay/server.js";
import { NodeHost } from "./node/host.js";
import { buildTransport, type TransportConfig } from "./node/build.js";
import { AutonomousAgent } from "./agent/runtime.js";
import { echoBrain } from "./agent/brains/rule.js";
import { generateIdentity, type Identity } from "./core/identity.js";
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

/** Load this device's enrolled identity (from --identity <file> or <data>/identity.json), if any. */
function deviceIdentity(a: Args): Identity | undefined {
  if (str(a, "identity") === "none") return undefined;
  const file = str(a, "identity") || path.join(dataHome(a), "identity.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Identity;
  } catch {
    return undefined;
  }
}

/** Build a NodeHost, reconciling the card id/name to the enrolled identity when present. */
function buildHost(a: Args, name: string, transport: ReturnType<typeof buildTransport>): NodeHost {
  const ident = deviceIdentity(a);
  const card = makeCard(a, name);
  if (ident) {
    card.id = ident.id;
    card.name = ident.name;
  }
  return new NodeHost({ card, transport, dataDir: dataHome(a), identity: ident });
}

function makeCard(a: Args, name: string): AgentCard {
  // Default id is the bare name so `--to <name>` just works. Pass --id agent://name@host
  // explicitly when you need to disambiguate two agents that share a name across devices.
  return {
    id: str(a, "id", `agent://${name}`),
    name,
    device: { host: os.hostname() },
    model: a["model"] ? { runtime: str(a, "model") } : undefined,
    realtime: str(a, "transport", "relay") === "git" ? "poll" : "push",
  };
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
  const transport = buildTransport(transportFromArgs(a, name));
  const host = buildHost(a, name, transport);
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
  const card = makeCard(a, name);
  const transport = buildTransport(transportFromArgs(a, name));
  const host = new NodeHost({ card, transport, dataDir: dataHome(a) });
  await host.start();
  await host.send([to.startsWith("agent://") ? to : `agent://${to}`], {
    subject: str(a, "subject") || undefined,
    body: str(a, "body"),
    kind: (str(a, "kind", "message") as Envelope["kind"]) || "message",
  });
  await new Promise((r) => setTimeout(r, str(a, "transport") === "git" ? 1500 : 300));
  await host.stop();
  console.log(`[conclave] sent to ${to}`);
  process.exit(0);
}

async function cmdAgent(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("agent requires --as <name>");
  const host = buildHost(a, name, buildTransport(transportFromArgs(a, name)));
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
  const agentOpts: { guard?: import("./agent/loop-guard.js").LoopGuard } = {};
  if (a["guard"]) {
    const { LoopGuard } = await import("./agent/loop-guard.js");
    agentOpts.guard = new LoopGuard({ maxConsecutivePerPeer: Number(a["guard"]), maxRepliesPerWindow: 200, windowMs: 600000 });
  }

  // Show inbound traffic in this agent's terminal so a discussion is visible live.
  host.onMessage((e) => printIncoming(e));

  const agent = new AutonomousAgent(host, brain, agentOpts);
  await agent.start();
  console.log(`[conclave] autonomous agent ${host.card.id} running with '${brainKind}' brain${a["guard"] ? ` (guard=${a["guard"]})` : ""}`);
  console.log("[conclave] it will react to incoming messages. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    void agent.stop().then(() => process.exit(0));
  });
}

async function cmdServe(a: Args) {
  const wsPort = a["port"] ? Number(a["port"]) : 8787;
  const httpPort = a["http"] ? Number(a["http"]) : 8088;
  const dataDir = str(a, "data", path.join(dataHome(a), "server"));
  const token = str(a, "token") || process.env.CONCLAVE_TOKEN || undefined;
  const adminToken = str(a, "admin-token") || process.env.CONCLAVE_ADMIN_TOKEN || undefined;
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

// Admin: mint a one-time enrollment token for a new agent identity.
async function cmdInvite(a: Args) {
  const name = str(a, "as") || str(a, "name");
  if (!name) throw new Error("invite requires --as <agent-name>");
  const admin = str(a, "admin-token") || process.env.CONCLAVE_ADMIN_TOKEN;
  if (!admin) throw new Error("invite requires --admin-token (or CONCLAVE_ADMIN_TOKEN)");
  const base = httpBase(a);
  const res = await fetch(`${base}/admin/invite`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify({ name, role: str(a, "role") || undefined, canRun: a["can-run"] === true }),
  });
  const j = (await res.json()) as { enrollToken?: string; error?: string; role?: string; canRun?: boolean };
  if (!res.ok) throw new Error(`invite failed: ${j.error ?? res.status}`);
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
  const ident = generateIdentity(name);
  const res = await fetch(`${base}/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ token: enroll, publicKey: ident.publicKey }),
  });
  const j = (await res.json()) as { id?: string; role?: string; canRun?: boolean; error?: string };
  if (!res.ok) throw new Error(`enroll failed: ${j.error ?? res.status}`);
  const file = str(a, "identity") || path.join(dataHome(a), "identity.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(ident, null, 2));
  console.log(`[conclave] enrolled ${j.id} (role=${j.role ?? "-"}, canRun=${j.canRun ?? false})`);
  console.log(`[conclave] identity saved to ${file} — this device can now sign as ${j.id}.`);
  console.log(`[conclave] next: conclave work --as ${name} --url ${str(a, "url", "ws://127.0.0.1:8787")} --token ${token ?? "<token>"} --role ${j.role ?? "..."}`);
}

async function cmdWork(a: Args) {
  const name = str(a, "as");
  if (!name) throw new Error("work requires --as <name>");
  const host = buildHost(a, name, buildTransport(transportFromArgs(a, name)));
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

  const worker = new TeamWorker(host, board, brain, {
    pollMs: a["poll"] ? Number(a["poll"]) : 2500,
    settleMs: a["settle"] ? Number(a["settle"]) : 1500,
    role: str(a, "role") || undefined,
    handoffTo: str(a, "handoff") || undefined,
    onEvent: (ev) => {
      if (ev.type === "claim") console.log(`[${name}] claimed: ${ev.task?.title}`);
      else if (ev.type === "done") console.log(`[${name}] done:    ${ev.task?.title}  =>  ${String(ev.result).replace(/\s+/g, " ").slice(0, 90)}`);
    },
  });
  await worker.start();
  console.log(`[conclave] team worker ${host.card.id} (${brainKind}) working the shared board. Ctrl-C to stop.`);
  process.on("SIGINT", () => {
    void worker.stop().then(() => process.exit(0));
  });
}

async function cmdBoard(a: Args) {
  const sub = str(a, "_sub") || "list"; // set by main() from the positional arg
  const name = str(a, "as", "board-cli");
  const host = buildHost(a, name, buildTransport(transportFromArgs(a, name)));
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

  // Give the board a moment to sync from the bus before acting/printing.
  await new Promise((r) => setTimeout(r, str(a, "transport") === "git" ? 1500 : 600));

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
  const card = makeCard(a, name);
  const host = new NodeHost({ card, transport: buildTransport(transportFromArgs(a, name)), dataDir: dataHome(a) });
  host.subscribe("topic://human"); // receive loop-guard escalations
  const { HumanServer } = await import("./agent/human-server.js");
  const port = a["port"] ? Number(a["port"]) : 7070;
  const server = new HumanServer({ host, port });
  await server.start();
  console.log(`[conclave] human UI for ${card.id} at http://localhost:${server.port()}`);
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
        full coordination server: WS bus + HTTP API for tasks (GET/POST /tasks),
        conversation history (GET /messages), and data exchange (POST/GET /blobs).
        --admin-token turns on SECURE MODE: per-agent enrolled identities + signed
        envelopes required. Deploy where both sides can reach it.

  conclave invite --as <name> [--role r] [--can-run] --admin-token <a> --url ws://host:8787
        (admin) mint a one-time enrollment token for a new agent; prints the device's join command.

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
        fire one message and exit.

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

Examples:
  conclave up --port 8787
  conclave join --as laptop --url ws://10.0.0.5:8787
  conclave join --as gpubox --transport git --repo ~/bus --agent-dir gpubox
`);
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case "up":
      return cmdUp(args);
    case "join":
      return cmdJoin(args);
    case "send":
      return cmdSend(args);
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
    case "serve":
      return cmdServe(args);
    case "invite":
      return cmdInvite(args);
    case "enroll":
      return cmdEnroll(args);
    default:
      help();
  }
}

main().catch((e) => {
  console.error("[conclave] error:", (e as Error).message);
  process.exit(1);
});
