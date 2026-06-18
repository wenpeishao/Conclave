import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitBusTransport } from "../src/transports/git-bus.js";
import { NodeHost } from "../src/node/host.js";
import { tmpDir, card, until } from "./helpers.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return exec("git", args, { cwd });
}

async function setupClone(remoteBare: string, name: string): Promise<string> {
  const dir = await tmpDir(`conclave-${name}-`);
  await git(path.dirname(dir), ["clone", "--quiet", remoteBare, dir]);
  await git(dir, ["config", "user.email", `${name}@conclave.test`]);
  await git(dir, ["config", "user.name", name]);
  return dir;
}

test("git-bus: A→B over a shared bare repo, with pull-based replay", async () => {
  const root = await tmpDir("conclave-gitremote-");
  const bare = path.join(root, "bus.git");
  await fs.mkdir(bare, { recursive: true });
  await git(root, ["init", "--bare", "-b", "main", bare]);

  // Seed the bare repo with an initial commit on main so clones have a branch.
  const seed = await setupClone(bare, "seed");
  await fs.writeFile(path.join(seed, "README"), "conclave bus\n");
  await git(seed, ["add", "-A"]);
  await git(seed, ["commit", "-q", "-m", "init"]);
  await git(seed, ["push", "-q", "origin", "main"]);

  const repoA = await setupClone(bare, "A");
  const repoB = await setupClone(bare, "B");

  const A = new NodeHost({
    card: card("A"),
    transport: new GitBusTransport({ repoDir: repoA, agentDir: "A", remote: true, pollMs: 300 }),
    dataDir: root,
    heartbeatMs: 60000,
  });
  const B = new NodeHost({
    card: card("B"),
    transport: new GitBusTransport({ repoDir: repoB, agentDir: "B", remote: true, pollMs: 300 }),
    dataDir: root,
    heartbeatMs: 60000,
  });
  const got: string[] = [];
  B.onMessage((e) => {
    got.push(String(e.body));
  });
  await A.start();
  await B.start();

  await A.send([B.card.id], { subject: "via git", body: "commit-as-message" });
  await until(() => got.includes("commit-as-message"), 15000);
  assert.ok(got.includes("commit-as-message"), "message delivered through git commits");

  // The message is a real, auditable commit + file in A's exclusive subdir.
  const files = await fs.readdir(path.join(repoA, "bus", "A"));
  assert.ok(files.some((f) => f.endsWith(".json")), "envelope persisted as a file");

  await A.stop();
  await B.stop();
});
