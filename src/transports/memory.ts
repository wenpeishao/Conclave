import type { Transport } from "../core/transport.js";
import type { Envelope } from "../core/types.js";

/**
 * In-process hub for tests and single-machine multi-agent runs. Not cross-device,
 * but it exercises the exact same Transport contract the real backends implement.
 */
export class MemoryHub {
  private subs = new Set<(e: Envelope, c: string | null) => void>();
  private log: Envelope[] = [];

  private emit(e: Envelope) {
    this.log.push(e);
    const cursor = String(this.log.length);
    for (const s of this.subs) s(e, cursor);
  }

  connect(): Transport {
    const hub = this;
    let handler: ((e: Envelope, c: string | null) => void) | null = null;
    const sub = (e: Envelope, c: string | null) => handler?.(e, c);
    return {
      async start(cursor: string | null) {
        const from = cursor ? Number(cursor) : 0;
        for (let i = from; i < hub.log.length; i++) handler?.(hub.log[i], String(i + 1));
        hub.subs.add(sub);
      },
      async stop() {
        hub.subs.delete(sub);
      },
      async publish(e: Envelope) {
        hub.emit(e);
      },
      onEnvelope(h) {
        handler = h;
      },
    };
  }
}
