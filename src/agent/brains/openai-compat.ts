import type { Brain, BrainContext, BrainResult } from "../runtime.js";
import { renderBody } from "../runtime.js";

/**
 * OpenAI-compatible chat brain — the standard way to drive a LOCALLY-DEPLOYED model.
 *
 * Provider-neutral: this talks plain HTTP to any `/v1/chat/completions` endpoint, which
 * is what local model servers expose — Ollama (http://localhost:11434/v1), LM Studio
 * (http://localhost:1234/v1), vLLM, llama.cpp's server, text-generation-webui, etc. It
 * also works against the real OpenAI API. No SDK, no Anthropic dependency — just fetch.
 *
 * Unlike the CLI-shim brain (which spawns a process per message), this hits a long-lived
 * server, so it's the better fit for a local model you keep running. Put an Ollama brain
 * on a GPU box and a Claude/Codex brain on a laptop and they collaborate over one bus.
 */
export interface OpenAICompatBrainOpts {
  /** Base URL ending in /v1. Default: Ollama's local endpoint. */
  baseUrl?: string;
  model: string;
  apiKey?: string; // most local servers ignore it; required for hosted OpenAI
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  replyTo?: Set<string>;
  /** Override the transcript→prompt rendering if you want a different context window. */
  buildUserPrompt?: (ctx: BrainContext) => string;
}

const DEFAULT_SYSTEM =
  "You are an autonomous agent collaborating with other agents over a shared message bus. " +
  "Keep replies concise and actionable. If there is nothing useful to add, reply with exactly NOOP.";

function defaultUserPrompt(ctx: BrainContext): string {
  const transcript = ctx.history
    .slice(-12)
    .map((h) => `${h.from === ctx.self.id ? "you" : h.from}: ${h.subject ? `[${h.subject}] ` : ""}${renderBody(h.body)}`)
    .join("\n");
  return `Recent bus activity:\n${transcript}\n\nReply to the latest message from ${ctx.message.from}. Output only the reply text.`;
}

export function openaiCompatBrain(opts: OpenAICompatBrainOpts): Brain {
  const baseUrl = (opts.baseUrl ?? "http://localhost:11434/v1").replace(/\/$/, "");
  const replyTo = opts.replyTo ?? new Set(["message", "request"]);
  const system = opts.system ?? DEFAULT_SYSTEM;
  const buildUser = opts.buildUserPrompt ?? defaultUserPrompt;

  return {
    async react(ctx: BrainContext): Promise<BrainResult> {
      const e = ctx.message;
      if (!replyTo.has(e.kind)) return [{ type: "noop" }];

      const roster = ctx.roster.map((r) => `${r.id}${r.online ? " (online)" : ""}`).join(", ") || "none";
      const sys = `${system}\nYour agent id is ${ctx.self.id}. Other agents: ${roster}.`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120000);
      let content: string;
      let usageTokens: number | undefined;
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: buildUser(ctx) },
            ],
            max_tokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.7,
            stream: false,
          }),
        });
        if (!res.ok) {
          console.error(`[conclave] openai-compat brain HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          return [{ type: "noop" }];
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { total_tokens?: number };
        };
        content = (data.choices?.[0]?.message?.content ?? "").trim();
        usageTokens = data.usage?.total_tokens;
      } catch (err) {
        console.error("[conclave] openai-compat brain failed:", (err as Error).message);
        return [{ type: "noop" }];
      } finally {
        clearTimeout(timer);
      }

      if (!content || content === "NOOP") return { actions: [{ type: "noop" }], usageTokens };
      return {
        actions: [
          {
            type: "send",
            to: [e.from],
            body: content,
            kind: e.kind === "request" ? "response" : "message",
            corr: e.kind === "request" ? e.id : e.corr,
          },
        ],
        usageTokens,
      };
    },
  };
}

/** Ollama preset — `ollama serve` exposes an OpenAI-compatible API at :11434/v1. */
export function ollamaBrain(model: string, opts: Partial<OpenAICompatBrainOpts> = {}): Brain {
  return openaiCompatBrain({ baseUrl: "http://localhost:11434/v1", model, ...opts });
}

/** LM Studio preset — its local server defaults to :1234/v1. */
export function lmStudioBrain(model: string, opts: Partial<OpenAICompatBrainOpts> = {}): Brain {
  return openaiCompatBrain({ baseUrl: "http://localhost:1234/v1", model, ...opts });
}
