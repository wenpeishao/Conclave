import type { Envelope } from "./types.js";

/**
 * The pluggable transport contract. Everything else in Conclave is built on this.
 *
 * Two reference backends ship in-box and share this exact interface — that is the
 * whole design bet:
 *   - RelayWSTransport  : WebSocket push, low latency, outbound-only connection.
 *   - GitBusTransport   : git repo as the bus, durable, auditable, no server, no Docker,
 *                         firewall-friendly (pull-based) — survives any process death.
 *
 * A cursor is an opaque, transport-defined string marking "everything up to here has
 * been seen". The node host persists it so a restart replays only what it missed.
 * (Relay → log line index; Git → high-water ULID, which sorts chronologically.)
 */
export interface Transport {
  /** Replay history strictly after `fromCursor` via the handler, then stream live. */
  start(fromCursor: string | null): Promise<void>;
  stop(): Promise<void>;
  publish(env: Envelope): Promise<void>;
  /** Register the single sink. Each delivered envelope carries the new cursor. */
  onEnvelope(handler: (env: Envelope, cursor: string | null) => void): void;
}
