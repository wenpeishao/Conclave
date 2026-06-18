import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHub } from "../../src/transports/memory.js";
import { NodeHost } from "../../src/node/host.js";
import { AutonomousAgent } from "../../src/agent/runtime.js";
import { ollamaBrain } from "../../src/agent/brains/openai-compat.js";
import { ruleBrain } from "../../src/agent/brains/rule.js";
import { tmpDir, card, until } from "../helpers.js";

/**
 * LIVE test — requires a running Ollama with a pulled model. It self-skips if Ollama
 * isn't reachable, so it's safe to leave in. Run it for real with:
 *
 *   ollama serve            # in another terminal
 *   ollama pull llama3.2
 *   CONCLAVE_OLLAMA_MODEL=llama3.2 npm run test:live
 */
const BASE = "http://localhost:11434";
const MODEL = process.env.CONCLAVE_OLLAMA_MODEL ?? "llama3.2";

async function ollamaUp(): Promise<boolean> {
  try {
    const c = new AbortController();
    const id = setTimeout(() => c.abort(), 1000);
    const r = await fetch(`${BASE}/api/tags`, { signal: c.signal });
    clearTimeout(id);
    return r.ok;
  } catch {
    return false;
  }
}

test("live: a real Ollama-backed agent answers on the bus", async (t) => {
  if (!(await ollamaUp())) {
    t.skip(`Ollama not reachable at ${BASE} — start 'ollama serve' and pull ${MODEL}`);
    return;
  }

  const hub = new MemoryHub();
  const dir = await tmpDir();
  const llmHost = new NodeHost({ card: card("ollama"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const llm = new AutonomousAgent(
    llmHost,
    ollamaBrain(MODEL, { system: "You are terse. Answer in one short sentence.", timeoutMs: 60000 }),
  );

  const askHost = new NodeHost({ card: card("asker"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const replies: string[] = [];
  const recorder = ruleBrain([
    {
      when: (e) => e.kind === "response",
      reply: (e) => {
        replies.push(String(e.body));
        return null;
      },
    },
  ]);
  const askAgent = new AutonomousAgent(askHost, recorder);

  await llm.start();
  await askAgent.start();
  await askHost.send(["agent://ollama"], { kind: "request", subject: "q", body: "What is the capital of France? One word." });

  await until(() => replies.length >= 1, 70000);
  assert.ok(replies[0] && replies[0].length > 0, "got a non-empty answer from the local model");
  console.error(`[live:ollama] ${MODEL} replied: ${replies[0]}`);

  await llm.stop();
  await askAgent.stop();
});
