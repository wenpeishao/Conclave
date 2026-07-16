import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { NodeHost } from "../node/host.js";
import type { Envelope } from "../core/types.js";

/**
 * Device agent — the per-device control plane (a "kubelet"). One privileged, always-on agent that
 * represents the device on the bus and, on GATED command, spawns/stops/reports/RESUMES the device's
 * worker agents. See docs/device-agent.md.
 *
 * SECURITY: this is RCE by design, so it is deny-by-default. A command is honored only if the sender
 * is an allowlisted commander (signature is already enforced by the server in secure mode). The op
 * set is closed and structured — there is NO arbitrary-shell op; spawn can only launch `conclave
 * work|agent` (or a Claude Code remote-control session) with validated fields. Every honored command
 * is echoed as a bus event for audit.
 *
 * RESUME / restart survival: every spawn's launch spec is persisted to `<dataRoot>/_specs.json`.
 * A child's identity + message cursor already persist under `<dataRoot>/<name>`, so resuming a
 * node = relaunching the SAME spec against the SAME data dir — it reconnects as the same
 * `agent://<name>` and replays from its cursor. Recovery path for when a child goes offline on its
 * own (Claude Code update, crash) or the device reboots. An explicit `stop` deprovisions (forgets
 * the spec), so a stopped agent is NOT resurrected; only offline-but-known agents are.
 *
 * RC ("rc": true) — a task node the human steers. Instead of a headless `conclave agent`, the host
 * prepares a Claude Code workspace (pre-trusted + the conclave MCP wired in, so the session is ON
 * the bus as `agent://<name>` and can DM resource nodes / other task sessions) and launches
 * `claude remote-control` in it, then captures the `claude.ai/code?environment=…` link and returns
 * it — so the commander (your manager session) can hand you a link to steer the new task from your
 * phone. `resume` of an rc node relaunches remote-control and returns a fresh link.
 */
export interface DeviceAgentOpts {
  host: NodeHost;
  commanders: Set<string>; // allowlisted commander agent ids (deny-by-default)
  url: string; // bus url handed to spawned children
  token: string; // connect token handed to spawned children
  httpPort?: string; // server HTTP port — a child's `join` POSTs /enroll there (default 8088)
  httpUrl?: string; // explicit HTTP base (overrides httpPort), e.g. behind TLS
  cliPath: string; // path to src/cli.ts — children run as `node --import tsx <cliPath> …`
  dataRoot: string; // per-child identity/state lives under dataRoot/<name>; specs in dataRoot/_specs.json
  startedAt: number;
  claudeBin?: string; // executable for `claude remote-control` (default "claude"); injectable for tests
  claudeConfig?: string; // path to ~/.claude.json (workspace trust + MCP wiring); injectable for tests
  log?: (msg: string) => void;
}

