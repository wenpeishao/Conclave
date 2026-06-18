import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { MemoryHub } from "../../src/transports/memory.js";
import { NodeHost } from "../../src/node/host.js";
import { AutonomousAgent } from "../../src/agent/runtime.js";
import { codexBrain } from "../../src/agent/brains/cli.js";
import { ruleBrain } from "../../src/agent/brains/rule.js";
import { tmpDir, card, until } from "../helpers.js";

/**
 * LIVE test — requires the OpenAI Codex CLI installed and authenticated. Self-skips if
 * `codex` isn't on PATH. Run for real with:
 *
 *   npm i -g @openai/codex   # and authenticate
 *   npm run test:live
 *
 * Note: `codex exec` can be slow and prints reasoning; the default parser returns cleaned
 * stdout, so we only assert a non-empty reply here.
 */
const WIN = process.platform === "win32";

function codexAvailable(): boolean {
  try {
    const r = spawnSync("codex", ["--version"], { shell: WIN });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

test("live: a real Codex CLI agent answers on the bus", async (t) => {
  if (!codexAvailable()) {
    t.skip("codex CLI not found on PATH — `npm i -g @openai/codex` and authenticate");
    return;
  }

  const hub = new MemoryHub();
  const dir = await tmpDir();
  const codexHost = new NodeHost({ card: card("codex"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const codex = new AutonomousAgent(codexHost, codexBrain({ shell: WIN, timeoutMs: 120000 }));

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

  await codex.start();
  await askAgent.start();
  await askHost.send(["agent://codex"], { kind: "request", subject: "q", body: "Reply with exactly: pong" });

  await until(() => replies.length >= 1, 130000);
  assert.ok(replies[0] && replies[0].length > 0, "got a non-empty reply from codex");
  console.error(`[live:codex] replied: ${replies[0].slice(0, 120)}`);

  await codex.stop();
  await askAgent.stop();
});
