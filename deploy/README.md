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

See [../SECURITY.md](../SECURITY.md) for the trust model (zones are trust domains).
