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
 * Built-in fleet self-update. A long-running node (`conclave work` / `agent`) calls this once and
 * thereafter keeps itself on the latest pushed code with ZERO manual steps — no external timer, no
 * one-off bootstrap. On finding the tracked branch ahead it fast-forwards, `npm install`s, and exits
 * so the supervisor (systemd `Restart=always`, or any process manager) relaunches with the new code.
 *
 * Safety: only fast-forward (`--ff-only`), only when the working tree is clean (never clobbers local
 * edits), only when `canRestart()` allows (never mid-task). A node installed without git just no-ops.
 */
export function startSelfUpdate(opts: SelfUpdateOpts = {}): () => void {
  const intervalMs = opts.intervalMs ?? 3_600_000;
  const branch = opts.branch ?? "main";
  const root = opts.repoRoot ?? repoRootFromHere();
  const log = opts.log ?? ((m) => console.log(`[self-update] ${m}`));
  const git = (...args: string[]) => pexec("git", ["-C", root, ...args]);
  let stopped = false;
  let checking = false;

  async function check() {
    if (stopped || checking) return;
    if (opts.canRestart && !opts.canRestart()) return; // busy — retry next tick
    checking = true;
    try {
      await git("rev-parse", "--is-inside-work-tree"); // throws if not a git checkout → no-op
      const { stdout: dirty } = await git("status", "--porcelain");
      if (dirty.trim()) return; // uncommitted local changes — don't touch
      await git("fetch", "--quiet", "origin", branch);
      const [{ stdout: head }, { stdout: remote }] = await Promise.all([
        git("rev-parse", "HEAD"),
        git("rev-parse", `origin/${branch}`),
      ]);
      if (head.trim() === remote.trim()) return; // already current
      log(`${head.trim().slice(0, 7)} → ${remote.trim().slice(0, 7)} — pulling…`);
      await git("pull", "--ff-only", "--quiet", "origin", branch);
      await pexec("npm", ["install", "--no-audit", "--no-fund", "--silent"], {
        cwd: root,
        shell: process.platform === "win32", // npm is npm.cmd on Windows
      });
      log("updated — restarting to load new code");
      (opts.onUpdate ?? (() => process.exit(0)))();
    } catch (e) {
      log(`skipped: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      checking = false;
    }
  }

  const timer = setInterval(check, intervalMs);
  timer.unref?.();
  const kick = setTimeout(check, 30_000); // first check soon after start, once the node has settled
  kick.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(kick);
  };
}
