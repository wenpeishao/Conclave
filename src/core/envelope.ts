import { ulid } from "./ulid.js";
import type { Envelope, Kind, Artifact } from "./types.js";

export interface MakeOpts {
  from: string;
  to: string[] | "*";
  kind?: Kind;
  subject?: string;
  body?: unknown;
  corr?: string;
  content_type?: string;
  artifacts?: Artifact[];
  ttl?: number;
  seq?: number;
}

export function makeEnvelope(o: MakeOpts): Envelope {
  const e: Envelope = {
    v: "1",
    id: ulid(),
    ts: new Date().toISOString(),
    from: o.from,
    to: o.to,
    kind: o.kind ?? "message",
  };
  if (o.seq !== undefined) e.seq = o.seq;
  if (o.corr) e.corr = o.corr;
  if (o.subject) e.subject = o.subject;
  if (o.body !== undefined) e.body = o.body;
  if (o.content_type) e.content_type = o.content_type;
  if (o.artifacts) e.artifacts = o.artifacts;
  if (o.ttl) e.ttl = o.ttl;
  return e;
}

const REQUIRED = ["v", "id", "ts", "from", "to", "kind"] as const;

export function validateEnvelope(e: unknown): string[] {
  const errs: string[] = [];
  if (typeof e !== "object" || e === null) return ["not an object"];
  const o = e as Record<string, unknown>;
  for (const k of REQUIRED) if (o[k] === undefined) errs.push(`missing ${k}`);
  if (o.v !== undefined && o.v !== "1") errs.push(`unsupported version ${String(o.v)}`);
  if (o.to !== undefined && o.to !== "*" && !Array.isArray(o.to)) errs.push("`to` must be array or '*'");
  return errs;
}

/** Does this envelope target `self` (an agent id) or one of its subscribed topics? */
export function deliverableTo(e: Envelope, self: string, topics: Set<string>): boolean {
  if (e.to === "*") return true;
  if (Array.isArray(e.to)) {
    return e.to.some((t) => t === self || (t.startsWith("topic://") && topics.has(t)));
  }
  return false;
}
