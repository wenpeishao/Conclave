import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pexec = promisify(execFile);

export interface SelfUpdateOpts {
  intervalMs?: number; // how often to check for a new version (default 1h)
  branch?: string; // tracked branch (default "main")
  repoRoot?: string; // git checkout to update (default: this package's repo)
  canRestart?: () => boolean; // skip a tick when false (e.g. mid-task) so we never interrupt work
  log?: (msg: string) => void;
  onUpdate?: () => void; // default: process.exit(0) — the supervisor restarts with the new code
}

/** Repo root inferred from this module's location: src/node/self-update.ts → ../.. */
function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * ONE self-update check (exported for tests). Fast-forwards the tracked branch and `npm install`s,
 * then invokes onUpdate so the supervisor restarts on the new code. Returns true iff it updated.
 *
 * Safety: only fast-forward (`--ff-only`), only when the tree is clean, and — critically — if the
 * install fails AFTER the pull, it ROLLS THE TREE BACK so a later tick retries instead of wedging
 * the node on stale in-memory code forever (HEAD would otherwise equal origin and never retry).
 */
export async function selfUpdateOnce(opts: SelfUpdateOpts = {}): Promise<boolean> {
  const branch = opts.branch ?? "main";
  const root = opts.repoRoot ?? repoRootFromHere();
  const log = opts.log ?? ((m) => console.log(`[self-update] ${m}`));
  const git = (...args: string[]) => pexec("git", ["-C", root, ...args]);
  try {
    await git("rev-parse", "--is-inside-work-tree"); // throws if not a git checkout → no-op
    // `npm install` rewrites package-lock.json whenever the local npm/platform disagrees with the
    // committed lock — which makes the tree dirty, which makes the gate below refuse to update
    // FOREVER, and silently. The install at the end of THIS function does it too, so a node could
    // self-update once and thereby disable all its future updates. A node has no business carrying
    // local lock edits, so drop that churn before deciding (real local changes still block).
    await git("checkout", "--", "package-lock.json").catch(() => {});
    // `--untracked-files=no`: an untracked file must not freeze the fleet either. Operators and
    // agents drop scratch into the checkout (a cutover script, a log, a scratch patch) and plain
    // --porcelain counts those as dirty — same silent permanent freeze as the lock churn, for a file
    // a fast-forward wouldn't even touch. Only TRACKED modifications are real local work worth
    // protecting; if an untracked file would actually collide, the pull below fails loudly instead.
    const { stdout: dirty } = await git("status", "--porcelain", "--untracked-files=no");
    if (dirty.trim()) return false; // real uncommitted local changes — don't touch
    await git("fetch", "--quiet", "origin", branch);
    const [{ stdout: head }, { stdout: remote }] = await Promise.all([
      git("rev-parse", "HEAD"),
      git("rev-parse", `origin/${branch}`),
    ]);
    if (head.trim() === remote.trim()) return false; // already current
    const oldHead = head.trim();
    log(`${oldHead.slice(0, 7)} → ${remote.trim().slice(0, 7)} — pulling…`);
    await git("pull", "--ff-only", "--quiet", "origin", branch);
    try {
      await pexec("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
        cwd: root,
        shell: process.platform === "win32", // npm is npm.cmd on Windows
      });
    } catch (installErr) {
      // The fast-forward already landed. Leaving HEAD advanced after a failed install would WEDGE the
      // node on stale in-memory code forever (next tick sees head===remote → no retry, and the
      // supervisor never restarts because we never exit). Roll the tree back so the next tick retries.
      await git("reset", "--hard", "--quiet", oldHead).catch(() => {});
      throw new Error(`npm install failed; rolled back to ${oldHead.slice(0, 7)} to retry: ${(installErr as Error).message.split("\n")[0]}`);
    }
    // The install may have rewritten the lock — undo that churn so the NEXT tick's dirty gate
    // doesn't lock this node out of all future updates.
    await git("checkout", "--", "package-lock.json").catch(() => {});
    log("updated — restarting to load new code");
    (opts.onUpdate ?? (() => process.exit(0)))();
    return true;
  } catch (e) {
    log(`skipped: ${(e as Error).message.split("\n")[0]}`);
    return false;
  }
}

/**
 * Built-in fleet self-update. A long-running node (`conclave work` / `agent`) calls this once and
 * thereafter keeps itself on the latest pushed code with ZERO manual steps forever — no external
 * timer, no one-off bootstrap. Returns a stop() handle.
 */
export function startSelfUpdate(opts: SelfUpdateOpts = {}): () => void {
  const intervalMs = opts.intervalMs ?? 3_600_000;
  let stopped = false;
  let checking = false;

  async function tick() {
    if (stopped || checking) return;
    if (opts.canRestart && !opts.canRestart()) return; // busy — retry next tick
    checking = true;
    try {
      await selfUpdateOnce(opts);
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const kick = setTimeout(tick, 30_000); // first check soon after start, once the node has settled
  kick.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(kick);
  };
}
