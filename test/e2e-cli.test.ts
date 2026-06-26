import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * END-TO-END, through the REAL CLI as separate OS processes — the layer the unit tests never
 * touched. They build `new NodeHost(...)` directly (always signed), so they proved the ENGINE
 * correct while every user-facing command went untested. These walk the actual journeys a person
 * takes and have TEETH: each asserts a behaviour that a confirmed bug broke. Green here means
 * "a person can use it", not just "the engine is correct".
 */

const pexec = promisify(execFile);
const CLI = path.resolve("src/cli.ts");
const NODE_ARGS = ["--import", "tsx", CLI];

async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await pexec("node", [...NODE_ARGS, ...args], { timeout: 30_000 });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server HTTP never came up: ${url}`);
}

const CT = "e2e-connect-token";
const AT = "e2e-admin-token";

// Spin a real secure server on per-test ports; returns its params + an enroll helper + cleanup hooks.
async function secureBus(t: { after: (fn: () => void) => void }, idx: number) {
  const dir = mkdtempSync(path.join(tmpdir(), "conclave-e2e-"));
  const wsPort = 9100 + (process.pid % 180) + idx * 4;
  const httpPort = 9500 + (process.pid % 180) + idx * 4;
  const WS = `ws://127.0.0.1:${wsPort}`;
  const HP = String(httpPort);
  const kids: ChildProcess[] = [];
  const srv = spawn(
    "node",
    [...NODE_ARGS, "serve", "--port", String(wsPort), "--http", HP, "--data", path.join(dir, "srv"), "--token", CT, "--admin-token", AT],
    { stdio: "ignore" },
  );
  kids.push(srv);
  t.after(() => {
    for (const k of kids) k.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await waitForHttp(`http://127.0.0.1:${httpPort}/dashboard`, 20_000);

  const enroll = async (name: string) => {
    const inv = await cli(["invite", "--as", name, "--role", "w", "--admin-token", AT, "--url", WS, "--http-port", HP]);
    const tok = /--enroll (\S+)/.exec(inv.stdout)?.[1];
    assert.ok(tok, `invite for ${name} should print --enroll <token>; got:\n${inv.stdout}\n${inv.stderr}`);
    const j = await cli(["join", "--as", name, "--enroll", tok!, "--url", WS, "--token", CT, "--http-port", HP, "--data", path.join(dir, name)]);
    assert.equal(j.code, 0, `join for ${name} failed:\n${j.stdout}\n${j.stderr}`);
  };
  const data = (name: string) => path.join(dir, name);
  return { WS, HP, dir, enroll, data, spawnKid: (args: string[]) => { const p = spawn("node", [...NODE_ARGS, ...args], { stdio: "ignore" }); kids.push(p); return p; } };
}

test("e2e: serve → invite → join → send(signed) → inbox(replay) → roster, via the real CLI", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 0);
  await bus.enroll("dev");
  await bus.enroll("peer");

  // THE original regression: CLI `send` must connect + SIGN in secure mode.
  const sent = await cli(["send", "--as", "dev", "--to", "hub", "--body", "hello", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);
  assert.match(sent.stdout, /sent to/, `secure-mode CLI send must succeed:\n${sent.stdout}\n${sent.stderr}`);

  // inbox replay: peer → dev while dev is offline; `conclave inbox` must surface it.
  await cli(["send", "--as", "peer", "--to", "dev", "--subject", "ping", "--body", "INBOX_MARKER_42", "--url", bus.WS, "--token", CT, "--data", bus.data("peer")]);
  const inbox = await cli(["inbox", "--as", "dev", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);
  assert.match(inbox.stdout, /INBOX_MARKER_42/, `inbox must replay the offline message:\n${inbox.stdout}\n${inbox.stderr}`);

  // roster: a persistently-connected agent shows up via GET /roster.
  await bus.enroll("bot");
  bus.spawnKid(["agent", "--as", "bot", "--brain", "echo", "--no-self-update", "--url", bus.WS, "--token", CT, "--data", bus.data("bot")]);
  await new Promise((r) => setTimeout(r, 4000));
  const roster = await cli(["roster", "--as", "dev", "--url", bus.WS, "--token", CT, "--http-port", bus.HP]);
  assert.match(roster.stdout, /agent:\/\/bot/, `a connected agent must appear in the roster:\n${roster.stdout}\n${roster.stderr}`);
});

test("e2e: `send --to \"*\"` broadcast actually lands in a peer's inbox", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 1);
  await bus.enroll("ann");
  await bus.enroll("bee"); // bee's cursor now precedes the broadcast

  // The documented fleet broadcast. Was addressed to a nonexistent agent://* and went nowhere.
  const b = await cli(["send", "--as", "ann", "--to", "*", "--kind", "event", "--subject", "ann", "--body", "BCAST_MARKER_99", "--url", bus.WS, "--token", CT, "--data", bus.data("ann")]);
  assert.match(b.stdout, /sent to/, `broadcast send should report sent:\n${b.stdout}\n${b.stderr}`);

  // bee runs plain inbox (NO --events): an explicit broadcast must be visible.
  const inbox = await cli(["inbox", "--as", "bee", "--url", bus.WS, "--token", CT, "--data", bus.data("bee")]);
  assert.match(inbox.stdout, /BCAST_MARKER_99/, `broadcast must reach a peer's inbox:\n${inbox.stdout}\n${inbox.stderr}`);
});

