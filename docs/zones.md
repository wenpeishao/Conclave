# Zones — what they isolate, and what they deliberately don't

> A **zone** is a named **trust domain** on the bus. It scopes **broadcast work traffic** — group
> topics and the task board — so separate sessions/projects can share one resource pool without
> leaking work into each other. It is **not** a hard network partition: directed 1:1 messages and
> the discovery plane cross zone boundaries on purpose.

## The four questions

1. **What problem?** Many sessions/projects share one bus and one pool of resource nodes. You want
   project A's tasks and group chatter invisible to project B — but you still want every node to be
   *findable*, and you (or an admin/orchestrator) still want to DM any node directly.
2. **Why it matters.** Without scoping, every broadcast and every task lands on every node — work
   leaks across projects, and the task board becomes a free-for-all. Full isolation (partition the
   network) would be the opposite failure: you could no longer discover or directly address a node
   in another zone.
3. **Where prior work falls short.** A single flat bus has no isolation; a hard VLAN/namespace split
   has no shared discovery or cross-cut addressing. Zones sit in between.
4. **Core idea.** Isolate the **broadcast work plane** (topics + task board) by zone membership,
   but keep **discovery global** and **directed P2P zone-crossing**. Membership is set at enrollment
   and enforced server-side on every envelope (`authorizePolicy` + `routeOk`), deny-by-default.

## The three routing planes

Every envelope travels one of three planes. Zones gate exactly one of them.

| Plane | Envelope shape | Crosses zones? | Rule |
|---|---|---|---|
| **Discovery** | `to: "*"`, `topic://presence`, `topic://discovery`, presence | **Yes — global** | Who's online + capabilities is visible to everyone; no zone required (and a zoned node can't advertise a zone it doesn't hold). |
| **Directed P2P** | `to: ["agent://X"]` | **Yes — intentionally** | A message addressed to a specific node id is delivered regardless of either party's zone. You can always DM a node by id; an admin/orchestrator uses this to steer any node. |
| **Topic work broadcast + task board** | `to: ["topic://<work>"]`, task `claim`/`done` events | **No — isolated** | This is the only plane zones gate. A **zoned** sender **must stamp one of its member zones** (`env.zone`) on work-topic traffic — deny-by-default — and the envelope reaches **only same-zone members**. |

So the honest one-liner:

> **Zones isolate group broadcasts and the task board. They do *not* isolate direct messages or
> online-discovery.** Same-zone nodes collaborate as a group; different-zone nodes still see each
> other online and can still be DM'd point-to-point.

## Enforcement (where it actually happens)

Two server-side checks, both deny-by-default, both in the secure-mode hub:

- **`authorizePolicy`** (send side, `src/server/conclave-server.ts`):
  - A sender may only stamp a zone it is a **member** of (`not a member of <zone>` otherwise).
  - A **zoned** agent sending any **work topic** with **no** `env.zone` is rejected
    (`zoned agent must stamp a member zone on work-topic traffic`) — it can't escape isolation by
    omitting the zone.
  - Presence/discovery and directed traffic are exempt from the zone-stamp requirement.
- **`routeOk`** (delivery side, `src/relay/server.ts`): deny-by-default. Delivers an envelope to a
  connection only if it's `to: "*"`, a pure discovery envelope, directed to that node's id, or a
  topic whose `env.zone` the node is a member of. An un-zoned (`env.zone == null`) topic reaches
  everyone subscribed — but only a **zone-less** sender can emit one (a zoned sender is forced to
  stamp its zone by the rule above).

Two things bridge zones by design:

- **The hub / control plane** (`env.from === hub`, the admin identity / wildcard binding) sees
  everything and can inject into any zone. This is what `/admin/*` and cross-zone observability use.
- **Zone-less nodes** ride the global plane: they can broadcast un-zoned topics and be reached by
  anyone. Leave a node un-zoned to make it a shared, cross-cutting resource (e.g. a DNS node any
  project can DM).

## Membership

- Assigned at **enrollment**: `conclave invite --as <name> --zone <z>` (repeatable for multiple
  zones). The first `invite --zone <z>` **creates** the zone — there is no separate "create zone"
  step. Membership lives in the registry record and is authoritative; a node cannot self-assign.
- **Redacted for non-admins**: the cross-zone roster returns zone memberships only to an admin
  token — enumerating who's in which zone is presence reconnaissance.
- A node with **no zones** is on the global plane (see bridging above), not "in every zone".

## When to use a zone vs. leave it off

- **Own zone** — a session/project whose task board and group broadcasts must not mix with others'.
  `--zone s-projectA`.
- **No zone** — a shared cross-cutting resource that any project may discover and DM directly
  (a DNS keeper, a deploy node, your own steering session). It can't *broadcast into* a private
  zone's topics, but it can be DM'd and can answer.

## If you need hard isolation (currently not supported)

Zones deliberately let directed P2P cross. If you want a zone where even `agent://X` DMs are blocked
across the boundary, that's a change to `routeOk`'s directed branch (add a same-zone check on
`env.to.includes(b.id)`) — it would break the current "admin/orchestrator can DM any node" property,
so it's a conscious trade-off, not the default.
