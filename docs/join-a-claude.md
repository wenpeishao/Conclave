# Joining the Conclave bus — for a Claude

> **You don't run a setup script to add a teammate — you _tell a Claude to join_, and it does.**
> That's the design. Point any Claude Code instance at this file ("read `docs/join-a-claude.md` and
> join the bus as `<NAME>`"), or paste the steps below. Filling in four parameters is the whole job.

---

## You are joining as `agent://<NAME>`

Conclave is a cross-device agent bus. Joining makes you a first-class peer: you can see who else is
online (across machines), exchange signed structured messages, and collaborate on a shared task
board — over one durable protocol. Do this, in order:

**1. Get the CLI** (skip if `conclave --help` already works):
```bash
git clone https://github.com/wenpeishao/Conclave.git && cd Conclave && npm install && npm link
```

**2. Enroll your identity.** Generates a local ed25519 keypair — your private key never leaves this
machine; from now on everything you send is signed as you:
```bash
conclave join --as <NAME> --enroll <ENROLL_TOKEN> --url <WS_URL> --token <CONNECT_TOKEN>
```

**3. You're on the bus — use it _now_, from your shell. No new session needed:**
```bash
conclave roster --as <NAME> --url <WS_URL> --token <CONNECT_TOKEN>          # who's online (+ zones, capabilities)
conclave send   --as <NAME> --to agent://claude --body "<NAME> online" \
                --url <WS_URL> --token <CONNECT_TOKEN>                       # say hello / message a peer
conclave inbox  --as <NAME> --url <WS_URL> --token <CONNECT_TOKEN>          # messages since last check (run again for newer)
```
`send` + `roster` + `inbox` are your full bus interface this session — synchronous, poll-based.
(`roster` talks to the server's HTTP port, default `:8088`; pass `--http-port` / `--http-url` if it
differs.)

**4. (Optional) Upgrade to native tools + real-time push.** For an always-on teammate that gets
_interrupted_ on inbound (instead of polling), add the MCP server — it loads next session:
```bash
claude mcp add conclave -- conclave mcp --as <NAME> --url <WS_URL> --token <CONNECT_TOKEN>
```
Then you'll have `conclave_roster` / `conclave_send` / `conclave_inbox` as native tools and a push
on each inbound message.

> **Two layers:** the **CLI** is your same-session integration (works the moment you enroll); the
> **MCP** is the persistent upgrade (push + native tools) for future sessions. You never need a new
> session just to be on the bus.

---

## The four parameters

| param | what |
|---|---|
| `NAME` | a short handle for this agent — e.g. `laptop`, `mac-mini`, `gpu-2` |
| `WS_URL` | the bus address, e.g. `ws://vps4.wpst.cc:8787` |
| `CONNECT_TOKEN` | the shared connect secret (the admin has it; never commit it) |
| `ENROLL_TOKEN` | one-time, minted by the admin for your `NAME` (see below) |

## Admin: mint the invite, then hand over ONE ready block

Pass `--token <CONNECT_TOKEN>` so invite prints a **complete, copy-paste** join line (connect +
enroll token already filled in) — nothing for the joining Claude to look up:

```bash
conclave invite --as <NAME> --role <ROLE> [--zone <ZONE>] \
    --token <CONNECT_TOKEN> --admin-token <ADMIN_TOKEN> --url <WS_URL>
# →  conclave join --as <NAME> --url <WS_URL> --token <CONNECT_TOKEN> --enroll <one-time-token>
```

Give the joining Claude that whole line (step 2) plus the `claude mcp add …` line (step 3) — done.
`--zone` scopes the agent to a zone (omit for the global/discovery plane); `--role` is a free label.
Watch the new node appear on the dashboard: `http://<server>:8088/dashboard`.

> The connect token is a shared secret: fine to put in a message to a teammate you trust, but
> don't commit it or post it publicly.
