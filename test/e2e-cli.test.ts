import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * END-TO-END, through the REAL CLI as separate OS processes — the layer the 72 unit tests never
 * touched. The unit tests build `new NodeHost(...)` directly (always signed), so they proved the
 * ENGINE correct while every user-facing command went untested. This walks the actual journey a
 * person takes — serve → invite → join → send → inbox → roster — and would have caught the bugs
 * that only surfaced in live dogfooding (CLI `send` built an UNSIGNED host and silently failed in
 * secure mode; no `roster`/`inbox`; etc.). Green here means "a person can use it", not just
 * "the engine is correct".
 */

const pexec = promisify(execFile);
const CLI = path.resolve("src/cli.ts");
const NODE_ARGS = ["--import", "tsx", CLI];

// One-shot CLI invocation. Never throws — returns the exit code so tests assert on it explicitly.
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

function enrollTokenFrom(out: string): string | undefined {
  return /--enroll (\S+)/.exec(out)?.[1];
}

test("e2e: serve → invite → join → send (signed) → inbox (replay) → roster, all via the real CLI", { timeout: 90_000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "conclave-e2e-"));
  const CT = "e2e-connect-token";
  const AT = "e2e-admin-token";
  const wsPort = 9100 + (process.pid % 250);
  const httpPort = 9500 + (process.pid % 250);
  const WS = `ws://127.0.0.1:${wsPort}`;
  const HP = String(httpPort);

  // --- the real server, as its own process, in SECURE mode -------------------------------------
  const srv = spawn(
    "node",
    [...NODE_ARGS, "serve", "--port", String(wsPort), "--http", HP, "--data", path.join(dir, "srv"), "--token", CT, "--admin-token", AT],
    { stdio: "ignore" },
  );
  const bot = { proc: null as ReturnType<typeof spawn> | null };
  t.after(() => {
    bot.proc?.kill();
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  await waitForHttp(`http://127.0.0.1:${httpPort}/dashboard`, 20_000);

  const enroll = async (name: string) => {
    const inv = await cli(["invite", "--as", name, "--role", "w", "--admin-token", AT, "--url", WS, "--http-port", HP]);
    const tok = enrollTokenFrom(inv.stdout);
    assert.ok(tok, `invite for ${name} should print --enroll <token>; got:\n${inv.stdout}\n${inv.stderr}`);
    const j = await cli(["join", "--as", name, "--enroll", tok!, "--url", WS, "--token", CT, "--http-port", HP, "--data", path.join(dir, name)]);
    assert.equal(j.code, 0, `join for ${name} failed:\n${j.stdout}\n${j.stderr}`);
  };

  // --- a device and a peer enroll through the CLI ----------------------------------------------
  await enroll("dev");
  await enroll("peer");

  // --- THE regression: CLI `send` must connect + SIGN in secure mode (this silently failed before)
  const sent = await cli(["send", "--as", "dev", "--to", "hub", "--body", "hello from e2e", "--url", WS, "--token", CT, "--data", path.join(dir, "dev")]);
  assert.match(sent.stdout, /sent to/, `secure-mode CLI send must succeed (was building an unsigned host):\n${sent.stdout}\n${sent.stderr}`);

  // --- inbox replay: peer messages dev while dev is offline; `conclave inbox` must surface it ----
  const sentToDev = await cli(["send", "--as", "peer", "--to", "dev", "--subject", "ping", "--body", "INBOX_MARKER_42", "--url", WS, "--token", CT, "--data", path.join(dir, "peer")]);
  assert.match(sentToDev.stdout, /sent to/, `peer→dev send failed:\n${sentToDev.stdout}\n${sentToDev.stderr}`);
  const inbox = await cli(["inbox", "--as", "dev", "--url", WS, "--token", CT, "--data", path.join(dir, "dev")]);
  assert.match(inbox.stdout, /INBOX_MARKER_42/, `inbox must replay the message sent while offline:\n${inbox.stdout}\n${inbox.stderr}`);

  // --- roster: a persistent agent must show up via GET /roster (connect-token, not admin) --------
  await enroll("bot");
  bot.proc = spawn("node", [...NODE_ARGS, "agent", "--as", "bot", "--brain", "echo", "--no-self-update", "--url", WS, "--token", CT, "--data", path.join(dir, "bot")], { stdio: "ignore" });
  // give the agent a moment to connect + beat presence
  await new Promise((r) => setTimeout(r, 4000));
  const roster = await cli(["roster", "--as", "dev", "--url", WS, "--token", CT, "--http-port", HP]);
  assert.match(roster.stdout, /online/, `roster command must reach /roster and print a roster:\n${roster.stdout}\n${roster.stderr}`);
  assert.match(roster.stdout, /agent:\/\/bot/, `a persistently-connected agent must appear in the roster:\n${roster.stdout}\n${roster.stderr}`);
});
