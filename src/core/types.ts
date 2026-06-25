// Conclave wire protocol — core types (v1).
// The envelope is the ONE non-pluggable contract. Transports move envelopes;
// model adapters produce/consume them. Big artifacts NEVER travel inline — they
// are referenced by URI + hash and shipped out-of-band (Docker Hub / git / S3 / staging).

export type Kind =
  | "message" // directed natural-language / structured note
  | "event" // broadcast fact (CI result, contract changed, ...)
  | "request" // expects a `response` with matching `corr`
  | "response" // reply to a `request`
  | "handoff" // task handoff (carries a task object in body)
  | "presence" // agent online/heartbeat, body = AgentCard
  | "ack"; // delivery acknowledgement (body = { of: <id> })

export interface Artifact {
  uri: string; // git+ssh://repo#sha, s3://..., docker://..., file:///staging/...
  sha256?: string; // integrity check for the out-of-band blob
  desc?: string;
}

export interface Envelope {
  v: "1";
  id: string; // ULID — globally unique + time-sortable → idempotency key AND cursor
  ts: string; // ISO-8601
  from: string; // agent URI, e.g. agent://orders-svc@deviceA
  to: string[] | "*"; // explicit recipients, topic:// addresses, or broadcast
  seq?: number; // per-sender monotonic → single-source ordering
  kind: Kind;
  corr?: string; // correlation id (request/response pairing)
  subject?: string;
  body?: unknown;
  content_type?: string; // text/markdown, application/json, ...
  artifacts?: Artifact[];
  ttl?: number; // seconds
  zone?: string; // scope tag — server delivers zone-scoped envelopes only to that zone's members
  sig?: string; // optional ed25519 signature (P4)
}

export interface AgentCard {
  id: string; // agent URI
  name: string;
  model?: { vendor?: string; id?: string; runtime?: string };
  device?: { host?: string; kind?: string };
  capabilities?: string[]; // e.g. ["htcondor.submit", "staging.rw"]
  owns?: string[]; // write-ownership claims, e.g. ["repo:foo/chtc/**"]
  addressable?: boolean;
  realtime?: "push" | "poll"; // adapter property → sets the latency floor
  policy?: Record<string, unknown>; // e.g. { max_tokens_per_hour: 2_000_000 }
}
