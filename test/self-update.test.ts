import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { selfUpdateOnce } from "../src/node/self-update.js";

/**
 * The built-in fleet self-update, exercised against REAL git repos. The promise is "a deployed node
 * keeps itself on latest with zero manual steps forever" — so the two things that would silently
 * break that get teeth here: (1) a node one commit behind actually fast-forwards + restarts,
 * (2) a FAILED `npm install` rolls back instead of wedging the node on stale code forever, and
 * (3) package-lock churn from `npm install` does NOT gate the node out of every future update —
 *     the failure that silently froze a real fleet, because the updater's own install caused it.
 */

const pexec = promisify(execFile);

const gitc = (cwd: string, ...args: string[]) =>
  pexec("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-C", cwd, ...args]);
const headOf = async (dir: string) => (await pexec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();

async function fixture(): Promise<{ root: string; node: string; seed: string; commitA: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "conclave-su-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const node = path.join(root, "node");
  await pexec("git", ["init", "--bare", "-b", "main", origin]);
  await pexec("git", ["clone", "-q", origin, seed]);
  await gitc(seed, "checkout", "-B", "main");
  writeFileSync(path.join(seed, "package.json"), JSON.stringify({ name: "su-fixture", version: "1.0.0", private: true }));
  writeFileSync(path.join(seed, "marker.txt"), "A");
  await gitc(seed, "add", "-A");
  await gitc(seed, "commit", "-q", "-m", "A");
  await gitc(seed, "push", "-q", "origin", "main");
  await pexec("git", ["clone", "-q", origin, node]);
  return { root, node, seed, commitA: await headOf(node) };
}

const advance = async (seed: string, files: Record<string, string>, msg: string) => {
  for (const [f, c] of Object.entries(files)) writeFileSync(path.join(seed, f), c);
  await gitc(seed, "add", "-A");
  await gitc(seed, "commit", "-q", "-m", msg);
  await gitc(seed, "push", "-q", "origin", "main");
};

test("self-update: a node one commit behind fast-forwards and triggers restart", { timeout: 60_000 }, async (t) => {
  const { root, node, seed, commitA } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await advance(seed, { "marker.txt": "B" }, "B"); // good commit (no deps → install is a fast no-op)

  let fired = false;
  const updated = await selfUpdateOnce({ repoRoot: node, branch: "main", log: () => {}, onUpdate: () => { fired = true; } });

  assert.equal(updated, true, "should report it updated");
  assert.equal(fired, true, "onUpdate (restart) must fire so the supervisor relaunches on new code");
  assert.notEqual(await headOf(node), commitA, "node HEAD must have advanced past A");
});

test("self-update: package-lock churn from npm install must not freeze a node forever", { timeout: 60_000 }, async (t) => {
  const { root, node, seed, commitA } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The repo tracks a lock (conclave does) and this node has it…
  await advance(seed, { "package-lock.json": JSON.stringify({ name: "su-fixture", lockfileVersion: 3 }) }, "add lock");
  await gitc(node, "pull", "-q", "--ff-only", "origin", "main");
  // …which its own `npm install` then rewrote — exactly what npm does when the local npm/platform
  // disagrees with the committed lock. Before the fix this dirty tree silently disabled ALL updates.
  writeFileSync(path.join(node, "package-lock.json"), JSON.stringify({ name: "su-fixture", lockfileVersion: 3, churn: true }));
  await advance(seed, { "marker.txt": "B" }, "B");

  let fired = false;
  const updated = await selfUpdateOnce({ repoRoot: node, branch: "main", log: () => {}, onUpdate: () => { fired = true; } });

  assert.equal(updated, true, "lock churn must not gate the update — it froze every node that ran npm install");
  assert.equal(fired, true, "onUpdate (restart) must still fire");
  assert.notEqual(await headOf(node), commitA, "node HEAD must have advanced past A");
});

test("self-update: a REAL uncommitted change still blocks the update", { timeout: 60_000 }, async (t) => {
  const { root, node, seed } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await advance(seed, { "marker.txt": "B" }, "B");
  writeFileSync(path.join(node, "marker.txt"), "LOCAL EDIT"); // someone is debugging on this box

  const updated = await selfUpdateOnce({ repoRoot: node, branch: "main", log: () => {}, onUpdate: () => {} });

  assert.equal(updated, false, "the lock exemption must not become a licence to clobber real local work");
});

test("self-update: a FAILED npm install rolls back (no wedge) so a later tick retries", { timeout: 60_000 }, async (t) => {
  const { root, node, seed, commitA } = await fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // origin advances by a commit whose package.json BREAKS `npm install` (a preinstall hook that
  // exits non-zero — deterministic across platforms, unlike a missing file: dep npm may tolerate).
  await advance(
    seed,
    { "package.json": JSON.stringify({ name: "su-fixture", version: "1.0.1", private: true, scripts: { preinstall: "exit 1" } }) },
    "bad-deps",
  );

  let fired = false;
  const updated = await selfUpdateOnce({ repoRoot: node, branch: "main", log: () => {}, onUpdate: () => { fired = true; } });

  assert.equal(updated, false, "a failed install must NOT report success");
  assert.equal(fired, false, "must NOT restart onto a broken install");
  assert.equal(await headOf(node), commitA, "node must roll back to A so the next tick retries (not wedge on an advanced HEAD)");
});
