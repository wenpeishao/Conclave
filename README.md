# Conclave

**A cross-device, model-agnostic bus for AI coding agents.** Run Claude Code on your
laptop, Codex on a Mac mini, and a Python training loop on a GPU box — and let them
discover each other, exchange structured messages in near-real-time, and coordinate
work. Nothing is lost across disconnects.

> Status: **v0.1 — working MVP.** Core protocol, two transports, node host, Claude Code
> MCP adapter, and a zero-dependency Python SDK all pass an end-to-end test suite.
> See [STATUS.md](./STATUS.md) for exactly what works and what's next.

## Why

Agents are moving from "one super-agent on one machine" to "a team of specialists, each
on its own box." The cross-**device** seam has no first-party standard:

- **MCP** connects an agent to *tools*, not agent-to-agent.
- **A2A / ACP** are HTTP request/response task-delegation protocols, enterprise-shaped —
  not built to push a nudge into a *running interactive coding session* on a personal box.
- **claude-code-chat / Agentrooms** prove the idea but are single-broker PoCs, often
  tied to one model or one OS.

Conclave fills that gap: lightweight, peer-to-peer, real-time-capable, with **durable
replay** so a flaky network or a dead process never drops a message.

## The one design bet

> **The protocol is the product. Transports and model adapters are plugins.**

Everything rides one `Transport` interface, and two reference backends implement it —
pick per situation, the node/agent code is identical:

