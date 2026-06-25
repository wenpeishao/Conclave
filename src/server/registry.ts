import { promises as fs } from "node:fs";
import * as path from "node:path";
import { verifyEnvelope, randomToken } from "../core/identity.js";
import type { Envelope } from "../core/types.js";

/**
 * AgentRegistry — the server's source of truth for WHO may act on the bus.
 *
 * Onboarding is a two-step enrollment so private keys never leave a device:
 *   1. admin `invite(name, role)`  -> a one-time, expiring enrollment token
 *   2. device `enroll(token, pubKey)` -> binds the device's public key to the name
 * Thereafter every envelope from that name must carry a valid signature by that key
 * (authorize()). Revocation is immediate: flip `revoked` and the agent is locked out
 * even though it still holds its private key.
 */
export interface AgentRecord {
  id: string; // agent://name
  name: string;
  role?: string;
  canRun: boolean; // may run/deploy (maps to bypassPermissions workers)
  publicKey: string; // base64 SPKI DER
  revoked: boolean;
  createdTs: number;
}

interface PendingEnroll {
  token: string;
  id: string;
  name: string;
  role?: string;
  canRun: boolean;
  expTs: number;
}

export interface AuthDecision {
  ok: boolean;
  reason?: string;
  record?: AgentRecord;
}

export class AgentRegistry {
  private file: string;
  private agents = new Map<string, AgentRecord>(); // by id
  private pending = new Map<string, PendingEnroll>(); // by token
  private saveChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "registry.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const s = JSON.parse(raw) as { agents?: AgentRecord[]; pending?: PendingEnroll[] };
      for (const a of s.agents ?? []) this.agents.set(a.id, a);
      for (const p of s.pending ?? []) this.pending.set(p.token, p);
    } catch {
      /* fresh */
    }
  }

  /** Admin: create a one-time enrollment token for a new agent name. */
  invite(opts: { name: string; role?: string; canRun?: boolean; ttlMs?: number; now?: number }): PendingEnroll {
    const name = opts.name.replace(/^agent:\/\//, "").trim();
    if (!name) throw new Error("name required");
    const id = `agent://${name}`;
    if (this.agents.get(id) && !this.agents.get(id)!.revoked) {
      throw new Error(`agent ${id} already enrolled (revoke first to re-enroll)`);
    }
    const now = opts.now ?? Date.now();
    const p: PendingEnroll = {
      token: randomToken(24),
      id,
      name,
      role: opts.role,
      canRun: opts.canRun ?? false,
      expTs: now + (opts.ttlMs ?? 60 * 60 * 1000), // default 1h
    };
    this.pending.set(p.token, p);
    void this.save();
    return p;
  }

  /** Device: redeem an enrollment token by registering a public key. One-time. */
  enroll(token: string, publicKey: string, now = Date.now()): AgentRecord {
    const p = this.pending.get(token);
    if (!p) throw new Error("invalid or already-used enrollment token");
    if (now > p.expTs) {
      this.pending.delete(token);
      void this.save();
      throw new Error("enrollment token expired");
    }
    const rec: AgentRecord = {
      id: p.id,
      name: p.name,
      role: p.role,
      canRun: p.canRun,
      publicKey,
      revoked: false,
      createdTs: now,
    };
    this.agents.set(rec.id, rec);
    this.pending.delete(token);
    void this.save();
    return rec;
  }

  revoke(nameOrId: string): boolean {
    const id = nameOrId.startsWith("agent://") ? nameOrId : `agent://${nameOrId}`;
    const rec = this.agents.get(id);
    if (!rec) return false;
    rec.revoked = true;
    void this.save();
    return true;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()];
  }

  /** Is this registry enforcing yet? (Empty registry → server runs in legacy shared-token mode.) */
  get active(): boolean {
    return this.agents.size > 0 || this.pending.size > 0;
  }

  /**
   * Authorize an envelope: its `from` must be a known, non-revoked agent and the envelope
   * must carry a valid signature by that agent's registered key.
   */
  authorize(env: Envelope): AuthDecision {
    const rec = this.agents.get(env.from);
    if (!rec) return { ok: false, reason: `unknown agent ${env.from}` };
    if (rec.revoked) return { ok: false, reason: `revoked agent ${env.from}` };
    if (!env.sig) return { ok: false, reason: "unsigned envelope" };
    if (!verifyEnvelope(env, rec.publicKey)) return { ok: false, reason: "bad signature" };
    return { ok: true, record: rec };
  }

  private save(): Promise<void> {
    const snapshot = {
      agents: [...this.agents.values()],
      pending: [...this.pending.values()],
    };
    this.saveChain = this.saveChain
      .then(async () => {
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2));
        await fs.rename(tmp, this.file);
      })
      .catch((e) => console.error("[conclave] registry save error:", e));
    return this.saveChain;
  }
}
