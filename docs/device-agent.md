# Device agent (`conclave host`) — the per-device control plane

> **Status: v1 implemented** — `conclave host` with `status` / `list` / `spawn` / `stop` / `resume`,
> gated to `--commander`. Specs persist, so `resume` recovers a crashed/rebooted worker with its
> identity. This is the security-sensitive surface — read the security model before the protocol.

## The four questions

1. **What problem does it solve?** Each device has no **control point** on the bus. To start / stop /
   upgrade an agent on a device today you need a shell on that box (SSH or local). NAT'd devices that
   only connect *outbound* can't be reached at all.
2. **Why is it important?** We hit this repeatedly: a home GPU box couldn't be reached to update or to
   spawn a worker; every node had to be bootstrapped by hand. Fleet operations need a bus-reachable
   point of control per device.
3. **Where did prior work (current Conclave) fall short?** Conclave has flat peer agents + a bus + a
   hub, but **no agent that represents the *device*** and can act on it (spawn processes, update, read
   device state). Management is out-of-band (shell), so NAT'd devices are unmanageable.
4. **Core idea.** One privileged, always-on **device agent** per machine — the device's *hands* on the
   bus. Because it connects outbound, it's reachable behind NAT; it spawns / stops / upgrades the
   device's worker agents and reports device state, all driven by **gated** bus commands.

## Mental model: it's a kubelet

| Conclave | Kubernetes |
|---|---|
| hub / server | API server |
| the bus | control plane |
| **device agent (`conclave host`)** | **kubelet** (per-node agent) |
| `conclave work` / `agent` workers | pods |

The device agent schedules/supervises the worker agents on its box. The bus is how you talk to it.

## Security model (the part that must be right — it's RCE by design)

A thing that spawns processes / changes settings on command is remote code execution. Non-negotiables:

1. **Authenticated, gated commander.** A `host` only honors control commands that are (a) **signed**
   (secure mode, ed25519 — already enforced) and (b) **from an allowlisted commander id** passed at
   start: `--commander agent://admin` (repeatable). Default deny. A random connect-token holder
   cannot command it.
2. **These three fixes are prerequisites** (now done): revoke must drop the live socket (`01801d6`),
   key rotation must work (`857eace`), and send must confirm acceptance (`e2d80f1`). Without them a
   leaked/revoked key commanding a device agent is game over.
3. **Structured command vocabulary, never raw shell.** The protocol is a closed set —
   `spawn` / `stop` / `list` / `status` / `upgrade` — each with typed, validated fields. There is **no
   `run "<arbitrary command>"`**. Blast radius is bounded to "manage conclave agents on this box".
4. **What it may spawn is constrained**: only `conclave work|agent` with a brain/role/zone from the
   command — not arbitrary binaries. Spawned children inherit a zone the commander is allowed to grant.
5. **Auditable**: every honored command is logged locally and echoed as a bus event so the dashboard
   shows who told which device to do what.

## Control protocol (request → response over the bus)

Commands are `kind: "request"` envelopes addressed to the device agent, body `{ op, ... }`. The agent
replies `kind: "response"` with the result. v1 ops:

```
{ op: "status" }                       → { device, uptimeMs, agents: [{name, kind, role, pid, upMs, alive, status, resumable}] }
{ op: "list" }                         → { agents: [...] }            // running ∪ offline-but-resumable
{ op: "spawn", name, kind:"agent"|"work",
  brain?, role?, zone?, permission?,
  enroll? }                            → { spawned: name, pid }       // enrolls (if token) + launches; persists the spec
{ op: "spawn", name, rc:true,
  permission?, enroll? }               → { spawned, rc:{ link, workspace, log } }  // human-steered RC task node (see below)
{ op: "resume", name }                 → { resumed: name, pid }       // relaunch an offline-but-known worker (no re-enroll)
{ op: "resume" }  // or name:"all"/"*" → { resumed: [...], skipped }  // bring back everything after a device reboot
{ op: "stop", name }                   → { stopped: name }            // deprovision: forgets the spec → NOT resumable
{ op: "upgrade" }                      → { from, to }                 // (planned) git pull + restart this device's agents
```

Rejected (with a reason) if the sender isn't an allowlisted commander, the op is unknown, or a field
fails validation.

## Resume / restart survival (implemented)

Every `spawn` persists its launch spec to `<dataRoot>/_specs.json`; each worker's identity + message
cursor already persist under `<dataRoot>/<name>`. So when a worker goes **offline on its own** (Claude
Code update, crash) or the **whole device reboots**, the manager node calls `resume <name>` (or
`resume all` after a reboot) and the worker **relaunches from its spec against the same data dir** —
it reconnects as the **same `agent://<name>`** and replays from its cursor. Resume needs **no enroll
token** (the identity is already on disk). `list`/`status` report offline-but-known workers as
`status: "offline", resumable: true` so the manager can see what's recoverable. An explicit `stop` is
a **deprovision** — it forgets the spec, so a stopped worker is not resurrected; only offline ones are.

## RC task nodes — `spawn … rc:true` (human-steered, on the bus)

A `--brain claude` worker is autonomous but **can't be remote-controlled** (`claude -p` print mode).
When you interact with a task mainly by **steering it from your phone/web**, spawn it with `rc:true`
instead. The host then, for that task:

1. prepares a Claude Code **workspace** under `<dataRoot>/<name>/workspace`,
2. **pre-trusts** it and wires the **conclave MCP** into it (in `~/.claude.json`) as `agent://<name>` —
   so the steered session is **on the bus** and can DM resource nodes / other task sessions,
3. launches `claude remote-control --name <name> --permission-mode <perm>` in it,
4. captures the `https://claude.ai/code?environment=…` link and returns it in the response —

so the commander (your manager node) hands you a link to steer the new task immediately. `resume` of
an rc node relaunches remote-control and returns a fresh link. This is the device-managed flavor of
docs/remote-control-node.md; prerequisite is the same — `claude` installed + logged in with a
**subscription** (not an API key) on the device. The host injects the claude binary via `--claude-bin`
(default `claude`) and config path via `--claude-config` (default `~/.claude.json`).

## Supervision

Spawned agents become supervised units (reuse `deploy/join.sh`'s systemd `--user` path; `nohup`
fallback elsewhere) so they survive reboots and the device agent restarting. The device agent itself is
supervised the same way and self-updates (the built-in `work`/`agent` self-update applies).

## v1 scope

Ship `status` + `list` + `spawn` + `stop`, gated to `--commander`, structured-only, with an e2e test
that a non-commander is refused and a commander can spawn+list+stop a worker. `upgrade` and richer
device settings come next. Start command:

```
conclave host --as <device> --commander agent://admin --url ws://HOST:8787 --token <connect>
```
