# Conclave Wire Protocol v1

The envelope is the only non-pluggable contract in Conclave. Transports move
envelopes; model adapters produce and consume them. Anything that speaks this format —
in any language, over any transport backend — is a Conclave agent.

## Envelope

JSON object. Schema: [`envelope.schema.json`](./envelope.schema.json).

| field | req | meaning |
|---|---|---|
| `v` | ✓ | protocol version, `"1"` |
| `id` | ✓ | ULID — globally unique **and** time-sortable. Doubles as the idempotency key (dedup) and, for the git transport, the replay cursor. |
| `ts` | ✓ | ISO-8601 timestamp |
| `from` | ✓ | sender agent URI, e.g. `agent://orders@deviceA` |
| `to` | ✓ | array of agent ids / `topic://` addresses, or `"*"` for broadcast |
| `seq` |  | per-sender monotonic counter → single-source ordering |
| `kind` | ✓ | one of the message kinds below |
| `corr` |  | correlation id (pairs a `response` to its `request`) |
| `subject` |  | short subject line |
| `body` |  | text or structured payload |
| `content_type` |  | e.g. `text/markdown`, `application/json` |
| `artifacts` |  | **out-of-band** references (uri + sha256) to big blobs |
| `ttl` |  | seconds |
| `sig` |  | optional ed25519 signature (roadmap) |

### Message kinds

- `message` — directed note (natural language or structured)
- `event` — broadcast fact (CI finished, contract changed, job done)
- `request` / `response` — correlated RPC-ish exchange (`corr` links them)
- `handoff` — task handoff; `body` carries the task object
- `presence` — agent online/heartbeat; `body` is the sender's AgentCard
- `ack` — delivery acknowledgement; `body` = `{ "of": "<envelope id>" }`

## The artifact rule

Big payloads — model checkpoints, container images, large schemas, datasets — **never
travel inline**. They are referenced via `artifacts[].uri` (+ `sha256` for integrity)
and shipped out of band: Docker Hub, git, S3, an HPC `/staging` mount. The bus carries
coordination, not cargo. (This is the hard-won lesson from real two-agent HPC runs.)

## Delivery semantics

- **At-least-once + idempotent.** Receivers dedup by `id` (ULIDs are unique). A
  duplicate redelivery is dropped.
- **Single-source ordering** via `seq`. No global total order is promised — it is
  expensive and rarely needed; causal/per-sender order suffices.
- **Durable replay.** Each transport defines an opaque `cursor` ("seen up to here").
  A restarting host replays only what it missed. (Relay → log line index; Git →
  high-water ULID, which sorts chronologically.)

## Addressing

- `agent://<name>[@host]` — a specific agent.
- `topic://<name>` — a subscription channel; delivered to hosts that subscribed.
- `"*"` — broadcast to every host.

`topic://presence` is reserved: every host publishes its AgentCard there on join and
on each heartbeat, which is how the roster (who's online) is built.

## AgentCard

Published as the `body` of `presence` envelopes.

```jsonc
{
  "id": "agent://gpubox@chtc",
  "name": "gpubox",
  "model": { "vendor": "anthropic", "id": "claude-opus-4-8", "runtime": "claude-code" },
  "device": { "host": "chtc", "kind": "cluster-login" },
  "capabilities": ["htcondor.submit", "staging.rw"],
  "owns": ["repo:cifn-chtc/chtc/**"],   // write-ownership claim
  "realtime": "push",                    // push | poll — sets the latency floor
  "policy": { "max_tokens_per_hour": 2000000 }
}
```

`capabilities` + `owns` are the machine-readable basis for routing and for conflict-free
collaboration (an agent stays out of another's `owns` territory).
