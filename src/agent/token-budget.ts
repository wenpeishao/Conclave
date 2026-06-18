/**
 * TokenBudget — a hard cap on how many tokens an agent may spend before it stops calling
 * its model and hands off to a human. Where LoopGuard bounds *how often* an agent replies,
 * TokenBudget bounds *how much it costs*: once the budget is exhausted the AutonomousAgent
 * stops invoking the brain entirely (saving the inference) and escalates once.
 *
 * Accounting: model brains report real usage (Anthropic/OpenAI usage fields); brains that
 * don't report fall back to a char/4 estimate over the prompt + replies. Pass a budget via
 * AgentOpts.budget; omit it for unbounded spend.
 */
export class TokenBudget {
  private used = 0;
  constructor(private total: number) {}

  charge(n: number): void {
    this.used += Math.max(0, Math.round(n));
  }
  spent(): number {
    return this.used;
  }
  remaining(): number {
    return Math.max(0, this.total - this.used);
  }
  exhausted(): boolean {
    return this.used >= this.total;
  }
}

/** Rough fallback estimate when a brain doesn't report real token usage (~4 chars/token). */
export function estimateTokens(...texts: string[]): number {
  const chars = texts.reduce((s, t) => s + (t ? t.length : 0), 0);
  return Math.max(1, Math.ceil(chars / 4));
}
