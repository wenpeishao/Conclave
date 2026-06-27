# Remote-control resource node — a Claude Code session on a server you steer from your phone

> Put a **remote-controllable Claude Code session on a remote server** so you can operate a service
> on that box (manage DNS, deploy, run ops) from [claude.ai/code](https://claude.ai/code) or the
> Claude mobile app. This is the human-steered flavor of a Conclave **resource node** — a node scoped
> to operate one service, that holds the permission/credentials for it.

## When to use which model

A resource node (one that operates a specific service on a box) has two control models — pick by who drives it:

| | Bus-integrated, autonomous | Human-steered remote control |
|---|---|---|
| command | `conclave agent --as <name> --brain claude --permission bypassPermissions` | `claude remote-control` (on the box) |
| driven by | bus messages from other agents (event-driven) | **you**, from phone / web (claude.ai/code or the app) |
| brain | spawns `claude -p --resume` per message | a live interactive session |
| **remote-controllable?** | **NO** — print mode can't be remote-controlled | **YES** — that's the whole point |

Key fact: **Claude Code Remote Control does NOT work with `claude -p` (print mode).** So a `--brain claude`
conclave agent can't be remote-controlled; for human steering you run `claude remote-control` separately
(both can coexist on the same box).

## Prerequisites (on the server)

- **Claude Code ≥ 2.1.51**, logged in with a **subscription** (Pro/Max/Team/Enterprise) — **API keys are
  NOT supported for Remote Control**. Verify it's authed: `claude -p "say hi"` returns a reply.
- **Outbound 443 only** — the session makes outbound HTTPS to Anthropic; **no inbound ports** are opened.
- `node` is only needed if this box also runs `conclave agent` (the conclave CLI needs it); `claude`
  itself is a standalone binary (`~/.local/bin/claude`).

## Recipe (headless, over SSH)

```bash
# 1. a workspace dir for the remote sessions
mkdir -p ~/rc-workspace

# 2. pre-trust it so the headless launch doesn't block on the interactive "Workspace not trusted"
#    dialog. Back up the config first, then set hasTrustDialogAccepted on the project entry.
cp ~/.claude.json ~/.claude.json.bak
node -e 'const fs=require("fs"),os=require("os"),p=require("path");const f=p.join(os.homedir(),".claude.json");
const c=JSON.parse(fs.readFileSync(f,"utf8"));c.projects=c.projects||{};const d=p.join(os.homedir(),"rc-workspace");
c.projects[d]={...(c.projects[d]||{}),hasTrustDialogAccepted:true,history:[],mcpServers:{}};
fs.writeFileSync(f,JSON.stringify(c,null,2));console.log("trusted",d)'
#    (Alternative: just run `claude` once interactively in that dir over `ssh -t` and accept the dialog.)

# 3. launch the remote-control server, detached so it survives the SSH session
cd ~/rc-workspace
setsid claude remote-control --name "<box-name>" --permission-mode bypassPermissions \
    > ~/remote-control.log 2>&1 < /dev/null &

# 4. grab the connect link from the log
sleep 10; grep -o 'https://claude.ai/code?environment=[^ ]*' ~/remote-control.log | head -1
```

Open that `https://claude.ai/code?environment=env_…` link (or the Claude mobile app, same account) →
you'll see the box (`--name`) → start a session on it. New sessions run in `~/rc-workspace` with the
`--permission-mode` you set, so they can run commands on the box.

`claude remote-control` flags: `--name <shown in claude.ai/code>`, `--permission-mode <acceptEdits|auto|
bypassPermissions|default|dontAsk|plan>`, `--debug-file <path>`, `-v`. Server mode serves up to 32 sessions.

## Persist across reboots (systemd --user)

`setsid` dies on reboot. For a permanent resource node, a `--user` service (claude is standalone, so it
only needs `~/.local/bin` on PATH):

```ini
# ~/.config/systemd/user/claude-rc.service
[Unit]
Description=Claude remote-control resource node
After=network-online.target
[Service]
Environment=PATH=%h/.local/bin:/usr/bin:/bin
WorkingDirectory=%h/rc-workspace
ExecStart=%h/.local/bin/claude remote-control --name "%H" --permission-mode bypassPermissions
Restart=always
RestartSec=10
[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload && systemctl --user enable --now claude-rc.service
loginctl enable-linger "$USER"   # so it runs without an active login
```

## Gotchas (learned the hard way)

- **"Workspace not trusted"** on a headless launch → it's waiting on the trust dialog. Pre-trust via
  `~/.claude.json` (step 2) or accept it once interactively. Always back the file up first — it's the
  whole Claude Code config.
- **`claude -p` can't be remote-controlled.** If you want to steer it from your phone, it must be
  `claude remote-control` / an interactive session, not print mode.
- **Subscription login required**, not an API key.

## Security

- `--permission-mode bypassPermissions` means a remote session can run **any** command on the box. Scope
  it: a dedicated user/box, only the credentials the service needs (e.g. a Cloudflare API token with
  just DNS-edit scope for one zone). Treat the session like shell access to that machine.
- Outbound-only; nothing new is exposed on the public internet.

> Could be promoted to a Claude Code skill (`/remote-node`) that runs the recipe against a named host.
