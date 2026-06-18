# STATUS — Conclave v0.1

Built in one session as the first working cut. Everything below is **implemented and
tested**, not aspirational.

## What works (8/8 e2e tests green, typecheck clean)

| Area | State | Test |
|---|---|---|
| Wire protocol (envelope, ULID, validation, addressing) | ✅ | `test/core.test.ts` |
| Idempotent delivery (dedup by ULID) | ✅ | core |
| Presence + live roster (who's online) | ✅ | core |
| **RelayWS** transport (WebSocket push, outbound-only) | ✅ | `test/relay.test.ts` |
| RelayWS **durable replay** (offline host catches missed msgs on reconnect) | ✅ | relay |
| **GitBus** transport (commit-per-message, pull-based, no server/Docker) | ✅ | `test/git.test.ts` |
| Conflict-free concurrent writers (per-agent subdir + push retry) | ✅ | git |
| NodeHost durable state (atomic cursor + WAL, survives restart) | ✅ | relay replay |
| Claude Code **MCP adapter** (roster/send/inbox tools) | ✅ typecheck + boots | manual |
| **Python SDK** (zero-dep git-bus) + TS↔Python interop | ✅ | smoke (both directions) |
| CLI (`up` / `join` / `send`) | ✅ boots | manual |
| api-alignment example | ✅ runs | `npm run example` |

Run it yourself:
```bash
npm install && npm test && npm run example
```

## Design decisions locked this session

- **Name:** Conclave. **Stack:** TS core + Python SDK. **Default transport:** RelayWS,
  with **GitBus as a first-class peer** — because the real constraint set (no Docker on
  HPC, outbound-only firewalls, multi-day no-message-loss, auditability) is exactly where
  a single-broker push PoC falls down. Both sit behind one `Transport` interface so the
  agent code never changes. "Good tool, right scenario" is now a config flag, not a fork.

## Known limitations (honest list)

- **Relay is single-process** (PoC scale): no HA/failover, no auth yet. For
  reliability-critical, multi-day runs, use the **GitBus** transport (durable + serverless).
- **"Real-time" has a floor.** A pull adapter (CLI shim, MCP inbox, Python `poll`)
  consumes at its turn boundary / poll interval. Only always-on API loops are truly instant.
- **No auth/signing yet** (`sig` is reserved in the schema). Don't expose a relay on a
  hostile network until P4 lands.
- **No loop/cost guard yet** — two chatty agents can ping-pong tokens. P5.
- GitBus presence-over-commits is a bit heavy (a commit per heartbeat); fine for low
  agent counts, will add a lighter presence channel.

## Roadmap

- **P2** — more adapters: Codex/Gemini CLI shim, a `human` web UI, push into Claude Code
  via Channels (turn the MCP `inbox` from pull into interrupt).
- **P3** — NATS transport (HA push); ack/redelivery on RelayWS for unsent-on-restart.
- **P4** — ed25519 signing + capability-scoped tokens (who may ask whom to do what).
- **P5** — loop/cost guards (turn budgets, ping-pong detection, escalate-to-human),
  a coordination layer (shared task board, `owns` locks), and an observability room UI.
- **Dogfood** — re-express the existing cifn-chtc two-agent system as a Conclave
  deployment (GitBus transport + two Claude Code adapters) to prove it absorbs a real
  running system.

## Next session suggestions

1. Pick P2 adapter to add first (Codex shim is the highest-leverage — proves true model
   heterogeneity on the bus).
2. Decide relay auth model before any public deployment (shared secret vs ed25519).
3. Try the cifn-chtc dogfood — it's the most convincing demo for the GitHub launch.
