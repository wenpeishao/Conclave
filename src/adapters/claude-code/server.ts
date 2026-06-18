#!/usr/bin/env -S npx tsx
/**
 * Conclave ↔ Claude Code adapter (MCP server, stdio).
 *
 * Drop this into any Claude Code instance's MCP config and that instance becomes an
 * agent on the bus — on whatever device it runs, behind whatever model. It exposes
 * three tools:
 *   conclave_roster  — who else is on the bus right now
 *   conclave_send    — send a directed/broadcast message
 *   conclave_inbox   — drain messages received since the last call (pull model)
 *
 * Push (interrupt the session the moment a message lands) is a future enhancement via
 * Claude Code Channels; the pull inbox works on every Claude Code version today.
 *
 * Config via env vars:
 *   CONCLAVE_NAME            agent name (default: hostname)
 *   CONCLAVE_ID              agent URI (default: agent://<name>@<host>)
 *   CONCLAVE_TRANSPORT       relay | git           (default: relay)
 *   CONCLAVE_RELAY_URL       ws://host:port        (relay)
 *   CONCLAVE_GIT_REPO        path to a bus clone   (git)
 *   CONCLAVE_GIT_AGENT_DIR   this agent's subdir   (git, default: name)
 *   CONCLAVE_DATA            state dir             (default: ~/.conclave)
 */
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { NodeHost } from "../../node/host.js";
import { buildTransport, type TransportConfig } from "../../node/build.js";
import type { AgentCard, Envelope } from "../../core/types.js";

const env = process.env;
const name = env.CONCLAVE_NAME ?? os.hostname();
const id = env.CONCLAVE_ID ?? `agent://${name}@${os.hostname()}`;
const dataDir = env.CONCLAVE_DATA ?? path.join(os.homedir(), ".conclave");

function transportConfig(): TransportConfig {
  if ((env.CONCLAVE_TRANSPORT ?? "relay") === "git") {
    return {
      kind: "git",
      repoDir: env.CONCLAVE_GIT_REPO,
      agentDir: env.CONCLAVE_GIT_AGENT_DIR ?? name,
      remote: env.CONCLAVE_GIT_LOCAL !== "1",
    };
  }
  return { kind: "relay", url: env.CONCLAVE_RELAY_URL ?? "ws://127.0.0.1:8787" };
}

const card: AgentCard = {
  id,
  name,
  device: { host: os.hostname() },
  model: { runtime: "claude-code" },
  realtime: (env.CONCLAVE_TRANSPORT ?? "relay") === "git" ? "poll" : "push",
};

const host = new NodeHost({ card, transport: buildTransport(transportConfig()), dataDir });

// Buffer inbound so the model can drain it on its own cadence (pull model).
const inbox: Envelope[] = [];
host.onMessage((e) => {
  inbox.push(e);
});

function summarize(e: Envelope): string {
  const body = typeof e.body === "string" ? e.body : JSON.stringify(e.body);
  const subj = e.subject ? ` [${e.subject}]` : "";
  return `from ${e.from}${subj} (${e.kind}): ${body ?? ""}`;
}

const server = new McpServer({ name: "conclave", version: "0.1.0" });

server.registerTool(
  "conclave_roster",
  {
    description: "List the agents currently known on the Conclave bus and whether they are online.",
    inputSchema: {},
  },
  async () => {
    const roster = host.getRoster();
    const text = roster.length
      ? roster.map((r) => `${r.online ? "● online" : "○ offline"}  ${r.id}  ${(r.capabilities ?? []).join(",")}`).join("\n")
      : "(no other agents seen yet)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "conclave_send",
  {
    description:
      "Send a message to another agent on the Conclave bus. `to` is an agent id " +
      "(e.g. agent://gpubox) or '*' to broadcast. Reference big artifacts by URI in the body; do not paste them.",
    inputSchema: {
      to: z.string().describe("recipient agent id, or '*' for broadcast"),
      body: z.string().describe("the message text"),
      subject: z.string().optional().describe("short subject line"),
      kind: z.enum(["message", "event", "request", "response", "handoff"]).optional(),
    },
  },
  async ({ to, body, subject, kind }) => {
    const recipients = to === "*" ? ("*" as const) : [to.startsWith("agent://") ? to : `agent://${to}`];
    const sent = await host.send(recipients, { body, subject, kind: kind ?? "message" });
    return { content: [{ type: "text", text: `sent ${sent.id} to ${to}` }] };
  },
);

server.registerTool(
  "conclave_inbox",
  {
    description:
      "Drain messages received from other agents since the last call to this tool. " +
      "Returns and clears the buffer. Call it when you want to check for incoming coordination.",
    inputSchema: { peek: z.boolean().optional().describe("if true, do not clear the buffer") },
  },
  async ({ peek }) => {
    if (inbox.length === 0) return { content: [{ type: "text", text: "(inbox empty)" }] };
    const items = inbox.map(summarize).join("\n");
    if (!peek) inbox.length = 0;
    return { content: [{ type: "text", text: items }] };
  },
);

async function main() {
  await host.start();
  await server.connect(new StdioServerTransport());
  // stderr is safe for logs (stdout is the MCP channel).
  console.error(`[conclave-mcp] ${card.id} joined via ${transportConfig().kind}`);
}

main().catch((e) => {
  console.error("[conclave-mcp] fatal:", e);
  process.exit(1);
});
