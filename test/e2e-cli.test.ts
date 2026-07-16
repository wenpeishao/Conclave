import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

test("e2e: `send` with no enrolled identity does NOT falsely report success in secure mode", { timeout: 90_000 }, async (t) => {
  const bus = await secureBus(t, 6);
  await bus.enroll("dev");

  // "ghost" has NO identity (empty data dir) → in secure mode the server refuses it. The send must
  // NOT print an acknowledged success, and nothing may actually be delivered.
  const ghostDir = path.join(bus.dir, "ghost-empty");
  const r = await cli(["send", "--as", "ghost", "--to", "dev", "--subject", "x", "--body", "GHOST_MARKER", "--url", bus.WS, "--token", CT, "--data", ghostDir]);
  // The bug: cmdSend's final STDOUT line was "[conclave] sent to dev" (looks like success) even when
  // the server refused the unenrolled connection. The fix prints "queued … NOT ENROLLED …" instead.
  // Assert on STDOUT specifically (the transport's rejection log goes to stderr regardless).
  assert.doesNotMatch(r.stdout, /sent to dev/i, `an unenrolled send must NOT print a plain "sent to dev" success on stdout:\n${r.stdout}`);
  assert.match(r.stdout, /not enrolled|no server ack|queued|rejected/i, `it should say why nothing was delivered:\n${r.stdout}`);

  const inbox = await cli(["inbox", "--as", "dev", "--url", bus.WS, "--token", CT, "--data", bus.data("dev")]);
  assert.doesNotMatch(inbox.stdout, /GHOST_MARKER/, `an unenrolled send must not be delivered:\n${inbox.stdout}\n${inbox.stderr}`);
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

test("e2e: device agent — a commander spawns a worker over the bus; a non-commander is refused", { timeout: 150_000 }, async (t) => {
  const bus = await secureBus(t, 7);
  await bus.enroll("dev-host"); // the device agent
  await bus.enroll("admin"); // the allowlisted commander
  await bus.enroll("intruder"); // an enrolled-but-not-commander peer

  // admin pre-mints an enroll token for the worker the device will spawn.
  const inv = await cli(["invite", "--as", "worker1", "--role", "w", "--admin-token", AT, "--url", bus.WS, "--http-port", bus.HP]);
  const wtok = /--enroll (\S+)/.exec(inv.stdout)?.[1];
  assert.ok(wtok, `invite worker1:\n${inv.stdout}\n${inv.stderr}`);

  // start the device agent — only agent://admin may command it.
  bus.spawnKid(["host", "--as", "dev-host", "--commander", "agent://admin", "--url", bus.WS, "--token", CT, "--http-port", bus.HP, "--data", bus.data("dev-host")]);
  await new Promise((r) => setTimeout(r, 4500));

  const roster = async () => (await cli(["roster", "--as", "admin", "--url", bus.WS, "--token", CT, "--http-port", bus.HP])).stdout;
  assert.match(await roster(), /agent:\/\/dev-host/, "the device agent itself must be online");

  // (1) a NON-commander tries to spawn → must be refused (worker-evil never appears).
  await cli(["send", "--as", "intruder", "--to", "dev-host", "--kind", "request", "--body",
    JSON.stringify({ op: "spawn", name: "worker-evil", kind: "agent", brain: "echo" }),
    "--url", bus.WS, "--token", CT, "--data", bus.data("intruder")]);

  // (2) the COMMANDER spawns worker1 → device enrolls + launches it → it comes online.
  await cli(["send", "--as", "admin", "--to", "dev-host", "--kind", "request", "--body",
    JSON.stringify({ op: "spawn", name: "worker1", kind: "agent", brain: "echo", enroll: wtok }),
    "--url", bus.WS, "--token", CT, "--data", bus.data("admin")]);

  let r = "";
  for (let i = 0; i < 25 && !/agent:\/\/worker1/.test(r); i++) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await roster();
  }
  assert.match(r, /agent:\/\/worker1/, `the commander's spawn must bring worker1 online:\n${r}`);
  assert.doesNotMatch(r, /worker-evil/, `a non-commander's spawn must be refused (no worker-evil):\n${r}`);
});

test("e2e: device agent — resume brings a persisted worker back after a host restart (no re-enroll)", { timeout: 180_000 }, async (t) => {
  const bus = await secureBus(t, 11);
  await bus.enroll("dev2"); // the device agent
  await bus.enroll("boss"); // the allowlisted commander (the device's manager node)

  // boss pre-mints one enroll token — used only for the FIRST spawn; resume must NOT need it.
  const inv = await cli(["invite", "--as", "task1", "--role", "w", "--admin-token", AT, "--url", bus.WS, "--http-port", bus.HP]);
  const wtok = /--enroll (\S+)/.exec(inv.stdout)?.[1];
  assert.ok(wtok, `invite task1:\n${inv.stdout}\n${inv.stderr}`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const roster = async () => (await cli(["roster", "--as", "boss", "--url", bus.WS, "--token", CT, "--http-port", bus.HP])).stdout;
  const command = (body: object) => cli(["send", "--as", "boss", "--to", "dev2", "--kind", "request", "--body", JSON.stringify(body), "--url", bus.WS, "--token", CT, "--data", bus.data("boss")]);
  const hostArgs = ["host", "--as", "dev2", "--commander", "agent://boss", "--url", bus.WS, "--token", CT, "--http-port", bus.HP, "--data", bus.data("dev2")];
  // a host variant that captures stdout, so we can assert on its log deterministically.
  const captureHost = () => {
    const p = spawn("node", [...NODE_ARGS, ...hostArgs], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout?.on("data", (d) => (out += d.toString()));
    p.stderr?.on("data", (d) => (out += d.toString()));
    t.after(() => p.kill());
    return { p, out: () => out };
  };

  // --- host A: commander spawns task1 (enrolls + launches) → online, spec persisted to _specs.json.
  const hostA = bus.spawnKid(hostArgs);
  await sleep(4500);
  await command({ op: "spawn", name: "task1", kind: "agent", brain: "echo", enroll: wtok });
  let r = "";
  for (let i = 0; i < 25 && !/agent:\/\/task1/.test(r); i++) { await sleep(1000); r = await roster(); }
  assert.match(r, /agent:\/\/task1/, `spawn must bring task1 online:\n${r}`);

  // --- simulate a device restart / host crash: kill host A.
  hostA.kill();
  await sleep(2500);

  // --- host B on the SAME --data dir: must LOAD the persisted spec (this is what survives a reboot).
  const hostB = captureHost();
  await sleep(4500);
  assert.match(hostB.out(), /loaded 1 known agent spec/i, `a restarted host must load the persisted spec:\n${hostB.out()}`);
  assert.match(hostB.out(), /resumable: task1/i, `the persisted spec must name task1 as resumable:\n${hostB.out()}`);

  // --- resume with NO enroll token → relaunch from the spec, same identity/data dir → back online.
  await command({ op: "resume", name: "task1" });
  for (let i = 0; i < 20 && !/launched agent task1/i.test(hostB.out()); i++) await sleep(1000);
  assert.match(hostB.out(), /launched agent task1/i, `resume must relaunch task1 from the persisted spec (no re-enroll):\n${hostB.out()}`);
  r = "";
  for (let i = 0; i < 25 && !/agent:\/\/task1/.test(r); i++) { await sleep(1000); r = await roster(); }
  assert.match(r, /agent:\/\/task1/, `resumed task1 must be back online:\n${r}`);

  // --- stop = deprovision: the spec is forgotten, so a later resume must FAIL (not resurrect it).
  await command({ op: "stop", name: "task1" });
  await sleep(2500);
  const before = hostB.out().length;
  await command({ op: "resume", name: "task1" });
  await sleep(2500);
  assert.doesNotMatch(hostB.out().slice(before), /launched agent task1/i, `a stopped (deprovisioned) agent must NOT be resumable:\n${hostB.out().slice(before)}`);
});

test("e2e: device agent — an rc spawn wires the conclave MCP into a pre-trusted workspace + returns the claude.ai link", { timeout: 150_000 }, async (t) => {
  const bus = await secureBus(t, 15);
  await bus.enroll("dev3"); // the device agent
  await bus.enroll("boss3"); // the commander (manager node)

  const inv = await cli(["invite", "--as", "task2", "--role", "w", "--admin-token", AT, "--url", bus.WS, "--http-port", bus.HP]);
  const wtok = /--enroll (\S+)/.exec(inv.stdout)?.[1];
  assert.ok(wtok, `invite task2:\n${inv.stdout}\n${inv.stderr}`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // a STUB `claude`: prints the connect link (proving the host's capture path) then stays alive
  // like a real remote-control server — so we test the RC plumbing without a real login/subscription.
  const stub = path.join(bus.dir, "claude-stub.mjs");
  // prints the link then EXITS (a real remote-control server stays up, but a lingering grandchild
  // would keep the test process from exiting on Windows — launchRC captures the link either way).
  writeFileSync(stub, `process.stdout.write("remote-control up\\n");\nprocess.stdout.write("Steer it here: https://claude.ai/code?environment=env_STUBTASK2\\n");\n`);
  const claudeConfig = path.join(bus.dir, "claude.json"); // isolated ~/.claude.json — never touch the real one

  const command = (body: object) => cli(["send", "--as", "boss3", "--to", "dev3", "--kind", "request", "--body", JSON.stringify(body), "--url", bus.WS, "--token", CT, "--data", bus.data("boss3")]);
  const hostArgs = ["host", "--as", "dev3", "--commander", "agent://boss3", "--url", bus.WS, "--token", CT, "--http-port", bus.HP, "--data", bus.data("dev3"), "--claude-bin", `node "${stub}"`, "--claude-config", claudeConfig];
  const p = spawn("node", [...NODE_ARGS, ...hostArgs], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout?.on("data", (d) => (out += d.toString()));
  p.stderr?.on("data", (d) => (out += d.toString()));
  // TREE-kill and AWAIT exit: the host spawns a `claude remote-control` grandchild (via shell) that
  // runs forever; a plain p.kill() on Windows leaves the tree alive → the child handle keeps the test
  // process from exiting. taskkill /T reaps the whole tree; awaiting p's exit releases the handle.
  t.after(() => new Promise<void>((resolve) => {
    p.once("exit", () => resolve());
    if (process.platform === "win32" && p.pid) { try { spawn("taskkill", ["/F", "/T", "/PID", String(p.pid)]); } catch { p.kill(); } }
    else p.kill();
    setTimeout(resolve, 6000); // fallback so teardown can't hang
  }));
  await sleep(4500);

  // --- rc spawn: enroll task2 + prepare workspace + launch remote-control + capture the link.
  await command({ op: "spawn", name: "task2", kind: "agent", rc: true, enroll: wtok });
  for (let i = 0; i < 30 && !/rc task2 link:/i.test(out); i++) await sleep(1000);
  assert.match(out, /launched rc task2/i, `rc spawn must launch a remote-control session:\n${out}`);
  assert.match(out, /rc task2 link: https:\/\/claude\.ai\/code\?environment=env_STUBTASK2/i, `the host must capture + surface the claude.ai link:\n${out}`);

  // --- the workspace must be pre-trusted AND have the conclave MCP wired (so the session is on the bus).
  const cfg = JSON.parse(readFileSync(claudeConfig, "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean; mcpServers?: Record<string, { args?: string[] }> }> };
  const workspace = path.join(bus.data("dev3"), "task2", "workspace");
  const proj = cfg.projects?.[workspace];
  assert.ok(proj, `the workspace must be registered in claude config:\n${JSON.stringify(cfg.projects, null, 2)}`);
  assert.equal(proj!.hasTrustDialogAccepted, true, "the workspace must be pre-trusted (no headless trust-dialog block)");
  const mcpArgs = proj!.mcpServers?.conclave?.args ?? [];
  assert.ok(mcpArgs.includes("mcp") && mcpArgs.includes("task2"), `the conclave MCP must be wired as agent://task2:\n${JSON.stringify(mcpArgs)}`);

  // --- resume relaunches remote-control from the persisted rc spec (no re-enroll).
  await command({ op: "stop", name: "task2" });
  await sleep(2000);
  const mark = out.length;
  await command({ op: "resume", name: "task2" });
  await sleep(2000);
  // stop deprovisioned it → resume must NOT relaunch (proves rc specs obey the same stop=forget rule).
  assert.doesNotMatch(out.slice(mark), /launched rc task2/i, `a stopped rc node must not be resurrected:\n${out.slice(mark)}`);
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
