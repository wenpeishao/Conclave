import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainContext, BrainResult } from "../runtime.js";
import { renderBody } from "../runtime.js";

/**
 * Claude-backed brain. This is the "real model" driving an agent on the bus — it reads
 * the inbound message plus recent context and the roster, and replies in natural
 * language. Pair different `system` prompts (and even different models) on different
 * devices to get genuinely heterogeneous agents collaborating over Conclave.
 *
 * Defaults to claude-opus-4-8 with adaptive thinking (per Anthropic guidance). Requires
 * ANTHROPIC_API_KEY in the environment, or pass a preconfigured client.
 *
 * Loop safety: the brain only ever replies to the message's sender, and a caller should
 * pair two Claude brains with care — two always-on Claude agents can ping-pong. Give
 * each a system prompt that makes it stop when there's nothing actionable, and rely on
 * the node host's per-agent token policy (roadmap P5 adds framework-level loop guards).
 */
export interface AnthropicBrainOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  client?: Anthropic;
  /** Reply only to these inbound kinds (default: message, request). */
  replyTo?: Set<string>;
}

const DEFAULT_SYSTEM =
  "You are an autonomous agent collaborating with other agents (and possibly humans) over a shared message bus. " +
  "Keep replies concise and actionable. If there is nothing useful to add, reply with exactly the single word NOOP.";

export function anthropicBrain(opts: AnthropicBrainOpts = {}): Brain {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? "claude-opus-4-8";
  const maxTokens = opts.maxTokens ?? 4096;
  const baseSystem = opts.system ?? DEFAULT_SYSTEM;
  const replyTo = opts.replyTo ?? new Set(["message", "request"]);

  return {
    async react(ctx: BrainContext): Promise<BrainResult> {
      const e = ctx.message;
      if (!replyTo.has(e.kind)) return [{ type: "noop" }];

      const roster = ctx.roster.map((r) => `${r.id}${r.online ? " (online)" : ""}`).join(", ") || "none";
      const transcript = ctx.history
        .slice(-12)
        .map((h) => `${h.from === ctx.self.id ? "you" : h.from}: ${h.subject ? `[${h.subject}] ` : ""}${renderBody(h.body)}`)
        .join("\n");

      const system =
        `${baseSystem}\n\n` +
        `Your agent id is ${ctx.self.id}. Other agents on the bus: ${roster}.\n` +
        `Write the body of a reply to send back to ${e.from}. Output only the message body, no preamble.`;

      // `thinking: {type: "adaptive"}` is the current Anthropic guidance for opus-4-8,
      // but SDK 0.69 types only know enabled/disabled — the API accepts adaptive at
      // runtime, so we pass the body through a cast (types trail the API here).
      const params = {
        model,
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        system,
        messages: [
          {
            role: "user" as const,
            content: `Recent bus activity:\n${transcript}\n\nReply to the latest message from ${e.from}.`,
          },
        ],
      };
      const resp = await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsNonStreaming,
      );

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();

      const usageTokens = (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0);

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
