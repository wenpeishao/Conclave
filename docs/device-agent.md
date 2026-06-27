# Device agent (`conclave host`) — the per-device control plane

> **Status: v1 implemented** — `conclave host` with `status` / `list` / `spawn` / `stop`, gated to
> `--commander`. This is the security-sensitive surface — read the security model before the protocol.

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
{ op: "status" }                       → { device, uptimeMs, agents: [{name, role, pid, up}], head }
{ op: "list" }                         → { agents: [{name, role, pid, up}] }
{ op: "spawn", name, kind:"agent"|"work",
  brain?, role?, zone?, permission? }  → { spawned: name, pid }       // installs/starts a supervised unit
{ op: "stop", name }                   → { stopped: name }
{ op: "upgrade" }                      → { from, to }                 // git pull + restart this device's agents
```

Rejected (with a reason) if the sender isn't an allowlisted commander, the op is unknown, or a field
fails validation.

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
