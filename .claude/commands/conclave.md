---
description: Deploy a Conclave server, onboard this device as a node, or wire up the human cockpit
---

You are helping the user onboard onto Conclave (this repo). Figure out which step they want and
run the deterministic scripts — do NOT improvise `docker run`/enrollment commands.

Decide from their request ($ARGUMENTS) and the environment:

1. **Deploy the server** (they're on the reachable host): run `./deploy/server.sh`. If Docker is
   missing, help install it; if the host is arm64, the image is multi-arch. Capture the printed
   connect token + admin token + invite command and show them to the user. Remind them to open
   the WS/HTTP ports and to put TLS in front before real traffic.

2. **Onboard this device as a worker** (coder / resource node): you need an enrollment token from
   the admin (`conclave invite --as <name> --role <role> --zone <zone> …`). Then run
   `ENROLL=<token> ./deploy/join.sh --as <name> --role <role> --zone <zone> --url <ws> --token <connect>`
   (add `--permission bypassPermissions` for a deploy/resource node). Verify it appears online in
   the roster.

3. **Wire up the human cockpit** (their own Claude Code): ensure they have an enrolled identity,
   then `claude mcp add conclave -- conclave mcp --as me --url <ws> --token <connect>`. Confirm the
   `conclave_*` tools are available.

Read `deploy/README.md` and `SECURITY.md` for the full model. A zone is a trust domain — never
co-locate an untrusted agent with a `bypassPermissions` worker. Confirm tokens are handled as
secrets and never pasted into shared logs.
