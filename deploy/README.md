# Conclave onboarding kit

Three roles, three deploy paths. Pick per machine.

```
   INPUT ZONES (write code)        CONTROL PLANE (server)         RESOURCE ZONE (run/deploy)
   human's Claude Code  ─┐          ┌──────────────────┐        ┌─ gpu box: conclave work ─┐
   + conclave mcp        │ ─task──▶ │  conclave serve  │ ─────▶ │  --role deploy           │
   coder: conclave work  │          │  (Docker, secure)│        │  --permission bypass     │
   └──────────────────────┘  ◀result─└──────────────────┘ ◀──────└──────────────────────────┘
```

**Prerequisite (each machine):** `git clone … && cd conclave && npm install && npm link` so the
`conclave` command is on your PATH. (No global install? Replace every `conclave …` below with
`npx tsx src/cli.ts …`.)

## 1. Server (one reachable host: VM / tailscale node)

```bash
./deploy/server.sh
```
Prints the **connect token**, the **admin token**, and a ready-to-paste `invite` command.

**Put TLS in front before real traffic** — the connect token crosses the wire. With a domain,
Caddy terminates TLS for both the WS bus (`:8787`) and the HTTP API + dashboard (`:8088`)
(`/etc/caddy/Caddyfile`):

```caddy
conclave.example.com {
    @ws header Connection *Upgrade*
    reverse_proxy @ws 127.0.0.1:8787    # WebSocket bus  → wss://conclave.example.com
    reverse_proxy 127.0.0.1:8088        # HTTP API + /dashboard → https://conclave.example.com/dashboard
}
```

Agents then use `--url wss://conclave.example.com` (and `--http-url https://conclave.example.com`
on `invite` / `join --enroll`).

## 2. Resource / coder nodes (each device)

On the admin machine, mint a scoped identity:
```bash
conclave invite --as gpu --role deploy --zone s-main \
    --url ws://HOST:8787 --token <connect> --admin-token <admin>
# (optionally --pin <pubkey> after `conclave keygen --as gpu` on the device, to defeat token interception)
```
On the device, enroll + run a supervised worker:
```bash
ENROLL=<enrollment-token> ./deploy/join.sh --as gpu --role deploy --zone s-main \
    --url ws://HOST:8787 --token <connect> --permission bypassPermissions
```
`join.sh` enrolls a local keypair (private key never leaves the device), then installs a
systemd `--user` service that survives reboots.

## 3. Human cockpit (your own Claude Code)

Enroll your identity (`./deploy/join.sh … --role human` or `conclave join --enroll …`), then add
Conclave as an MCP server so *using Claude Code IS the integration*:
```bash
claude mcp add conclave -- conclave mcp --as me --url ws://HOST:8787 --token <connect>
```
Now your Claude Code has `conclave_roster` / `conclave_send` / `conclave_inbox` tools and receives
inbound messages — tell it *"have the coder write X and the gpu box deploy it"* and it coordinates
over the bus. (A web UI alternative: `conclave human --port 7070`.)

**To onboard a Claude on another machine the same way, just _tell it to join_** — point it at
[../docs/join-a-claude.md](../docs/join-a-claude.md) with a name + the bus params; it enrolls itself
and comes online.

## Keeping nodes up to date

The wire protocol is backward-compatible, so an old node keeps working — but it misses fixes
(e.g. exactly-once under contention, durability) and new commands. Update a node to the latest:

```bash
./deploy/update.sh     # fetch → if behind: git pull + npm install + restart its conclave-* service(s)
```

**Auto-update on a timer** (systemd `--user`, survives reboot like the worker):
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/conclave-update.service <<'EOF'
[Unit]
Description=Conclave self-update
[Service]
Type=oneshot
ExecStart=%h/conclave/deploy/update.sh
EOF
cat > ~/.config/systemd/user/conclave-update.timer <<'EOF'
[Unit]
Description=Conclave self-update (hourly)
[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload && systemctl --user enable --now conclave-update.timer
```

**Or the Conclave-native way — tell them over the bus.** A node running a `--brain claude`
auto-responder (that you trust to run a shell) can update itself when asked:
```bash
conclave send --as admin --to "*" --kind event --subject conclave-update \
    --body "run ./deploy/update.sh and report back" --url ws://HOST:8787 --token <connect>
```
Fleet management as just another bus message — fitting, but only for trusted Claude agents.
Docker-image nodes (the server) update with a rebuilt image + `deploy/server.sh`.

See [../SECURITY.md](../SECURITY.md) for the trust model (zones are trust domains).
