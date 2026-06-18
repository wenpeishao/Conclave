import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryHub } from "../src/transports/memory.js";
import { NodeHost } from "../src/node/host.js";
import { AutonomousAgent } from "../src/agent/runtime.js";
import { echoBrain } from "../src/agent/brains/rule.js";
import { HumanServer } from "../src/agent/human-server.js";
import { tmpDir, card, until } from "./helpers.js";

test("human server bridges a person to the bus (HTTP in → bus → bot → bus → HTTP out)", async () => {
  const hub = new MemoryHub();
  const dir = await tmpDir();

  // A bot on the bus that echoes whatever it's told.
  const botHost = new NodeHost({ card: card("bot"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const bot = new AutonomousAgent(botHost, echoBrain());

  // The human, exposed over HTTP.
  const humanHost = new NodeHost({ card: card("me"), transport: hub.connect(), dataDir: dir, heartbeatMs: 60000 });
  const server = new HumanServer({ host: humanHost, port: 0 });

  await bot.start();
  await server.start();
  const base = `http://127.0.0.1:${server.port()}`;

  // The human sends to the bot via the web API.
  const sendRes = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "bot", body: "hello bus" }),
  });
  assert.equal(sendRes.status, 200);

  // The bot echoes; the human's inbox (via the API) should show it.
  let seen = false;
  await until(async () => {
    const r = await fetch(`${base}/api/messages`);
    const d = (await r.json()) as { messages: { from: string; body: string }[] };
    seen = d.messages.some((m) => m.from === "agent://bot" && m.body === "echo: hello bus");
    return seen;
  }, 5000);
  assert.ok(seen, "the human saw the bot's reply through the web API");

  // The roster should list the bot.
  const r = await fetch(`${base}/api/messages`);
  const d = (await r.json()) as { roster: { id: string }[]; self: string };
  assert.equal(d.self, "agent://me");
  assert.ok(d.roster.some((a) => a.id === "agent://bot"), "roster includes the bot");

  // The UI page renders.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Conclave/);

  await bot.stop();
  await server.stop();
});
