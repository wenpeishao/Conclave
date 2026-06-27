import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import type { NodeHost } from "../node/host.js";
import type { Envelope } from "../core/types.js";

/**
 * Device agent — the per-device control plane (a "kubelet"). One privileged, always-on agent that
 * represents the device on the bus and, on GATED command, spawns/stops/reports the device's worker
 * agents. See docs/device-agent.md.
 *
 * SECURITY: this is RCE by design, so it is deny-by-default. A command is honored only if the sender
 * is an allowlisted commander (signature is already enforced by the server in secure mode). The op
 * set is closed and structured — there is NO arbitrary-shell op; spawn can only launch `conclave
 * work|agent` with validated fields. Every honored command is echoed as a bus event for audit.
 */
export interface DeviceAgentOpts {
  host: NodeHost;
  commanders: Set<string>; // allowlisted commander agent ids (deny-by-default)
  url: string; // bus url handed to spawned children
  token: string; // connect token handed to spawned children
  httpPort?: string; // server HTTP port — a child's `join` POSTs /enroll there (default 8088)
  httpUrl?: string; // explicit HTTP base (overrides httpPort), e.g. behind TLS
  cliPath: string; // path to src/cli.ts — children run as `node --import tsx <cliPath> …`
  dataRoot: string; // per-child identity/state lives under dataRoot/<name>
  startedAt: number;
  log?: (msg: string) => void;
}

const OPS = new Set(["status", "list", "spawn", "stop"]);
type Child = { proc: ChildProcess; kind: string; role?: string; startedAt: number };

export class DeviceAgent {
  private children = new Map<string, Child>();
  private log: (msg: string) => void;

  constructor(private o: DeviceAgentOpts) {
    this.log = o.log ?? ((m) => console.log(`[host] ${m}`));
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
    let cmd: { op?: string; name?: string; kind?: string; brain?: string; role?: string; zone?: string; permission?: string; enroll?: string };
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
      else result = this.stop(String(cmd.name ?? ""));
      this.log(`${e.from} -> ${cmd.op}${cmd.name ? " " + cmd.name : ""}: ok`);
      await reply(result);
      void this.o.host.send("*", { kind: "event", subject: "device-command", body: { device: this.o.host.card.id, from: e.from, op: cmd.op, name: cmd.name } });
    } catch (err) {
      this.log(`${cmd.op} failed: ${(err as Error).message}`);
      await reply({ error: (err as Error).message });
    }
  }

  private listAgents() {
    return [...this.children.entries()].map(([name, c]) => ({
      name,
      kind: c.kind,
      role: c.role,
      pid: c.proc.pid,
      upMs: Date.now() - c.startedAt,
      alive: c.proc.exitCode === null,
    }));
  }

  private async spawn(cmd: { name?: string; kind?: string; brain?: string; role?: string; zone?: string; permission?: string; enroll?: string }) {
    const name = String(cmd.name ?? "").replace(/[^a-zA-Z0-9_.-]/g, "");
    if (!name) throw new Error("spawn requires a valid name");
    if (this.children.has(name)) throw new Error(`agent ${name} is already running on this device`);
    const kind = cmd.kind === "work" ? "work" : "agent"; // closed set: never arbitrary binaries
    const brain = String(cmd.brain ?? "echo");
    const childData = path.join(this.o.dataRoot, name);

    // If an enroll token is supplied, enroll this child's identity first (secure mode needs it).
    // join POSTs /enroll over HTTP, so the child needs the server's HTTP endpoint, not just the WS url.
    if (cmd.enroll) {
      const joinArgs = ["join", "--as", name, "--enroll", String(cmd.enroll), "--url", this.o.url, "--token", this.o.token, "--data", childData];
      if (this.o.httpUrl) joinArgs.push("--http-url", this.o.httpUrl);
      else if (this.o.httpPort) joinArgs.push("--http-port", this.o.httpPort);
      await this.runToCompletion(joinArgs);
    }

    const args = [kind, "--as", name, "--brain", brain, "--no-self-update", "--url", this.o.url, "--token", this.o.token, "--data", childData];
    if (cmd.role) args.push("--role", String(cmd.role));
    if (cmd.zone) args.push("--zone", String(cmd.zone));
    if (cmd.permission) args.push("--permission", String(cmd.permission));
    const proc = spawn("node", ["--import", "tsx", this.o.cliPath, ...args], { stdio: "ignore" }); // node is directly executable — NO shell (it mangles args on Windows)
    const child: Child = { proc, kind, role: cmd.role, startedAt: Date.now() };
    this.children.set(name, child);
    proc.on("exit", () => { if (this.children.get(name) === child) this.children.delete(name); });
    this.log(`spawned ${kind} ${name} (brain=${brain}, pid=${proc.pid})`);
    return { spawned: name, kind, pid: proc.pid };
  }

  private stop(name: string) {
    const c = this.children.get(name);
    if (!c) throw new Error(`no agent '${name}' is running on this device`);
    c.proc.kill();
    this.children.delete(name);
    return { stopped: name };
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
