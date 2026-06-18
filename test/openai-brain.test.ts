import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import { openaiCompatBrain } from "../src/agent/brains/openai-compat.js";
import { ruleBrain } from "../src/agent/brains/rule.js";
import { tmpDir, card, until } from "./helpers.js";

/** A fake local model server speaking the OpenAI /v1/chat/completions shape. */
function fakeModelServer(): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits++;
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const userMsg = parsed.messages.find((m) => m.role === "user")?.content ?? "";
      const m = userMsg.match(/(\d+)\s*\+\s*(\d+)/);
      const answer = m ? String(Number(m[1]) + Number(m[2])) : "NOOP";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
        hits: () => hits,
      });
    });
  });
}

test("OpenAI-compat brain: a local-model-backed agent answers on the bus", async () => {
  const model = await fakeModelServer();
  const hub = new MemoryHub();
  const dir = await tmpDir();

  const llmHost = new NodeHost({ card: card("localllm"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const llmAgent = new AutonomousAgent(
    llmHost,
    openaiCompatBrain({ baseUrl: model.url, model: "fake-local-7b", timeoutMs: 10000 }),
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

  await llmAgent.start();
  await askAgent.start();

  await askHost.send(["agent://localllm"], { kind: "request", subject: "calc", body: "21 + 21" });
  await until(() => answers.includes("42"), 10000);
  assert.deepEqual(answers, ["42"], "local-model agent computed and replied over the bus");

  await llmAgent.stop();
  await askAgent.stop();
  await model.close();
});

test("OpenAI-compat brain: presence/heartbeats do NOT hit the model server", async () => {
  const model = await fakeModelServer();
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // Short heartbeat — if presence reached the brain, hits() would climb.
  const llmHost = new NodeHost({ card: card("localllm2"), transport: hub.connect(), dataDir: dir, heartbeatMs: 30 });
  const llmAgent = new AutonomousAgent(llmHost, openaiCompatBrain({ baseUrl: model.url, model: "fake" }));
  const peerHost = new NodeHost({ card: card("peer"), transport: hub.connect(), dataDir: dir, heartbeatMs: 30 });

  await llmAgent.start();
  await peerHost.start();
  await new Promise((r) => setTimeout(r, 300)); // let many heartbeats fly
  assert.equal(model.hits(), 0, "no model calls from presence traffic");

  await llmAgent.stop();
  await peerHost.stop();
  await model.close();
});
