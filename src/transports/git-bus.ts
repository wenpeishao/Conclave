import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Transport } from "../core/transport.js";
import type { Envelope } from "../core/types.js";

const exec = promisify(execFile);

/**
 * Git-as-message-bus. This is the transport that answers the CHTC pain points:
 *   - no server, no Docker — just `git` (present on every dev/HPC box)
 *   - pull-based — works from outbound-only / connect-in-blocked networks
 *   - every message is a commit — durable, ordered, diffable, auditable; broker
 *     death cannot lose a message
 *
 * Conflict-free by construction (the cifn-chtc lesson): each agent writes ONLY to
 * its own subdir bus/<agentDir>/<ulid>.json, so concurrent producers never collide;
 * `pull --rebase` lines up commits. Replay cursor = highest ULID processed; because
 * ULIDs sort chronologically, "id <= cursor → already seen" is exact across restarts.
 */
export interface GitBusOpts {
  repoDir: string; // a working clone of the bus repo
  agentDir: string; // this agent's exclusive subdir name (no slashes)
  remote?: boolean; // push/pull to origin (false = purely local repo, for tests)
  branch?: string;
  pollMs?: number;
}

export class GitBusTransport implements Transport {
  private repo: string;
  private agentDir: string;
  private remote: boolean;
  private branch: string;
  private pollMs: number;
  private handler: ((e: Envelope, c: string | null) => void) | null = null;
  private cursor: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private busy = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(o: GitBusOpts) {
    this.repo = o.repoDir;
    this.agentDir = o.agentDir.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.remote = o.remote ?? false;
    this.branch = o.branch ?? "main";
    this.pollMs = o.pollMs ?? 3000;
  }

  onEnvelope(h: (e: Envelope, c: string | null) => void) {
    this.handler = h;
  }

  private git(args: string[]) {
    return exec("git", args, { cwd: this.repo });
  }

  async start(cursor: string | null): Promise<void> {
    this.cursor = cursor;
    await fs.mkdir(path.join(this.repo, "bus", this.agentDir), { recursive: true });
    await this.poll();
    this.timer = setInterval(() => {
      if (!this.stopped) void this.poll();
    }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.remote) {
        try {
          await this.git(["pull", "--rebase", "--quiet"]);
        } catch {
          /* offline — scan whatever we have locally; next poll retries */
        }
      }
      await this.scan();
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const busDir = path.join(this.repo, "bus");
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(busDir);
    } catch {
      return;
    }
    const found: { id: string; env: Envelope }[] = [];
    for (const d of dirs) {
      const dd = path.join(busDir, d);
      let files: string[] = [];
      try {
        files = await fs.readdir(dd);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (this.cursor && id <= this.cursor) continue;
        try {
          const env = JSON.parse(await fs.readFile(path.join(dd, f), "utf8")) as Envelope;
          found.push({ id, env });
        } catch {
          /* skip partial write — picked up next poll */
        }
      }
    }
    found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const { id, env } of found) {
      if (!this.cursor || id > this.cursor) this.cursor = id;
      this.handler?.(env, this.cursor);
    }
  }

  async publish(env: Envelope): Promise<void> {
    // Serialize git writes — concurrent commits in one repo corrupt the index.
    this.writeChain = this.writeChain.then(async () => {
      const dir = path.join(this.repo, "bus", this.agentDir);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${env.id}.json`);
      await fs.writeFile(file, JSON.stringify(env, null, 2));
      await this.git(["add", "--", path.relative(this.repo, file)]);
      await this.git(["commit", "-q", "-m", `${env.kind} ${env.id}`]);
      if (this.remote) await this.pushWithRetry();
    });
    return this.writeChain;
  }

  /**
   * Push, reconciling with concurrent writers. Multiple agents push to one bus repo,
   * so a push can be rejected non-fast-forward; we `pull --rebase` (our commits only
   * touch our own subdir, so the rebase never conflicts) and retry.
   */
  private async pushWithRetry(attempts = 6): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await this.git(["pull", "--rebase", "--quiet"]);
      } catch {
        /* offline or transient — try the push anyway, then retry the whole cycle */
      }
      try {
        await this.git(["push", "--quiet"]);
        return;
      } catch (err) {
        if (i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 100 * (i + 1)));
      }
    }
  }
}
