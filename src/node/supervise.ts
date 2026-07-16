import { spawn, type ChildProcess } from "node:child_process";

/**
 * The built-in supervisor (`--supervise`) — keeps a long-running node alive across exits.
 *
 * Why this exists: self-update deliberately `process.exit(0)`s so a supervisor relaunches it on the
 * new code. That's correct — but only if a supervisor actually exists. `nohup` and `tmux` are NOT
 * supervisors: they keep a process alive across an SSH disconnect, and do nothing when it exits. So
 * on every box without systemd (a shared HPC access point, macOS, Windows) a "successful" self-update
 * silently took the node down for good. Telling each deployer to hand-write a `while true` loop
 * doesn't fix it either: it isn't portable (Windows has no shell loop) and, like every other
 * remember-to-do-it step in this system, it gets forgotten and fails silently.
 *
 * So the supervisor ships in the CLI. It is OPT-IN, which is what keeps it compatible with a real
 * supervisor: under systemd you simply don't pass `--supervise` (systemd's Restart=always already
 * does this job, and running both would double-start the node).
 *
 * Division of labour:
 *   --supervise            → restart on exit/crash (this file, portable)
 *   systemd --user / cron  → start at boot
 *   self-update            → pull new code, then exit; the two above bring it back
 */

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const HEALTHY_UPTIME_MS = 60_000; // ran this long → treat the exit as one-off, don't back off

/** True when this process IS the supervised child (set by the parent) — it must run the real command. */
export function isSupervisedChild(): boolean {
  return process.env.CONCLAVE_SUPERVISED === "1";
}

/**
 * Run the current CLI invocation under supervision: respawn this same command (minus `--supervise`)
 * and relaunch it whenever it exits, with backoff on a crash loop. Never returns.
 */
export function runSupervised(log: (m: string) => void = (m) => console.log(`[supervise] ${m}`)): void {
  // Rebuild our own argv faithfully: node's own flags (e.g. `--import tsx`) live in execArgv and
  // would otherwise be lost, leaving the child unable to load TypeScript.
  const script = process.argv[1];
  const userArgs = process.argv.slice(2).filter((a) => a !== "--supervise");
  let child: ChildProcess | null = null;
  let delay = BASE_DELAY_MS;
  let stopping = false;

  const launch = () => {
    const startedAt = Date.now();
    child = spawn(process.execPath, [...process.execArgv, script, ...userArgs], {
      stdio: "inherit", // the child's logs flow to wherever the supervisor's output goes
      env: { ...process.env, CONCLAVE_SUPERVISED: "1" },
    });
    child.on("exit", (code, signal) => {
      if (stopping) return;
      const upMs = Date.now() - startedAt;
      // A node that ran fine for a while and then exited is the normal self-update path — bring it
      // straight back. One that dies immediately is broken; back off so we don't spin hot.
      if (upMs >= HEALTHY_UPTIME_MS) delay = BASE_DELAY_MS;
      else delay = Math.min(delay * 2, MAX_DELAY_MS);
      log(`child exited (${signal ?? `code ${code}`}) after ${Math.round(upMs / 1000)}s — restarting in ${delay / 1000}s`);
      setTimeout(launch, delay);
    });
    child.on("error", (e) => log(`spawn failed: ${e.message}`));
  };

  // Forward shutdown to the child so Ctrl-C / a stop signal takes the whole thing down, not just us
  // (otherwise the child would be orphaned and keep the bus identity online).
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopping = true;
      child?.kill();
      process.exit(0);
    });
  }

  log(`supervising: ${userArgs.join(" ")} — restarts on exit (this is what makes self-update land)`);
  launch();
}
