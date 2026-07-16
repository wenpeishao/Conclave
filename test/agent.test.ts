import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent, type Brain } from "../src/agent/runtime.js";
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

test("the brain is never invoked for watch/presence/ack traffic (the storm guard)", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // A brain that records every envelope it is asked to react to.
  const seen: string[] = [];
  const spyBrain: Brain = {
    react: async (ctx) => {
      seen.push(`${ctx.message.kind ?? "message"}:${ctx.message.subject ?? "-"}`);
      return [];
    },
  };
  const botHost = new NodeHost({ card: card("spybot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, spyBrain);

  const peerHost = new NodeHost({ card: card("peer"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  await bot.start();
  await peerHost.start();

  // Exactly the traffic that wedged a fresh node: another agent's `watch` traces, broadcast to "*".
  await peerHost.send("*", { kind: "event", subject: "watch", body: { agent: "agent://other", dir: "in", preview: "x" } });
  await peerHost.send("*", { kind: "event", subject: "device-command", body: { op: "spawn" } });
  // …and one real directed message, which MUST still reach the brain.
  await peerHost.send(["agent://spybot"], { body: "real work" });

  await until(() => seen.length > 0);
  await new Promise((r) => setTimeout(r, 150)); // let any stragglers land

  assert.deepEqual(seen, ["message:-"], `only the real message may reach the brain — got: ${JSON.stringify(seen)}`);

  await bot.stop();
  await peerHost.stop();
});

test("a brain failure is reported to the peer, not swallowed (a timeout looked like a dead node)", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // The real case: `--timeout` kills a long tool-using turn, so the brain throws and the reply it
  // was composing is discarded. The caller must learn that, not wait forever on silence.
  const deadBrain: Brain = { react: async () => { throw new Error("claude timed out"); } };
  const botHost = new NodeHost({ card: card("deadbot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, deadBrain);

  const peerHost = new NodeHost({ card: card("caller"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const got: { subject?: string; body: unknown }[] = [];
  peerHost.onMessage((e) => { if (e.from !== "agent://caller") got.push({ subject: e.subject, body: e.body }); });

  await bot.start();
  await peerHost.start();
  await peerHost.send(["agent://deadbot"], { kind: "request", body: "do a long thing" });

  await until(() => got.some((g) => g.subject === "brain-error"));
  assert.match(String(got.find((g) => g.subject === "brain-error")?.body), /claude timed out/, "the peer must be told WHY it gets no answer");

  await bot.stop();
  await peerHost.stop();
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
