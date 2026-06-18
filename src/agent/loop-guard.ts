/**
 * LoopGuard — framework-level protection against two model-driven agents ping-ponging
 * forever and burning tokens. An AutonomousAgent consults its guard before sending any
 * brain-generated reply; if a limit trips, the reply is suppressed and the agent escalates
 * once to a human topic.
 *
 * Two limits, both over a rolling window:
 *   - rate:      total auto-replies in the window (a global throttle)
 *   - pingpong:  consecutive replies to the SAME peer (the classic A↔B loop)
 *
 * This is intentionally local (no protocol change): the dominant runaway — two agents
 * bouncing the same thread — is fully observable from one side as "I keep replying to the
 * same peer." Cross-agent chain-depth tracking (hop counts in the envelope) is future work.
 */
export interface LoopGuardOpts {
  windowMs?: number;
  maxRepliesPerWindow?: number;
  maxConsecutivePerPeer?: number;
}

export interface GuardDecision {
  ok: boolean;
  reason?: "rate" | "pingpong";
}

export class LoopGuard {
  private windowMs: number;
  private maxPerWindow: number;
  private maxPerPeer: number;
  private times: number[] = [];
  private peers = new Map<string, { count: number; last: number }>();

  constructor(o: LoopGuardOpts = {}) {
    this.windowMs = o.windowMs ?? 60000;
    this.maxPerWindow = o.maxRepliesPerWindow ?? 30;
    this.maxPerPeer = o.maxConsecutivePerPeer ?? 8;
  }

  /** Should the agent be allowed to send a reply to `peer` right now? */
  check(peer: string, now: number = Date.now()): GuardDecision {
    this.prune(now);
    if (this.times.length >= this.maxPerWindow) return { ok: false, reason: "rate" };
    const p = this.peers.get(peer);
    if (p && now - p.last <= this.windowMs && p.count >= this.maxPerPeer) {
      return { ok: false, reason: "pingpong" };
    }
    return { ok: true };
  }

  /** Record that a reply to `peer` was actually sent. */
  record(peer: string, now: number = Date.now()): void {
    this.times.push(now);
    const p = this.peers.get(peer);
    if (p && now - p.last <= this.windowMs) {
      p.count++;
      p.last = now;
    } else {
      this.peers.set(peer, { count: 1, last: now });
    }
  }

  private prune(now: number) {
    if (this.times.length) this.times = this.times.filter((t) => now - t <= this.windowMs);
    for (const [k, p] of this.peers) if (now - p.last > this.windowMs) this.peers.delete(k);
  }
}
