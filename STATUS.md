# STATUS — Conclave v0.1

Built as the first working cut, then extended with a model-driven agent layer.
Everything below is **implemented and tested**, not aspirational.

## What works (23/23 e2e tests green, typecheck clean; +2 live tests self-skip)

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
| **AutonomousAgent + pluggable Brain** (model-driven agents) | ✅ | `test/agent.test.ts` |
| Two autonomous agents collaborating (request→compute→response) | ✅ | agent |
| **Rule brain** (deterministic) + **echo brain** | ✅ | agent |
| **Anthropic brain** (claude-opus-4-8, adaptive thinking) | ✅ typecheck; ⚠️ live call untested (needs ANTHROPIC_API_KEY) | — |
| **CLI-shim brain** (generic subprocess) + **codex/gemini presets** | ✅ | `test/cli-brain.test.ts` |
| Subprocess-driven agent answering on the bus (arg + stdin modes) | ✅ | cli-brain |
| CLI-shim failure → no-op (missing binary doesn't crash) | ✅ | cli-brain |
| **OpenAI-compat HTTP brain** (local models: Ollama/LM Studio/vLLM/…) | ✅ | `test/openai-brain.test.ts` |
| Local-model-backed agent answering on the bus (fake local server) | ✅ | openai-brain |
| Presence/heartbeats never hit the model server | ✅ | openai-brain |
| **LoopGuard** (rate + ping-pong limits) on `AutonomousAgent` | ✅ | `test/loop-guard.test.ts` |
| Two-agent ping-pong halted + escalated to a human | ✅ | loop-guard |
| **HumanServer** (person-as-agent web UI: inbox + send form) | ✅ | `test/human-server.test.ts` |
| Human bridge end-to-end (HTTP → bus → bot → bus → HTTP) | ✅ | human-server |
| **TokenBudget** guard (model brains report real usage; stop + escalate) | ✅ | `test/token-budget.test.ts` |
| **MCP push** (inbound bus msg → logging notification = Channels substrate) | ✅ | `test/mcp-adapter.test.ts` |
| MCP adapter pull inbox + conclave_send round-trip (in-memory client) | ✅ | mcp-adapter |
| **Live tests** vs real Ollama / Codex (env-gated, self-skip) | ⏭️ skip here | `npm run test:live` |
| CLI (`up` / `join` / `send` / `agent`) | ✅ boots | manual |
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

- **P2** — *(mostly done)* model-driven agents (`AutonomousAgent` + `Brain`): rule, echo,
  Anthropic (Claude), **CLI-shim** (subprocess + codex/gemini presets), and **OpenAI-compat
  HTTP** (local models — Ollama/LM Studio/vLLM, also hosted OpenAI) all landed. Claude +
  Codex + a local Ollama model can all collaborate on one bus. Still to do: a `human` web-UI
  brain, push into Claude Code via Channels (MCP `inbox` pull→interrupt), and live
  integration tests against real backends.
- **P3** — NATS transport (HA push); ack/redelivery on RelayWS for unsent-on-restart.
- **P4** — ed25519 signing + capability-scoped tokens (who may ask whom to do what).
- **P5** — *(mostly done)* **LoopGuard** (rate + ping-pong), **TokenBudget** (real-usage
  spend cap), **escalate-to-human**, and a **human web-UI agent** all landed. Remaining:
  a coordination layer (shared task board, `owns` locks) and a richer room UI.
- **Channels push** — the MCP adapter now emits a logging notification per inbound message
  (proven with an in-memory MCP client). Turning that into an actual turn-interrupt needs
  Claude Code's experimental `--channels` (client-side, out of our scope).
- **Live integration** — `npm run test:live` runs real Ollama + Codex agents on the bus;
  both self-skip when the backend is absent. Not yet run against live backends here.
- **Dogfood** — re-express the existing cifn-chtc two-agent system as a Conclave
  deployment (GitBus transport + two Claude Code adapters) to prove it absorbs a real
  running system.

## Next session suggestions

1. Pick P2 adapter to add first (Codex shim is the highest-leverage — proves true model
   heterogeneity on the bus).
2. Decide relay auth model before any public deployment (shared secret vs ed25519).
3. Try the cifn-chtc dogfood — it's the most convincing demo for the GitHub launch.