const OPS = new Set(["status", "list", "spawn", "stop", "resume"]);
const PERMS = new Set(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
const RC_LINK = /https:\/\/claude\.ai\/code\?environment=[^\s"']+/;

/** The relaunchable recipe for one child — persisted so it survives a host restart / device reboot.
 *  NOT the enroll token: resume relies on the identity already persisted under dataRoot/<name>. */
type SpawnSpec = { name: string; kind: string; brain: string; role?: string; zone?: string; permission?: string; rc?: boolean };
type Child = { proc: ChildProcess; spec: SpawnSpec; startedAt: number };
type RcInfo = { link: string | null; workspace: string; log: string; note?: string };

export class DeviceAgent {
  private children = new Map<string, Child>();
  private specs = new Map<string, SpawnSpec>(); // known agents (running or resumable), loaded from disk
  private specsFile: string;
  private log: (msg: string) => void;

  constructor(private o: DeviceAgentOpts) {
    this.log = o.log ?? ((m) => console.log(`[host] ${m}`));
    this.specsFile = path.join(o.dataRoot, "_specs.json");
    this.loadSpecs();
  }

  start(): void {
    this.o.host.onMessage((e) => {
      if (e.kind === "request") void this.handle(e);
    });
  }

  async stopAll(): Promise<void> {
    for (const c of this.children.values()) c.proc.kill();
    this.children.clear();
  }

  private async handle(e: Envelope): Promise<void> {
    const reply = (body: unknown) => this.o.host.send([e.from], { kind: "response", corr: e.id, body });

    // GATE: deny-by-default. Only an allowlisted commander may control this device.
    if (!this.o.commanders.has(e.from)) {
      this.log(`REFUSED command from non-commander ${e.from}`);
      await reply({ error: "not authorized: you are not a commander of this device" });
      return;
    }

    // The body may arrive as a JSON string (e.g. from `conclave send --kind request --body '{…}'`).
    let cmd: { op?: string; name?: string; kind?: string; brain?: string; role?: string; zone?: string; permission?: string; enroll?: string; rc?: boolean };
    try {
      cmd = typeof e.body === "string" ? JSON.parse(e.body) : (e.body as typeof cmd) ?? {};
    } catch {
      await reply({ error: "command body must be a JSON object { op, … }" });
      return;
    }
    if (!cmd.op || !OPS.has(cmd.op)) {
      await reply({ error: `unknown op '${cmd.op ?? ""}' (allowed: ${[...OPS].join(", ")})` });
      return;
    }

    try {
      let result: unknown;
      if (cmd.op === "status") result = { device: this.o.host.card.id, uptimeMs: Date.now() - this.o.startedAt, agents: this.listAgents() };
      else if (cmd.op === "list") result = { agents: this.listAgents() };
      else if (cmd.op === "spawn") result = await this.spawn(cmd);
      else if (cmd.op === "resume") result = await this.resume(cmd.name);
      else result = this.stop(String(cmd.name ?? ""));
      this.log(`${e.from} -> ${cmd.op}${cmd.name ? " " + cmd.name : ""}: ok`);
      await reply(result);
      void this.o.host.send("*", { kind: "event", subject: "device-command", body: { device: this.o.host.card.id, from: e.from, op: cmd.op, name: cmd.name } });
    } catch (err) {
      this.log(`${cmd.op} failed: ${(err as Error).message}`);
      await reply({ error: (err as Error).message });
    }
  }

  /** Every known agent (running child ∪ persisted spec), so a commander can see what's resumable. */
  private listAgents() {
    return [...this.specs.keys()].map((name) => {
      const c = this.children.get(name);
      const spec = this.specs.get(name)!;
      const alive = !!c && c.proc.exitCode === null;
      return {
        name,
        kind: spec.rc ? "rc" : spec.kind,
        role: spec.role,
        pid: c?.proc.pid,
        upMs: c ? Date.now() - c.startedAt : undefined,
        alive,
        status: alive ? "running" : "offline", // offline = known but not running → resumable
        resumable: !alive,
      };
    });
  }

  private async spawn(cmd: { name?: string; kind?: string; brain?: string; role?: string; zone?: string; permission?: string; enroll?: string; rc?: boolean }) {
    const name = String(cmd.name ?? "").replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!name) throw new Error("spawn requires a valid name");
    if (this.isRunning(name)) throw new Error(`agent ${name} is already running on this device`);
    const rc = cmd.rc === true;
    const permission = cmd.permission ? String(cmd.permission) : rc ? "bypassPermissions" : undefined;
    if (permission && !PERMS.has(permission)) throw new Error(`invalid permission '${permission}' (allowed: ${[...PERMS].join(", ")})`);
    const kind = cmd.kind === "work" ? "work" : "agent"; // closed set: never arbitrary binaries
    const spec: SpawnSpec = { name, kind, brain: String(cmd.brain ?? "echo"), role: cmd.role ? String(cmd.role) : undefined, zone: cmd.zone ? String(cmd.zone) : undefined, permission, rc: rc || undefined };

    // If an enroll token is supplied, enroll this child's identity first (secure mode needs it) — the
    // rc form needs it too, so the conclave MCP inside the session can sign onto the bus as agent://name.
    // join POSTs /enroll over HTTP. (Resume never re-enrolls — the identity persists under dataRoot/<name>.)
    if (cmd.enroll) {
      const childData = path.join(this.o.dataRoot, name);
      const joinArgs = ["join", "--as", name, "--enroll", String(cmd.enroll), "--url", this.o.url, "--token", this.o.token, "--data", childData];
      if (this.o.httpUrl) joinArgs.push("--http-url", this.o.httpUrl);
      else if (this.o.httpPort) joinArgs.push("--http-port", this.o.httpPort);
      await this.runToCompletion(joinArgs);
    }

    this.specs.set(name, spec); // persist the recipe BEFORE launch → resumable even if the process dies immediately
    this.saveSpecs();
    const out = await this.launch(spec);
    return { spawned: name, kind: spec.rc ? "rc" : kind, ...out };
  }

  /** Resume offline-but-known agent(s): relaunch from the persisted spec against the same data dir,
   *  so each comes back as the same `agent://<name>` and replays its cursor. `name` omitted / "all" /
   *  "*" → resume every known agent that isn't currently running (device-reboot recovery). */
  private async resume(name?: string) {
    const all = !name || name === "all" || name === "*";
    if (all) {
      const resumed: { name: string; pid?: number; rc?: RcInfo }[] = [];
      const skipped: string[] = [];
      for (const spec of this.specs.values()) {
        if (this.isRunning(spec.name)) { skipped.push(spec.name); continue; }
        resumed.push({ name: spec.name, ...(await this.launch(spec)) });
      }
      return { resumed, skipped }; // skipped = already running
    }
    const clean = String(name).replace(/[^a-zA-Z0-9_.-]/g, "");
    const spec = this.specs.get(clean);
    if (!spec) throw new Error(`no known agent '${clean}' to resume on this device (never spawned here, or it was stopped)`);
    if (this.isRunning(clean)) throw new Error(`agent ${clean} is already running on this device`);
    return { resumed: clean, ...(await this.launch(spec)) };
  }

  private stop(name: string) {
    const clean = String(name).replace(/[^a-zA-Z0-9_.-]/g, "");
    const c = this.children.get(clean);
    const known = this.specs.has(clean);
    if (!c && !known) throw new Error(`no agent '${clean}' is running or known on this device`);
    if (c) { c.proc.kill(); this.children.delete(clean); }
    this.specs.delete(clean); // deprovision: a stopped agent is forgotten → NOT resumed later
    this.saveSpecs();
    return { stopped: clean };
  }

  private isRunning(name: string): boolean {
    const c = this.children.get(name);
    return !!c && c.proc.exitCode === null;
  }

  /** Launch (or relaunch) a child from its spec against dataRoot/<name>. Shared by spawn + resume.
   *  Branches on spec.rc: a headless bus worker (conclave work|agent) vs a human-steered
   *  `claude remote-control` session wired onto the bus. */
  private async launch(spec: SpawnSpec): Promise<{ pid?: number; rc?: RcInfo }> {
    if (spec.rc) return { ...(await this.launchRC(spec)) };
    const childData = path.join(this.o.dataRoot, spec.name);
    const args = [spec.kind, "--as", spec.name, "--brain", spec.brain, "--no-self-update", "--url", this.o.url, "--token", this.o.token, "--data", childData];
    if (spec.role) args.push("--role", spec.role);
    if (spec.zone) args.push("--zone", spec.zone);
    if (spec.permission) args.push("--permission", spec.permission);
    const proc = spawn("node", ["--import", "tsx", this.o.cliPath, ...args], { stdio: "ignore" }); // node is directly executable — NO shell (it mangles args on Windows)
    this.track(spec, proc);
    this.log(`launched ${spec.kind} ${spec.name} (brain=${spec.brain}, pid=${proc.pid})`);
    return { pid: proc.pid };
  }

  /** Prepare a pre-trusted, MCP-wired Claude Code workspace and launch `claude remote-control` in it;
   *  poll its output for the claude.ai/code link and return it. The session is on the bus via the
   *  conclave MCP (so it can DM resources / other task sessions) and steerable by the human. */
  private async launchRC(spec: SpawnSpec): Promise<{ pid?: number; rc: RcInfo }> {
    const childData = path.join(this.o.dataRoot, spec.name);
    const workspace = path.join(childData, "workspace");
    mkdirSync(workspace, { recursive: true });
    this.prepareClaudeWorkspace(spec.name, workspace, childData);

    const perm = spec.permission ?? "bypassPermissions";
    const logFile = path.join(childData, "remote-control.log");
    // shell:true → resolves `claude` / `claude.cmd` cross-platform. Only sanitized name + validated
    // perm reach the command line (url/token go into the MCP config file, never argv), so no injection.
    const proc = spawn(this.o.claudeBin ?? "claude", ["remote-control", "--name", spec.name, "--permission-mode", perm], { cwd: workspace, shell: true });
    this.track(spec, proc);
    let out = "";
    const onData = (d: Buffer) => { out += d.toString(); try { appendFileSync(logFile, d); } catch { /* best effort */ } };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    this.log(`launched rc ${spec.name} (perm=${perm}, pid=${proc.pid}) — waiting for claude.ai link…`);

    // Poll for the connect link (it prints a few seconds after launch). Don't guard on exitCode —
    // capture the link even from a process that printed it then exited; drain once more after exit.
    // Don't fail if absent — the session may still be up; surface a note to check login/the log.
    let link: string | null = null;
    for (let i = 0; i < 30; i++) {
      link = RC_LINK.exec(out)?.[0] ?? null;
      if (link || proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!link) link = RC_LINK.exec(out)?.[0] ?? null; // final drain (exit may race the buffer flush)
    if (link) this.log(`rc ${spec.name} link: ${link}`);
    else this.log(`rc ${spec.name}: no claude.ai link captured — check ${logFile} (is claude logged in with a subscription?)`);
    return { pid: proc.pid, rc: { link, workspace, log: logFile, note: link ? undefined : "no claude.ai/code link captured yet — check the log; claude must be installed and logged in with a subscription (not an API key)" } };
  }

  /** Pre-trust the workspace and wire the conclave MCP into it (in ~/.claude.json), so a headless
   *  `claude remote-control` session neither blocks on the trust dialog nor prompts for the MCP —
   *  and comes up already on the bus as agent://<name>. */
  private prepareClaudeWorkspace(name: string, workspace: string, childData: string): void {
    const cfgPath = this.o.claudeConfig ?? path.join(os.homedir(), ".claude.json");
    let cfg: { projects?: Record<string, unknown> } = {};
    if (existsSync(cfgPath)) {
      try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { cfg = {}; }
      if (!existsSync(cfgPath + ".bak")) { try { writeFileSync(cfgPath + ".bak", readFileSync(cfgPath)); } catch { /* best effort backup */ } }
    }
    cfg.projects = cfg.projects ?? {};
    const prev = (cfg.projects[workspace] as Record<string, unknown>) ?? {};
    cfg.projects[workspace] = {
      ...prev,
      hasTrustDialogAccepted: true,
      history: (prev.history as unknown[]) ?? [],
      mcpServers: {
        ...((prev.mcpServers as Record<string, unknown>) ?? {}),
        conclave: {
          type: "stdio",
          command: "node",
          args: ["--import", "tsx", this.o.cliPath, "mcp", "--as", name, "--url", this.o.url, "--token", this.o.token, "--data", childData],
        },
      },
    };
    mkdirSync(path.dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  }

  private track(spec: SpawnSpec, proc: ChildProcess): void {
    const child: Child = { proc, spec, startedAt: Date.now() };
    this.children.set(spec.name, child);
    proc.on("exit", () => { if (this.children.get(spec.name) === child) this.children.delete(spec.name); });
  }

  private loadSpecs(): void {
    try {
      const raw = JSON.parse(readFileSync(this.specsFile, "utf8")) as SpawnSpec[];
      for (const s of raw) if (s && s.name) this.specs.set(s.name, s);
      if (this.specs.size) this.log(`loaded ${this.specs.size} known agent spec(s) — resumable: ${[...this.specs.keys()].join(", ")}`);
    } catch { /* no specs file yet — fresh device */ }
  }

  private saveSpecs(): void {
    try {
      mkdirSync(this.o.dataRoot, { recursive: true });
      writeFileSync(this.specsFile, JSON.stringify([...this.specs.values()], null, 2));
    } catch (err) {
      this.log(`WARN: could not persist specs: ${(err as Error).message}`);
    }
  }

  private runToCompletion(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = spawn("node", ["--import", "tsx", this.o.cliPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      p.stderr?.on("data", (d) => (err += d.toString()));
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`'${args[0]}' timed out`)); }, 30000);
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`'${args[0]}' exited ${code}: ${err.replace(/\s+/g, " ").slice(0, 200)}`));
      });
    });
  }
}
