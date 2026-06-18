import { spawn } from "node:child_process";
import type { Brain, BrainContext, Action } from "../runtime.js";
import { renderBody } from "../runtime.js";

/**
 * CLI-shim brain — drives any subprocess "coding agent" CLI as an agent on the bus.
 * This is how a non-Claude model joins: Codex, Gemini CLI, a local-model runner, or any
 * program that takes a prompt and prints a reply. For each inbound message the shim
 * builds a prompt, runs the command, and sends the captured stdout back to the sender.
 *
 * `codexBrain()` / `geminiBrain()` are thin presets over `cliBrain`. Put a `codexBrain`
 * agent on one machine and an `anthropicBrain` agent on another and they collaborate over
 * the same Conclave bus — genuinely heterogeneous models, one protocol.
 *
 * Safety: prompts are passed as a spawn argv element (shell:false by default), so prompt
 * text is never shell-parsed — arbitrary content is safe. Only kinds in `replyTo` trigger
 * a subprocess, so presence/heartbeats never spawn the CLI.
 */
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export interface CliBrainOpts {
  command: string; // e.g. "codex"
  args?: string[]; // e.g. ["exec"]
  /** Pass the prompt as the final argv element ("arg") or on stdin ("stdin"). */
  promptVia?: "arg" | "stdin";
  buildPrompt?: (ctx: BrainContext) => string;
  /** Turn raw stdout into the reply body; return null/"" to stay silent. */
  parseOutput?: (stdout: string, ctx: BrainContext) => string | null;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean; // needed on Windows for .cmd shims (loses argv-safety — avoid if possible)
  timeoutMs?: number;
  replyTo?: Set<string>; // inbound kinds that trigger the CLI (default: message, request)
}

function defaultPrompt(ctx: BrainContext): string {
  const transcript = ctx.history
    .slice(-10)
    .map((h) => `${h.from === ctx.self.id ? "you" : h.from}: ${h.subject ? `[${h.subject}] ` : ""}${renderBody(h.body)}`)
    .join("\n");
  return (
    `You are ${ctx.self.id}, an autonomous agent on a shared message bus.\n` +
    `Recent activity:\n${transcript}\n\n` +
    `Reply to the latest message from ${ctx.message.from}. Output only the reply text.`
  );
}

function runCli(opts: CliBrainOpts, prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const via = opts.promptVia ?? "arg";
    const args = [...(opts.args ?? [])];
    if (via === "arg") args.push(prompt);

    const child = spawn(opts.command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
    });

    let out = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("cli brain timed out"));
      });
    }, opts.timeoutMs ?? 120000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0 && !out) reject(new Error(`cli exited ${code}: ${err.slice(0, 200)}`));
        else resolve(out);
      }),
    );

    if (via === "stdin") {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

export function cliBrain(opts: CliBrainOpts): Brain {
  const replyTo = opts.replyTo ?? new Set(["message", "request"]);
  const build = opts.buildPrompt ?? defaultPrompt;
  const parse = opts.parseOutput ?? ((s) => stripAnsi(s).trim() || null);

  return {
    async react(ctx: BrainContext): Promise<Action[]> {
      const e = ctx.message;
      if (!replyTo.has(e.kind)) return [{ type: "noop" }];
      let stdout: string;
      try {
        stdout = await runCli(opts, build(ctx));
      } catch (err) {
        console.error("[conclave] cli brain failed:", (err as Error).message);
        return [{ type: "noop" }];
      }
      const body = parse(stdout, ctx);
      if (body == null || body === "") return [{ type: "noop" }];
      return [
        {
          type: "send",
          to: [e.from],
          body,
          kind: e.kind === "request" ? "response" : "message",
          corr: e.kind === "request" ? e.id : e.corr,
        },
      ];
    },
  };
}

/**
 * OpenAI Codex CLI preset (`codex exec "<prompt>"`). The default parser returns the full
 * cleaned stdout; for production, pass a `parseOutput` that extracts just the final answer
 * (e.g. parse `codex exec --json`). On Windows the `codex` shim is a .cmd — set `shell: true`
 * or point `command` at the full path if spawn can't resolve it.
 */
export function codexBrain(opts: Partial<CliBrainOpts> = {}): Brain {
  return cliBrain({ command: "codex", args: ["exec"], promptVia: "arg", ...opts });
}

/** Google Gemini CLI preset (`gemini -p "<prompt>"`). Same Windows .cmd caveat as codex. */
export function geminiBrain(opts: Partial<CliBrainOpts> = {}): Brain {
  return cliBrain({ command: "gemini", args: ["-p"], promptVia: "arg", ...opts });
}
