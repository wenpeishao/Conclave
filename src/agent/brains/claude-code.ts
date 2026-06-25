import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Brain, BrainContext, BrainResult } from "../runtime.js";
import { renderBody } from "../runtime.js";

/**
 * Stateful Claude Code teammate brain — the "Agent Teams, but cross-device" core.
 *
 * Unlike the generic CLI-shim (a fresh `claude -p` with no memory each turn), this keeps
 * ONE persistent Claude Code session per agent: the first message creates the session
 * (`--session-id <uuid>`), every later message resumes it (`--resume <uuid>`). So the
 * teammate accumulates context across bus messages — it remembers what was discussed,
 * decided, and done, exactly like an Agent Teams teammate, but each teammate is its own
 * process and can live on a different device.
 *
 * Authenticated through the user's local Claude Code login — no API key. Calls are
 * serialized per agent (Claude Code can't resume one session concurrently). All prompt
 * content travels on stdin and only space-free flags are passed as argv, so it's safe on
 * Windows (where `claude` is a .cmd shim and needs shell resolution).
 */
const WIN = process.platform === "win32";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g");

export interface ClaudeCodeBrainOpts {
  sessionId?: string; // stable id for this teammate's session (default: generated)
  persona?: string; // standing role, planted in the first turn
  model?: string; // --model (space-free)
  effort?: string; // --effort low|medium|high|xhigh|max
  permissionMode?: string; // --permission-mode (e.g. bypassPermissions) — lets a teammate run/deploy
  cwd?: string;
  timeoutMs?: number;
  replyTo?: Set<string>;
}

const DEFAULT_PERSONA =
  "You are an autonomous teammate on a shared message bus called Conclave, collaborating with other agents and humans. " +
  "Each user message is an incoming bus message; the sender is named in it, and your reply is delivered back over the bus to that sender. " +
  "You keep persistent memory across messages in this session — use it to stay consistent and avoid repeating yourself. " +
  "Keep replies concise, substantive, and to the point. State clearly when a task is done. If a message needs no reply, output exactly: NOOP.";

function teammatePrompt(ctx: BrainContext): string {
  const e = ctx.message;
  const roster = ctx.roster.map((r) => r.id + (r.online ? "" : " (offline)")).join(", ") || "(none)";
  const head = `[bus message from ${e.from}${e.subject ? ` — ${e.subject}` : ""}]`;
  return `${head}\n${renderBody(e.body)}\n\n(Agents on the bus: ${roster}. Reply with ONLY the body to send back to ${e.from}.)`;
}

function runClaude(args: string[], stdin: string, cwd: string | undefined, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, shell: WIN, env: process.env });
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out"));
    }), timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) => finish(() => {
      if (code !== 0 && !out) reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`));
      else resolve(out);
    }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export function claudeCodeBrain(opts: ClaudeCodeBrainOpts = {}): Brain {
  const sessionId = opts.sessionId ?? randomUUID();
  const persona = opts.persona ?? DEFAULT_PERSONA;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const replyTo = opts.replyTo ?? new Set(["message", "request"]);
  let started = false;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    async react(ctx: BrainContext): Promise<BrainResult> {
      const e = ctx.message;
      if (!replyTo.has(e.kind)) return [{ type: "noop" }];

      // Serialize calls: Claude Code cannot resume the same session concurrently.
      const run = chain.then(async () => {
        const args = ["-p", "--output-format", "json"];
        // Re-applied every turn so a resumed deployer keeps its run permission.
        if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
        let stdin: string;
        if (!started) {
          args.push("--session-id", sessionId);
          if (opts.model) args.push("--model", opts.model);
          if (opts.effort) args.push("--effort", opts.effort);
          stdin = `${persona}\n\n---\n\n${teammatePrompt(ctx)}`;
        } else {
          args.push("--resume", sessionId);
          stdin = teammatePrompt(ctx);
        }
        const raw = await runClaude(args, stdin, opts.cwd, timeoutMs);
        started = true;
        return raw;
      });
      chain = run.catch(() => {});

      let raw: string;
      try {
        raw = (await run) as string;
      } catch (err) {
        console.error("[conclave] claude-code brain failed:", (err as Error).message);
        return [{ type: "noop" }];
      }

      // Parse `claude -p --output-format json` → { result, usage, session_id }.
      let text = "";
      let usageTokens: number | undefined;
      try {
        const j = JSON.parse(raw) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        text = (j.result ?? "").replace(ANSI, "").trim();
        if (j.usage) usageTokens = (j.usage.input_tokens ?? 0) + (j.usage.output_tokens ?? 0);
      } catch {
        text = raw.replace(ANSI, "").trim(); // fallback if not JSON
      }

      if (!text || text === "NOOP") return { actions: [{ type: "noop" }], usageTokens };
      return {
        actions: [
          {
            type: "send",
            to: [e.from],
            body: text,
            kind: e.kind === "request" ? "response" : "message",
            corr: e.kind === "request" ? e.id : e.corr,
          },
        ],
        usageTokens,
      };
    },
  };
}