test("e2e: `send` doesn't eat the inbox cursor, and `inbox` is idempotent across processes", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 3);
  await bus.enroll("dev");
  await bus.enroll("peer");

  // peer messages dev while dev is OFFLINE — this is unread inbox waiting for dev.
  await cli(["send", "--as", "peer", "--to", "dev", "--body", "MARKER_BEFORE", "--url", bus.WS, "--token", CT, "--data", bus.data("peer")]);
  // dev now runs its OWN send on the SAME --data dir. It must NOT advance/consume dev's read cursor.
  await cli(["send", "--as", "dev", "--to", "hub", "--body", "x", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);

  const first = await cli(["inbox", "--as", "dev", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);
  assert.match(first.stdout, /MARKER_BEFORE/, `'send' must not swallow dev's unread inbox (data loss):\n${first.stdout}\n${first.stderr}`);

  // run inbox AGAIN as a fresh process: the durable cursor must have persisted → only-newer (empty).
  const second = await cli(["inbox", "--as", "dev", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);
  assert.doesNotMatch(second.stdout, /MARKER_BEFORE/, `inbox must be idempotent across processes (cursor persisted):\n${second.stdout}\n${second.stderr}`);
});

test("e2e: /roster does not leak zone topology to a connect-token-only caller", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 5);
  // enroll an agent INTO a zone, then bring it online
  const inv = await cli(["invite", "--as", "zoner", "--role", "w", "--zone", "s-secret", "--admin-token", AT, "--url", bus.WS, "--http-port", bus.HP]);
  const tok = /--enroll (\S+)/.exec(inv.stdout)?.[1];
  assert.ok(tok, `invite --zone should print an enroll token:\n${inv.stdout}\n${inv.stderr}`);
  await cli(["join", "--as", "zoner", "--enroll", tok!, "--url", bus.WS, "--token", CT, "--http-port", bus.HP, "--data", bus.data("zoner")]);
  bus.spawnKid(["agent", "--as", "zoner", "--brain", "echo", "--no-self-update", "--zone", "s-secret", "--url", bus.WS, "--token", CT, "--data", bus.data("zoner")]);
  await new Promise((r) => setTimeout(r, 4000));

  // A connect-token-only roster: discovery is global (zoner is visible), but its ZONE must be redacted.
  const roster = await cli(["roster", "--as", "zoner", "--url", bus.WS, "--token", CT, "--http-port", bus.HP]);
  assert.match(roster.stdout, /agent:\/\/zoner/, `zoner should be visible — discovery is global:\n${roster.stdout}\n${roster.stderr}`);
  assert.doesNotMatch(roster.stdout, /s-secret/, `zone topology must NOT leak to a connect-token caller:\n${roster.stdout}\n${roster.stderr}`);
});

test("e2e: the human cockpit connects SIGNED in secure mode (was rejected unsigned)", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 2);
  await bus.enroll("cockpit");

  // `conclave human` builds a host and joins the bus. In secure mode an UNSIGNED host is refused at
  // the challenge → never appears online. Signed (the fix) → it connects and shows in the roster.
  bus.spawnKid(["human", "--as", "cockpit", "--port", String(7300 + (process.pid % 150)), "--url", bus.WS, "--token", CT, "--data", bus.data("cockpit")]);
  await new Promise((r) => setTimeout(r, 4500));
  const roster = await cli(["roster", "--as", "cockpit", "--url", bus.WS, "--token", CT, "--http-port", bus.HP]);
  assert.match(roster.stdout, /agent:\/\/cockpit/, `the human cockpit must connect (signed) and appear online:\n${roster.stdout}\n${roster.stderr}`);
});
