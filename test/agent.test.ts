import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import { ruleBrain, echoBrain } from "../src/agent/brains/rule.js";
import { tmpDir, card, until } from "./helpers.js";

test("two autonomous agents collaborate: request → compute → response", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // mathbot: answers "calc" requests by adding the two numbers it finds.
  const mathHost = new NodeHost({ card: card("mathbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const calcBrain = ruleBrain([
    {
      when: (e) => e.kind === "request" && (e.subject?.startsWith("calc") ?? false),
      reply: (e) => {
        const m = String(e.body).match(/(\d+)\s*\+\s*(\d+)/);
        return m ? String(Number(m[1]) + Number(m[2])) : "?";
      },
    },
  ]);
  const mathAgent = new AutonomousAgent(mathHost, calcBrain);

  // asker: records any response it receives.
  const askHost = new NodeHost({ card: card("asker"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const answers: string[] = [];
  const recordBrain = ruleBrain([
    {
      when: (e) => e.kind === "response",
      reply: (e) => {
        answers.push(String(e.body));
        return null; // record only, don't reply (so the exchange terminates)
      },
    },
  ]);
  const askAgent = new AutonomousAgent(askHost, recordBrain);

  await mathAgent.start();
  await askAgent.start();

  await askHost.send(["agent://mathbot"], { kind: "request", subject: "calc", body: "21 + 21" });

  await until(() => answers.includes("42"));
  assert.deepEqual(answers, ["42"], "asker received the computed answer from mathbot autonomously");

  await mathAgent.stop();
  await askAgent.stop();
});

test("watch: a --watchable agent broadcasts its inbound AND outbound as `watch` events", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // a watchable echo bot
  const botHost = new NodeHost({ card: card("wbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, echoBrain(), { watchable: true });

  // a watcher that collects `watch` traces (this is what `conclave watch` does)
  const watchHost = new NodeHost({ card: card("watcher"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const traces: { dir?: string; agent?: string; preview?: string }[] = [];
  watchHost.onMessage((e) => {
    if (e.kind === "event" && e.subject === "watch") traces.push(e.body as { dir?: string; agent?: string; preview?: string });
  });

  const userHost = new NodeHost({ card: card("user2"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });

  await bot.start();
  await watchHost.start();
  await userHost.start();

  await userHost.send(["agent://wbot"], { body: "ping" });
  await until(() => traces.some((t) => t.dir === "in") && traces.some((t) => t.dir === "out"));

  assert.ok(traces.some((t) => t.dir === "in" && t.agent === "agent://wbot"), "watcher saw wbot's inbound");
  assert.ok(traces.some((t) => t.dir === "out" && t.agent === "agent://wbot" && /echo: ping/.test(t.preview ?? "")), "watcher saw wbot's outbound reply");

  await bot.stop();
  await watchHost.stop();
  await userHost.stop();
});

test("echo brain replies to a directed message", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const botHost = new NodeHost({ card: card("echobot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, echoBrain());

  const userHost = new NodeHost({ card: card("user"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const got: string[] = [];
  userHost.onMessage((e) => {
    got.push(String(e.body));
  });

  await bot.start();
  await userHost.start();

  await userHost.send(["agent://echobot"], { body: "hello" });
  await until(() => got.includes("echo: hello"));
  assert.ok(got.includes("echo: hello"));

  await bot.stop();
  await userHost.stop();
});
