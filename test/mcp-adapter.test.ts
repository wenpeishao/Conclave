import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { buildConclaveMcpServer } from "../src/adapters/claude-code/adapter.js";
import { tmpDir, card, until } from "./helpers.js";

test("MCP adapter: inbound bus message → push notification AND pull inbox", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const ccHost = new NodeHost({ card: card("ccbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const { server, setConnected } = buildConclaveMcpServer(ccHost, { push: true });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  const pushes: { from?: string; body?: string }[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    const data = n.params.data as { from?: string; body?: string } | undefined;
    if (data) pushes.push(data);
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  setConnected(true);
  await ccHost.start();

  // Another agent sends a message to the Claude Code agent.
  const otherHost = new NodeHost({ card: card("other"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  await otherHost.start();
  await otherHost.send(["agent://ccbot"], { subject: "heads up", body: "ping from other" });

  // PUSH: the notification arrives without the model polling.
  await until(() => pushes.some((p) => p.body === "ping from other"), 4000);
  assert.ok(
    pushes.some((p) => p.from === "agent://other" && p.body === "ping from other"),
    "push notification delivered on inbound message",
  );

  // PULL: the same message is still drainable via the tool.
  const res = (await client.callTool({ name: "conclave_inbox", arguments: {} })) as {
    content: { type: string; text: string }[];
  };
  assert.match(res.content[0].text, /ping from other/, "inbox tool returns the message");

  // conclave_send routes back onto the bus.
  let otherGot = "";
  otherHost.onMessage((e) => {
    if (e.kind === "message") otherGot = String(e.body);
  });
  await client.callTool({ name: "conclave_send", arguments: { to: "other", body: "reply via tool" } });
  await until(() => otherGot === "reply via tool", 4000);
  assert.equal(otherGot, "reply via tool", "conclave_send delivers onto the bus");

  await client.close();
  await server.close();
  await ccHost.stop();
  await otherHost.stop();
});
