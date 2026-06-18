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
