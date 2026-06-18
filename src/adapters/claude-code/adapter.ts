import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NodeHost } from "../../node/host.js";
import type { Envelope } from "../../core/types.js";

/**
 * Builds the Conclave MCP server for a Claude Code instance. Exposes three tools and,
 * when `push` is on, emits an MCP logging notification the moment a message arrives —
 * the substrate for turning the pull `conclave_inbox` into an interrupt.
 *
 * Tools:
 *   conclave_roster — who else is on the bus
 *   conclave_send   — send a directed/broadcast message
 *   conclave_inbox  — drain messages received since the last call (reliable pull path)
 *
 * Push: with Claude Code's experimental Channels (`--channels`), a server logging
 * notification can interrupt the running session — so a message lands as an interrupt,
 * not something the model has to remember to poll. We emit a real `notifications/message`
 * (SDK `sendLoggingMessage`) per inbound message; whether it interrupts the turn is the
 * client's call. The pull inbox always works regardless.
 *
 * Returns `setConnected` — call it once the transport is connected, so we don't try to
 * push before the client has initialized.
 */
export interface AdapterOpts {
  push?: boolean;
}

export function buildConclaveMcpServer(host: NodeHost, opts: AdapterOpts = {}) {
  const push = opts.push ?? true;
  const inbox: Envelope[] = [];
  let connected = false;

  const server = new McpServer({ name: "conclave", version: "0.1.0" }, { capabilities: { logging: {} } });

  host.onMessage((e) => {
    inbox.push(e);
    if (push && connected) {
      void server.server
        .sendLoggingMessage({
          level: "info",
          logger: "conclave",
          data: { event: "message", id: e.id, from: e.from, subject: e.subject, kind: e.kind, body: render(e.body) },
        })
        .catch(() => {
          /* client may not accept logging — pull inbox still has it */
        });
    }
  });

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

  return {
    server,
    setConnected: (v: boolean) => {
      connected = v;
    },
  };
}

function render(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function summarize(e: Envelope): string {
  const subj = e.subject ? ` [${e.subject}]` : "";
  return `from ${e.from}${subj} (${e.kind}): ${render(e.body)}`;
}
