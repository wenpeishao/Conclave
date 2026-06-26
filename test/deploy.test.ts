import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * deploy/update.sh runs on an hourly systemd timer, so a crash isn't a one-off — it's a failed unit
 * every hour forever. The guards (skip on dirty tree / ahead-of-origin instead of crashing under
 * `set -e`) get teeth here against real git checkouts. Skips where bash isn't available.
 */

const pexec = promisify(execFile);
const UPDATE_SH = path.resolve("deploy/update.sh").replace(/\\/g, "/");
const gitc = (cwd: string, ...args: string[]) =>
  pexec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-C", cwd, ...args]);

async function bashAvailable(): Promise<boolean> {
  try {
    await pexec("bash", ["-c", "true"]);
    return true;
  } catch {
    return false;
  }
}

async function runUpdate(nodeDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await pexec("bash", [UPDATE_SH], { env: { ...process.env, CONCLAVE_DIR: nodeDir }, timeout: 30_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

async function fixture(): Promise<{ root: string; node: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "conclave-deploy-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const node = path.join(root, "node");
  await pexec("git", ["init", "--bare", "-b", "main", origin]);
  await pexec("git", ["clone", "-q", origin, seed]);
  await gitc(seed, "checkout", "-B", "main");
  writeFileSync(path.join(seed, "x.txt"), "A");
  await gitc(seed, "add", "-A");
  await gitc(seed, "commit", "-q", "-m", "A");
  await gitc(seed, "push", "-q", "origin", "main");
  await pexec("git", ["clone", "-q", origin, node]);
  return { root, node };
}

test("deploy/update.sh: no-op exit 0 when already current", { timeout: 60_000 }, async (t) => {
  if (!(await bashAvailable())) return t.skip("bash not available");
  const { root, node } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = await runUpdate(node);
  assert.equal(r.code, 0, `should exit 0 when current:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /already current/);
});

test("deploy/update.sh: a node AHEAD of origin skips gracefully (exit 0), doesn't crash the timer", { timeout: 60_000 }, async (t) => {
  if (!(await bashAvailable())) return t.skip("bash not available");
  const { root, node } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(node, "local.txt"), "hotfix"); // a local commit ahead of origin
  await gitc(node, "add", "-A");
  await gitc(node, "commit", "-q", "-m", "local hotfix");
  const r = await runUpdate(node);
  assert.equal(r.code, 0, `ahead-of-origin must exit 0, not crash under set -e:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /ahead|diverged|skipping/i);
});

test("deploy/update.sh: a dirty working tree skips gracefully (exit 0)", { timeout: 60_000 }, async (t) => {
  if (!(await bashAvailable())) return t.skip("bash not available");
  const { root, node } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(node, "x.txt"), "uncommitted-edit");
  const r = await runUpdate(node);
  assert.equal(r.code, 0, `dirty tree must exit 0, not crash:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /local changes|skipping/i);
});
