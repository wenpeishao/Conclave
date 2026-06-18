"""
Conclave Python SDK — git-bus transport, standard library only.

This is the deliberately-zero-dependency client for "always-on" agents (ML loops,
schedulers) and for locked-down HPC login nodes where you have `git` and outbound
network but no Docker, no inbound ports, and no freedom to pip-install much. It speaks
the same wire protocol and writes to the same bus repo as the TypeScript node hosts, so
a Python agent on a GPU box and a Claude Code agent on a laptop are peers.

Design mirrors src/transports/git-bus.ts:
  - each agent writes ONLY bus/<agent_dir>/<ulid>.json  -> no merge conflicts
  - ULIDs sort chronologically -> the cursor is just "highest id seen"
  - poll = git pull --rebase + scan for ids > cursor

Example:
    c = Conclave(repo_dir="~/bus", agent_id="agent://gpubox", agent_dir="gpubox")
    c.send(to=["agent://laptop"], subject="run done", body="acc=0.83, ckpt at /staging/...")
    for env in c.poll():            # call on your own cadence
        print(env["from"], env["body"])
"""
from __future__ import annotations

import json
import os
import secrets
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _ulid(ts_ms: Optional[int] = None) -> str:
    """26-char Crockford-base32 ULID; lexicographically time-sortable."""
    if ts_ms is None:
        ts_ms = int(time.time() * 1000)
    t = ts_ms
    time_chars = [""] * 10
    for i in range(9, -1, -1):
        time_chars[i] = _CROCKFORD[t % 32]
        t //= 32
    rand = "".join(_CROCKFORD[secrets.randbelow(32)] for _ in range(16))
    return "".join(time_chars) + rand


class Conclave:
    def __init__(
        self,
        repo_dir: str,
        agent_id: str,
        agent_dir: Optional[str] = None,
        remote: bool = True,
        branch: str = "main",
    ) -> None:
        self.repo = Path(os.path.expanduser(repo_dir))
        self.agent_id = agent_id
        self.agent_dir = "".join(
            ch if ch.isalnum() or ch in "_.-" else "_" for ch in (agent_dir or agent_id)
        )
        self.remote = remote
        self.branch = branch
        self.cursor: Optional[str] = None
        self._seq = 0
        (self.repo / "bus" / self.agent_dir).mkdir(parents=True, exist_ok=True)

    # ---- git plumbing -----------------------------------------------------
    def _git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=self.repo,
            check=check,
            capture_output=True,
            text=True,
        )

    def _push_with_retry(self, attempts: int = 6) -> None:
        for i in range(attempts):
            try:
                self._git("pull", "--rebase", "--quiet", check=False)
            except Exception:
                pass
            r = self._git("push", "--quiet", check=False)
            if r.returncode == 0:
                return
            time.sleep(0.1 * (i + 1))
        raise RuntimeError("git push failed after retries")

    # ---- public API -------------------------------------------------------
    def send(
        self,
        to: list[str] | str,
        body: Any = "",
        subject: Optional[str] = None,
        kind: str = "message",
        corr: Optional[str] = None,
        artifacts: Optional[list[dict]] = None,
    ) -> dict:
        self._seq += 1
        env: dict[str, Any] = {
            "v": "1",
            "id": _ulid(),
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "from": self.agent_id,
            "to": to,
            "seq": self._seq,
            "kind": kind,
        }
        if subject:
            env["subject"] = subject
        if body != "":
            env["body"] = body
        if corr:
            env["corr"] = corr
        if artifacts:
            env["artifacts"] = artifacts

        path = self.repo / "bus" / self.agent_dir / f"{env['id']}.json"
        path.write_text(json.dumps(env, indent=2))
        self._git("add", "--", str(path.relative_to(self.repo)))
        self._git("commit", "-q", "-m", f"{kind} {env['id']}")
        if self.remote:
            self._push_with_retry()
        return env

    def poll(self) -> list[dict]:
        """Pull, then return every envelope newer than the cursor (advancing it)."""
        if self.remote:
            self._git("pull", "--rebase", "--quiet", check=False)
        bus = self.repo / "bus"
        found: list[tuple[str, dict]] = []
        if bus.is_dir():
            for sub in bus.iterdir():
                if not sub.is_dir():
                    continue
                for f in sub.glob("*.json"):
                    mid = f.stem
                    if self.cursor and mid <= self.cursor:
                        continue
                    try:
                        found.append((mid, json.loads(f.read_text())))
                    except Exception:
                        continue
        found.sort(key=lambda x: x[0])
        out = []
        for mid, env in found:
            if self.cursor is None or mid > self.cursor:
                self.cursor = mid
            if env.get("from") == self.agent_id:
                continue  # skip our own echo
            out.append(env)
        return out

    def listen(
        self,
        on_message: Callable[[dict], None],
        interval: float = 3.0,
        deliverable_only: bool = True,
    ) -> None:
        """Block forever, invoking on_message for each inbound envelope addressed to us."""
        while True:
            for env in self.poll():
                if deliverable_only and not self._for_me(env):
                    continue
                on_message(env)
            time.sleep(interval)

    def _for_me(self, env: dict) -> bool:
        to = env.get("to")
        if to == "*":
            return True
        if isinstance(to, list):
            return self.agent_id in to
        return False


__all__ = ["Conclave"]
