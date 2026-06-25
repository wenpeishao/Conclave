import { WebSocket } from "ws";
import type { Transport } from "../core/transport.js";
import type { Envelope } from "../core/types.js";
import { signData, type Identity } from "../core/identity.js";

/**
 * WebSocket client transport. Connects OUTBOUND to a relay (so it works from behind
 * NAT / outbound-only HPC firewalls — neither peer needs to be reachable). Auto-
 * reconnects with backoff and re-sends `hello` with the last cursor to resync.
 *
 * Durability note: in-flight publishes are queued in memory while disconnected; the
 * node host also persists them to its outbound WAL. For across-restart durability of
 * UNSENT messages, prefer the GitBus transport (every message is a commit).
 */
export class RelayWSTransport implements Transport {
  private url: string;
  private ws: WebSocket | null = null;
  private handler: ((e: Envelope, c: string | null) => void) | null = null;
  private cursor: string | null = null;
  private outQ: Envelope[] = [];
  private open = false;
  private closing = false;
  private backoff = 500;
  private identity?: Identity;

  constructor(url: string, token?: string, identity?: Identity) {
    // Auth (if any) rides as a ?token= query param on the ws URL.
    if (token && !/[?&]token=/.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    }
    this.url = url;
    this.identity = identity;
  }

  // A signed, timestamped hello authenticates this connection to the relay so it can route
  // by identity/zone. The timestamp bounds how long a captured hello can be replayed.
  private helloFrame(): object {
    const base = { t: "hello", cursor: this.cursor };
    if (!this.identity) return base;
    const ts = new Date().toISOString();
    const sig = signData(this.identity.privateKey, { id: this.identity.id, cursor: this.cursor, ts });
    return { ...base, id: this.identity.id, ts, sig };
  }

  onEnvelope(h: (e: Envelope, c: string | null) => void) {
    this.handler = h;
  }

  async start(cursor: string | null): Promise<void> {
    this.cursor = cursor;
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      ws.on("open", () => {
        this.open = true;
        this.backoff = 500;
        ws.send(JSON.stringify(this.helloFrame()));
        for (const e of this.outQ.splice(0)) ws.send(JSON.stringify({ t: "pub", env: e }));
        settle();
      });
      ws.on("message", (d) => {
        let m: { t?: string; env?: Envelope; cursor?: string | null; reason?: string };
        try {
          m = JSON.parse(d.toString());
        } catch {
          return;
        }
        if (m.t === "env" && m.env) {
          this.cursor = m.cursor ?? this.cursor;
          this.handler?.(m.env, this.cursor);
        } else if (m.t === "err") {
          console.error(`[conclave] relay rejected a message: ${m.reason ?? "unauthorized"}`);
        }
      });
      ws.on("close", () => {
        this.open = false;
        if (!this.closing) {
          setTimeout(() => {
            this.backoff = Math.min(this.backoff * 2, 10000);
            void this.connect();
          }, this.backoff);
        }
        settle(); // never hang node start just because the relay is down
      });
      ws.on("error", () => {
        /* 'close' fires next and handles reconnect */
      });
    });
  }

  async stop(): Promise<void> {
    this.closing = true;
    const ws = this.ws;
    // Flush buffered frames before closing so a just-published message (e.g. a one-shot
    // `conclave board add`) actually reaches the relay instead of dying in the send buffer.
    if (ws && ws.readyState === ws.OPEN) {
      const deadline = Date.now() + 2000;
      while (ws.bufferedAmount > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    ws?.close();
  }

  async publish(env: Envelope): Promise<void> {
    if (this.open && this.ws) this.ws.send(JSON.stringify({ t: "pub", env }));
    else this.outQ.push(env);
  }
}
