#!/usr/bin/env -S npx tsx
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { RelayServer } from "./relay/server.js";
import { NodeHost } from "./node/host.js";
import { buildTransport, type TransportConfig } from "./node/build.js";
import { AutonomousAgent } from "./agent/runtime.js";
import { echoBrain } from "./agent/brains/rule.js";
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
  return { kind: "relay", url: str(a, "url", "ws://127.0.0.1:8787") };
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
  const relay = new RelayServer({ port, logFile });
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
  const name = str(a, "as");
  if (!name) throw new Error("join requires --as <name>");
  const card = makeCard(a, name);
  const transport = buildTransport(transportFromArgs(a, name));
  const host = new NodeHost({ card, transport, dataDir: dataHome(a) });
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
  const card = makeCard(a, name);
  const host = new NodeHost({ card, transport: buildTransport(transportFromArgs(a, name)), dataDir: dataHome(a) });
  const brainKind = str(a, "brain", "echo");
  let brain;
  if (brainKind === "anthropic") {
    // Loaded lazily so `conclave agent --brain echo` needs no API key / SDK.
    const { anthropicBrain } = await import("./agent/brains/anthropic.js");
    brain = anthropicBrain({ system: str(a, "system") || undefined, model: str(a, "model") || undefined });
  } else {
    brain = echoBrain();
  }
  const agent = new AutonomousAgent(host, brain);
  await agent.start();
  console.log(`[conclave] autonomous agent ${card.id} running with '${brainKind}' brain`);
  console.log("[conclave] it will react to incoming messages. Ctrl-C to stop.");
  process.on("SIGINT", () => {
    void agent.stop().then(() => process.exit(0));
  });
}

function help() {
  console.log(`conclave - cross-device agent bus

  conclave up    [--port 8787] [--log <file>]
        start a relay (durable WebSocket hub).

  conclave join  --as <name> [--transport relay|git]
                 [--url ws://host:port]                       (relay)
                 [--repo <clone> --agent-dir <n> [--local]]   (git)
                 [--watch [--topic all]]
        run a node host. Interactive REPL by default.

  conclave send  --as <name> --to <agent> [--subject s] [--body text]
                 [--kind message|event|request] (transport flags as above)
        fire one message and exit.

  conclave agent --as <name> [--brain echo|anthropic] [--model <id>] [--system <prompt>]
        run a model-driven agent that reacts to incoming messages
        (anthropic brain needs ANTHROPIC_API_KEY). (transport flags as above)

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
    default:
      help();
  }
}

main().catch((e) => {
  console.error("[conclave] error:", (e as Error).message);
  process.exit(1);
});
