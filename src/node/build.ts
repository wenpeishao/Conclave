import type { Transport } from "../core/transport.js";
import { RelayWSTransport } from "../transports/relay-ws.js";
import { GitBusTransport } from "../transports/git-bus.js";
import type { Identity } from "../core/identity.js";

export interface TransportConfig {
  kind: "relay" | "git";
  // relay
  url?: string;
  token?: string;
  identity?: Identity; // signs the connection hello so the relay can route by identity/zone
  // git
  repoDir?: string;
  agentDir?: string;
  remote?: boolean;
  pollMs?: number;
}

/** One factory both the CLI and the MCP adapter use, so flags map identically. */
export function buildTransport(c: TransportConfig): Transport {
  if (c.kind === "relay") {
    if (!c.url) throw new Error("relay transport requires a url (ws://host:port)");
    return new RelayWSTransport(c.url, c.token, c.identity);
  }
  if (c.kind === "git") {
    if (!c.repoDir) throw new Error("git transport requires a repo dir (a working clone of the bus)");
    return new GitBusTransport({
      repoDir: c.repoDir,
      agentDir: c.agentDir ?? "agent",
      remote: c.remote ?? true,
      pollMs: c.pollMs,
    });
  }
  throw new Error(`unknown transport kind: ${String(c.kind)}`);
}
