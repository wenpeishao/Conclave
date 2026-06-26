#!/usr/bin/env -S npx tsx
/**
 * Conclave ↔ Claude Code adapter bootstrap (MCP server over stdio).
 *
 * Drop this into a Claude Code instance's MCP config and that instance becomes an agent on
 * the bus — on whatever device, behind whatever model. Tools: conclave_roster /
 * conclave_send / conclave_inbox. With push on (default), an inbound message also emits an
 * MCP logging notification (the Channels-interrupt substrate); the pull inbox is the
 * reliable fallback. See ./adapter.ts for the buildable core.
 *
 * Config via env vars:
 *   CONCLAVE_NAME / CONCLAVE_ID            agent name / uri
 *   CONCLAVE_TRANSPORT  relay | git        (default: relay)
 *   CONCLAVE_RELAY_URL  ws://host:port     (relay)
 *   CONCLAVE_GIT_REPO / CONCLAVE_GIT_AGENT_DIR / CONCLAVE_GIT_LOCAL   (git)
 *   CONCLAVE_DATA       state dir          (default: ~/.conclave)
 *   CONCLAVE_PUSH       "0" to disable push notifications
 */
import * as os from "node:os";
import * as path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NodeHost } from "../../node/host.js";
import { buildTransport, type TransportConfig } from "../../node/build.js";
import type { AgentCard } from "../../core/types.js";
import { buildConclaveMcpServer } from "./adapter.js";

const env = process.env;
const name = env.CONCLAVE_NAME ?? os.hostname();
const id = env.CONCLAVE_ID ?? `agent://${name}@${os.hostname()}`;
const dataDir = env.CONCLAVE_DATA ?? path.join(os.homedir(), ".conclave");
const isGit = (env.CONCLAVE_TRANSPORT ?? "relay") === "git";

function transportConfig(): TransportConfig {
  if (isGit) {
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
  realtime: isGit ? "poll" : "push",
};

async function main() {
  const host = new NodeHost({ card, transport: buildTransport(transportConfig()), dataDir });
  const { server, setConnected } = buildConclaveMcpServer(host, { push: env.CONCLAVE_PUSH !== "0" });
  await host.start();
  await server.connect(new StdioServerTransport());
  setConnected(true);
  console.error(`[conclave-mcp] ${card.id} joined via ${transportConfig().kind} (push ${env.CONCLAVE_PUSH !== "0" ? "on" : "off"})`);
}

main().catch((e) => {
  console.error("[conclave-mcp] fatal:", e);
  process.exit(1);
});
