# Resource nodes — a node that operates one service, pre-configured once

> A **resource node** is a Conclave node scoped to operate a single service — a GPU box (submit SLURM
> jobs), a DNS keeper (Cloudflare), a deployer, etc. Unlike a generic teammate, it needs
> **environment-specific pre-configuration**: knowledge about its surroundings and the credentials for
> its service. The whole point: **you configure it once, and from then on it just knows.**

## The four questions

1. **What problem?** A resource node can't operate its service cold. A GPU node on SSCC must know the
   SLURM partitions / modules / the NFS stale-cache gotcha; a DNS node must hold the Cloudflare API
   token. That setup is environment-specific and shouldn't be re-explained every session.
2. **Why it matters.** Without it you re-paste the API key and re-describe the environment on every
   interaction — and a key pasted into chat is neither safe nor persistent.
3. **Where prior work falls short.** Conclave's `--persona` is a single string; there's no convention
   for *persistent per-node knowledge + secrets*.
4. **Core idea.** A resource node **is a config directory** (its working dir) holding three things;
   configured once (the node can even write its own config from one conversation), auto-loaded forever.

## The layout — three things, each in its place

```
~/conclave-nodes/<name>/            ← the node's working directory (its `cwd`)
├── CLAUDE.md                       ← ENVIRONMENT KNOWLEDGE — auto-loaded every session
└── .claude/skills/<svc>/SKILL.md   ← CAPABILITIES — how to operate the service (on-demand)
~/.config/<name>/env                ← SECRETS (chmod 600, gitignored) — API keys/tokens
```

| what | where | why |
|---|---|---|
| **Environment knowledge** (SSCC's SLURM quirks, the DNS zone, ops conventions) | **`CLAUDE.md`** in the node's cwd | Claude Code auto-loads it; human-readable, editable, version-controllable |
| **Capabilities** (`submit-slurm-job`, `manage-dns`) | **`.claude/skills/`** | packages "how to do this" as on-demand skills |
| **Secrets** (API keys) | **`~/.config/<name>/env`, `chmod 600`** | referenced **by name** in CLAUDE.md (`$CLOUDFLARE_API_TOKEN`); **never** the value, never committed, never echoed |

**Secrets are read from the file, not baked into the process.** CLAUDE.md tells the node "your token is
in `~/.config/<name>/env` — `source` it when you need it." So updating the token is just editing that
600 file; no rebuild, nothing in chat or the repo.

## Bootstrap = one conversation (the node configures itself)

You don't push config from outside. You tell the node, once, who it is — over Remote Control (cleanest,
the secret never passes through a third party) or the bus:

> "You are the SSCC GPU node. Environment: partitions `gpu`/`gpu-long`, modules `cuda/12`, submit with
> `sbatch`; **deploy modified SLURM-read scripts under a NEW filename** (NFS caches the old one). Write
> this into your CLAUDE.md."
>
> "Here is the Cloudflare API token: `<token>`. Store it in `~/.config/conclave-dns/env` as
> `CLOUDFLARE_API_TOKEN=…`, chmod 600. Confirm, don't echo it back."

The node writes its own `CLAUDE.md` and drops the secret in its 600 env file. **From then on every
session auto-loads the knowledge + reads the secret from the file — it just knows.** (This is also where
durable [[memory]]-style lessons like the SSCC NFS stale-cache gotcha live.)

## Works for both node models

A resource node can be either control model (see docs/device-agent.md, docs/remote-control-node.md) —
both have a working dir, so both pick up `CLAUDE.md` + skills, and both can read the 600 env file:

- **Bus-integrated** (`conclave agent --as <name> --brain claude --permission bypassPermissions`) — run
  it with its node dir as cwd: `cd ~/conclave-nodes/<name> && node … cli.ts agent --as <name> …`.
- **Remote-controlled** (`claude remote-control` with that dir as the workspace) — you steer it.

## Security

- Secrets live only in the `chmod 600` env file on the node, referenced by name. Scope each token to the
  minimum (e.g. a Cloudflare token limited to DNS-edit on one zone). Treat the node as shell access to
  that machine.
- Knowledge in CLAUDE.md / skills is fine to commit/share; the env file is **not** — gitignore it.
