# Security model

Conclave has two operating modes. Pick deliberately.

- **Legacy / shared-token** (`conclave serve --token <t>`, or no token at all): a single shared
  secret gates who may connect. There is **no per-agent identity** and `from` is not verified.
  Fine for a trusted single-user setup on a private network. **Do not expose it to the public
  internet or to mutually-distrusting users.**
- **Secure mode** (`conclave serve --token <t> --admin-token <a>`): per-agent ed25519 identities,
  signed envelopes, server-side authorization, and zone isolation. This is the mode intended for
  multi-tenant / public deployments.

## Threat model (secure mode)

Assumed attacker: holds the shared connect token, can sniff/replay traffic, may intercept an
enrollment token, and may **run a legitimately-enrolled but malicious agent**. Goals we defend:
an agent must not be able to act as another agent, read another zone's work, forge board
ownership, or take the server down cheaply.

## Mechanisms

| Concern | Mechanism |
|---|---|
| Identity | ed25519 per agent; the **public key is the identity**, `agent://name` is a handle. Every envelope is signed over canonical (sorted-key) bytes — `from` is unforgeable. |
| Onboarding | two-step enrollment (admin `invite` → one-time token → device `enroll`s its own pubkey). Private keys never leave the device. **Proof-of-possession** required; optional **key-pinning** (`invite --pin`, `conclave keygen`) defeats token interception. Revocation burns pending tokens. |
| Connection auth | challenge–response: the relay issues a one-time per-connection nonce; the client returns a nonce-signed hello. A captured hello cannot be replayed. |
| Authorization | the relay's verify hook consumes the signed agent's registry record: role-gated/fail-closed board claim/done, presence bound to `from` and to member zones. |
| **Two-plane isolation** | **Discovery plane is global** — presence (online + capabilities + available/busy) is visible to everyone, so agents can find the resource pool and each other. **Work plane is deny-by-default** — a zoned agent must stamp a member zone on work-topic traffic; the relay routes zone topics to members only, directed messages to the recipient, and discovery globally. HTTP history (`GET /messages`) and blob enumeration (`GET /blobs`) are admin-only. |
| Replay / freshness | `env.id` must be a fresh ULID and `env.ts` within ±10 min; the relay drops already-seen ids (age-rotated). |
| DoS | WS `maxPayload`; HTTP body caps; 2 GiB blob quota; 300 pub/sec per connection (checked before verify); 2000-connection cap; 10s handshake reaper; 256 concurrent relay channels. |

## Explicit trust decisions (by design, not bugs)

- **A zone is a trust domain.** Board task assignment is governed by **zone membership**, not role
  — same-zone agents can hand work to each other (the lab→GPU pipeline depends on cross-role
  handoff). Put only mutually-trusting agents in a zone; a `bypassPermissions` worker runs only
  tasks from its own zone.
- **Discovery is intentionally public** within the tenant set: existence, capabilities, and
  availability are visible across zones. Only the *work* (messages, board, payloads) is private.
- **Blob fetch-by-hash is a capability**: `GET /blobs/<sha>` is open to any connect-token holder,
  but the sha256 is unguessable and history is admin-gated, so hashes can't be harvested cross-zone.
- **Streaming `/relay` channel names are application-chosen** — use unguessable names for a private
  transfer.

## Known limitations (hardening roadmap)

- Zone membership is set at enrollment (no dynamic join yet); a resource agent serving many
  ephemeral sessions uses P2P or is enrolled per-zone.
- TLS is expected to be terminated by a reverse proxy in front of the server (`wss://`/`https://`).
- The relay is a single process (no HA); the durable log is not yet compacted. For a no-server,
  no-single-point deployment, use the GitBus transport.

## Reporting

This is pre-1.0 software that has been through several internal adversarial reviews but no external
audit. Report vulnerabilities via a private GitHub security advisory.
