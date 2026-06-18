import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import { cliBrain, stripAnsi } from "../src/agent/brains/cli.js";
import { ruleBrain } from "../src/agent/brains/rule.js";
import { tmpDir, card, until } from "./helpers.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

test("stripAnsi removes color codes", () => {
  const ESC = String.fromCharCode(27);
  assert.equal(stripAnsi(`${ESC}[32m42${ESC}[0m`), "42");
});

test("CLI-shim brain: an agent driven by a subprocess CLI answers on the bus (arg mode)", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // This agent's "brain" is an external CLI process (the fake codex stand-in),
  // invoked once per inbound message with the prompt as the final argv element.
  const cliHost = new NodeHost({ card: card("codexbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const cliAgent = new AutonomousAgent(
    cliHost,
    cliBrain({ command: process.execPath, args: [FAKE], promptVia: "arg", timeoutMs: 20000 }),
  );

  const askHost = new NodeHost({ card: card("asker"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const answers: string[] = [];
  const recordBrain = ruleBrain([
    {
      when: (e) => e.kind === "response",
      reply: (e) => {
        answers.push(String(e.body));
        return null;
      },
    },
  ]);
  const askAgent = new AutonomousAgent(askHost, recordBrain);

  await cliAgent.start();
  await askAgent.start();

  await askHost.send(["agent://codexbot"], { kind: "request", subject: "calc", body: "21 + 21" });
  await until(() => answers.includes("42"), 20000);
  assert.deepEqual(answers, ["42"], "subprocess-driven agent computed and replied over the bus");

  await cliAgent.stop();
  await askAgent.stop();
});

test("CLI-shim brain: stdin prompt mode works", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const cliHost = new NodeHost({ card: card("stdinbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const cliAgent = new AutonomousAgent(
    cliHost,
    cliBrain({ command: process.execPath, args: [FAKE], promptVia: "stdin", timeoutMs: 20000 }),
  );

  const userHost = new NodeHost({ card: card("user"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  userHost.onMessage((e) => {
    got.push(String(e.body));
  });

  await cliAgent.start();
  await userHost.start();

  await userHost.send(["agent://stdinbot"], { body: "please compute 100 + 23" });
  await until(() => got.includes("123"), 20000);
  assert.ok(got.includes("123"));

  await cliAgent.stop();
  await userHost.stop();
});

test("CLI-shim brain: a missing command degrades to no-op (no crash)", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const cliHost = new NodeHost({ card: card("brokenbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const cliAgent = new AutonomousAgent(
    cliHost,
    cliBrain({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 5000 }),
  );

  const userHost = new NodeHost({ card: card("user2"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  userHost.onMessage((e) => {
    got.push(String(e.body));
  });

  await cliAgent.start();
  await userHost.start();

  await userHost.send(["agent://brokenbot"], { body: "hi" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(got.length, 0, "no reply, and the agent did not crash");

  await cliAgent.stop();
  await userHost.stop();
});
