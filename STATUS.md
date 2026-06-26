# STATUS — Conclave

Everything below is **implemented and tested** (72 e2e tests green, typecheck clean; live tests
self-skip without a backend). Run it yourself: `npm install && npm test`.

## What works

| Area | State |
|---|---|
| Wire protocol (envelope, ULID, validation, addressing) + idempotent delivery (dedup by ULID) | ✅ |
| Presence + live roster (who's online, capabilities, available/busy) | ✅ |
| **RelayWS** transport (WebSocket push, outbound-only) + **durable replay** on reconnect | ✅ |
| **GitBus** transport (commit-per-message, pull-based, no server/Docker) + conflict-free writers | ✅ |
| NodeHost durable state (atomic cursor + WAL, survives restart) | ✅ |
| **Secure mode** — per-agent **ed25519** identities, signed envelopes, server-side authorization | ✅ |
| **Enrollment** — admin `invite` → one-time token → device `join --enroll` (private key stays local); key-pinning | ✅ |
| **Zone isolation** — work plane is deny-by-default per zone; discovery plane is global | ✅ |
| **First-claim-wins** task ownership (server-authoritative) — exactly-once under contention | ✅ |
| Connection auth (challenge–response nonce), replay/freshness window, DoS guards | ✅ |
| **Deployable server** (`serve`): WS bus + HTTP API (tasks, history, blob data-exchange) | ✅ |
| **Admin dashboard** at `/dashboard` — node topology by zone, live status, 5 views | ✅ |
| **Shared task board** (convergent, role routing) + self-organizing `work` agents + `--handoff` pipelines | ✅ |
| **Pluggable Brain** agents — rule/echo, Anthropic (Claude), Claude Code teammate (no API key), Codex, Gemini, local (Ollama/LM Studio/OpenAI-compat) | ✅ |
| **LoopGuard** + **TokenBudget** + escalate-to-human | ✅ |
| **HumanServer** web UI (person-as-agent) + **MCP adapter** (roster/send/inbox + inbound push) | ✅ |
| **Python SDK** (zero-dep git-bus) + TS↔Python interop | ✅ |
| Live cross-machine pipeline (lab coder → home deployer ran on an RTX 5090) | ✅ |

## Known limitations (hardening roadmap)

See [SECURITY.md](./SECURITY.md#known-limitations-hardening-roadmap) for the full list. In short:

- **No claim lease/TTL yet** — a task whose worker is *revoked* is freed, but one whose worker
  dies silently stays claimed until an admin revokes it.
- **Single-process relay** (no HA/failover); the durable log isn't compacted yet. For a
  no-server / no-single-point setup, use the **GitBus** transport.
- **TLS** is expected to be terminated by a reverse proxy (`wss://` / `https://`) in front.
- Delivery to message handlers is eventually-consistent (not strictly FIFO); convergent
  consumers like the task board are order-independent.

This is pre-1.0 software — several internal adversarial reviews, no external audit.
