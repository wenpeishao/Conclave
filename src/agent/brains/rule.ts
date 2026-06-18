import type { Brain, BrainContext, Action } from "../runtime.js";
import type { Envelope, Kind } from "../../core/types.js";

/**
 * Deterministic rule brain — no model, fully offline, used in tests and for simple
 * reflex agents. Each rule matches an inbound envelope and produces a reply body
 * (or null to stay silent). First matching rule wins.
 */
export interface Rule {
  when: (e: Envelope, ctx: BrainContext) => boolean;
  reply: (e: Envelope, ctx: BrainContext) => string | null;
  kind?: Kind;
}

export function ruleBrain(rules: Rule[]): Brain {
  return {
    async react(ctx: BrainContext): Promise<Action[]> {
      const e = ctx.message;
      if (e.kind === "presence" || e.kind === "ack") return [{ type: "noop" }];
      for (const r of rules) {
        if (!r.when(e, ctx)) continue;
        const body = r.reply(e, ctx);
        if (body == null) return [{ type: "noop" }];
        return [
          {
            type: "send",
            to: [e.from],
            body,
            kind: r.kind ?? (e.kind === "request" ? "response" : "message"),
            corr: e.kind === "request" ? e.id : e.corr,
          },
        ];
      }
      return [{ type: "noop" }];
    },
  };
}

/** Trivial reflex: echo any directed message/request back to its sender. */
export function echoBrain(prefix = "echo: "): Brain {
  return ruleBrain([
    {
      when: (e) => e.kind === "message" || e.kind === "request",
      reply: (e) => `${prefix}${typeof e.body === "string" ? e.body : JSON.stringify(e.body)}`,
    },
  ]);
}