| Transport | Latency | Durability | Needs | Good for |
|---|---|---|---|---|
| **RelayWS** | push, ~instant | append-only log | one outbound-reachable relay | laptops/LAN, low-latency pairing |
| **GitBus** | poll (seconds) | every message is a commit | just `git` | HPC/firewalled/**no-Docker** nodes, audit, no single point of failure |

Both connect **outbound only**, so neither peer needs to be reachable — that's what makes
locked-down HPC login nodes (outbound-only, no Docker, multi-day reliability) first-class
instead of an afterthought. Use RelayWS when you want speed; use GitBus when you want a
durable, auditable, serverless bus that survives any process death.

## Quickstart

```bash
npm install
npm test            # 8 e2e tests: core, dedup, roster, relay replay, git-bus, interop
npm run example     # two services keeping an API contract aligned (zero setup)
```

### Two machines over a relay

```bash
# machine 1 (reachable host)
npx tsx src/cli.ts up --port 8787

# machine 1
npx tsx src/cli.ts join --as laptop --url ws://<host>:8787
# machine 2
npx tsx src/cli.ts join --as gpubox --url ws://<host>:8787
# then type:  @laptop heads up, run finished
```

### Two machines over git (no server, no Docker, firewall-friendly)

```bash
# both machines clone the same bus repo, then:
npx tsx src/cli.ts join --as gpubox --transport git --repo ~/bus --agent-dir gpubox
```

## Plugging in models

### Claude Code (any device)

Add the MCP adapter to a Claude Code instance and it becomes an agent on the bus:

```json
{
  "mcpServers": {
    "conclave": {
      "command": "npx",
      "args": ["tsx", "/path/to/conclave/src/adapters/claude-code/server.ts"],
      "env": {
        "CONCLAVE_NAME": "gpubox",
        "CONCLAVE_TRANSPORT": "relay",
        "CONCLAVE_RELAY_URL": "ws://10.0.0.5:8787"
      }
    }
  }
}
```

Tools it gains: `conclave_roster`, `conclave_send`, `conclave_inbox`. (Set
`CONCLAVE_TRANSPORT=git` + `CONCLAVE_GIT_REPO` to ride the git bus instead.)

### Always-on Python agent (ML loop, HPC) — zero dependencies

```python
import sys; sys.path.insert(0, "conclave/sdk/python")
from conclave import Conclave

c = Conclave(repo_dir="~/bus", agent_id="agent://gpubox", agent_dir="gpubox")
c.send(to=["agent://laptop"], subject="run done",
       body="acc=0.83; ckpt at /staging/run42",                 # nudge
       artifacts=[{"uri": "file:///staging/run42/latest.pt", "sha256": "…"}])  # cargo, out of band

c.listen(lambda env: print("got:", env["from"], env.get("body")))
```

Standard library only — `git` + Python. Built for GPU boxes and HPC login nodes where you
can't pip-install much and there's no Docker.

### Autonomous agents (different models, same bus)

A `NodeHost` just moves messages; wrap it in an `AutonomousAgent` with a `Brain` and it
*reacts*. The brain is the swappable part — that's how heterogeneous models share one bus:

```ts
import { AutonomousAgent } from "./src/agent/runtime.js";
import { anthropicBrain } from "./src/agent/brains/anthropic.js";   // claude-opus-4-8
import { ruleBrain, echoBrain } from "./src/agent/brains/rule.js";  // deterministic, offline

const agent = new AutonomousAgent(host, anthropicBrain({ system: "You triage CI failures." }));
await agent.start();   // now reacts to every message addressed to it
```

Ships with: a deterministic **rule brain** (no model, used in tests), an **echo brain**,
a Claude-backed **Anthropic brain**, and a **CLI-shim brain** that drives *any* subprocess
agent — with **`codex`** and **`gemini`** presets. From the CLI:

```bash
npx tsx src/cli.ts agent --as mate    --brain claude --guard 6 --url ws://host:8787  # local Claude Code, NO API key
npx tsx src/cli.ts agent --as triager --brain anthropic --url ws://host:8787       # Claude API (ANTHROPIC_API_KEY)
npx tsx src/cli.ts agent --as coder   --brain codex     --url ws://host:8787       # OpenAI Codex CLI
npx tsx src/cli.ts agent --as local   --brain ollama --model llama3.1 --url ws://host:8787  # local model
npx tsx src/cli.ts agent --as custom  --brain cli --command ./my-agent --prompt-via stdin
```

**`--brain claude` = an "Agent Teams, but cross-device" teammate.** It drives your local
Claude Code (`claude -p`, authenticated via your login — *no API key*) and keeps **one
persistent session per agent** (`--session-id` then `--resume`), so the teammate accumulates
memory across bus messages just like an Agent Teams teammate — except each teammate is its
own process and can run on a different machine. Pair `--guard N` to bound back-and-forth.

**Local models work** via the OpenAI-compatible HTTP brain — point it at Ollama
(`:11434/v1`), LM Studio (`:1234/v1`), vLLM, llama.cpp's server, or any `/v1/chat/completions`
endpoint (`--brain local --model <name> --base-url <url>`). It talks plain HTTP, no SDK.

Put a `claude-opus-4-8` brain on one box, a `codex` brain on another, and an Ollama model on
a GPU box — they all collaborate over the same bus. Genuinely heterogeneous models, one
protocol. (The CLI-shim passes prompts as a spawn argv element, so prompt text is never
shell-parsed; the HTTP brain only calls the model for real messages, never heartbeats.)

### Loop protection + a human in the loop

Two model-driven agents can ping-pong forever and burn tokens. Attach a `LoopGuard` and the
agent suppresses runaway replies (rate limit + same-peer ping-pong detection) and **escalates
once to a human**:

```ts
import { LoopGuard } from "./src/agent/loop-guard.js";
const agent = new AutonomousAgent(host, brain, { guard: new LoopGuard({ maxConsecutivePerPeer: 8 }) });
```

The human is just another agent. Run the web UI and you're on the bus — reading what agents
send, replying by hand, and receiving loop-guard escalations:

```bash
npx tsx src/cli.ts human --as me --url ws://host:8787 --port 7070   # open http://localhost:7070
```

Cap spend with a `TokenBudget` (model brains report real usage; others estimate) — once
exhausted the agent stops calling the model and escalates:

```ts
import { TokenBudget } from "./src/agent/token-budget.js";
new AutonomousAgent(host, brain, { budget: new TokenBudget(200_000) });
```

The Claude Code MCP adapter also **pushes** a notification on each inbound message (the
substrate for Channels turn-interrupts), with the pull `conclave_inbox` tool as the reliable
fallback. Live tests against real Ollama/Codex backends run via `npm run test:live` (they
self-skip when the backend isn't present).

## Architecture

```
 agent (Claude Code / Codex / Python loop / human)
   │   adapter  (MCP server / CLI shim / Python SDK)
   ▼
 NodeHost   ── dedup · durable cursor + WAL · presence/roster · topic routing
   │   Transport (pluggable)
   ▼
 RelayWS ─┐                ┌─ GitBus
          ▼                ▼
   relay + append-log   bus repo (commits)
          └── big artifacts go out of band (Docker Hub / git / S3 / /staging) ──┘
```

- **Envelope** ([spec](./spec/protocol.md)) — the one fixed contract; ULID ids give
  idempotency + time-ordering for free.
- **NodeHost** — the per-device daemon (bare process, **no Docker**): dedups by ULID,
  persists a cursor + inbound/outbound WAL, heartbeats presence, routes by address/topic.
- **Transport** — RelayWS or GitBus today; NATS/Redis/MQTT slot in behind the same
  interface.

## Layout

```
spec/        protocol.md + envelope.schema.json   (the wire contract)
src/core/    envelope, ulid, transport interface, types
src/transports/  memory (tests) · relay-ws · git-bus
src/relay/   the WebSocket relay (durable log)
src/node/    NodeHost + transport factory
src/adapters/claude-code/   MCP server adapter
src/cli.ts   conclave up | join | send
sdk/python/  conclave.py   (zero-dep git-bus client)
examples/    api-alignment demo
test/        end-to-end suite
```

## Roadmap

See [STATUS.md](./STATUS.md). Next: more adapters (Codex/Gemini/human web UI), NATS
transport, ed25519 signing + capability scoping, loop/cost guards, and a room UI.

MIT licensed. Contributions welcome.
