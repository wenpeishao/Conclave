import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const pexec = promisify(execFile);

/**
 * Packaging, not logic. The `conclave` bin (src/cli.ts) and any shebang entry must be committed
 * EXECUTABLE (100755) in the git tree — otherwise every fresh clone on Unix gets a non-executable
 * entry point, so `conclave` (and the MCP server it spawns) won't run at all. The whole e2e suite
 * spawns `node src/cli.ts` directly, which bypasses this exact failure, so it needs its own guard.
 * This asserts the TREE mode (git ls-files -s), which a local `chmod` can't fake away.
 */
test("packaging: every committed shebang file is executable (100755) in the git tree", async () => {
  const ls = (await pexec("git", ["ls-files", "-s", "--", "*.ts", "*.sh", "*.js", "*.mjs", "*.cjs"])).stdout;
  const bad: string[] = [];
  for (const line of ls.split("\n")) {
    const m = /^(\d{6}) [0-9a-f]+ \d+\t(.+)$/.exec(line);
    if (!m) continue;
    const [, mode, file] = m;
    let head = "";
    try {
      head = readFileSync(file, "utf8").slice(0, 2);
    } catch {
      continue;
    }
    if (head === "#!" && mode !== "100755") bad.push(`${file} (${mode})`);
  }
  assert.deepEqual(
    bad,
    [],
    `shebang entry file(s) committed non-executable — a fresh clone's command won't run.\nfix: git update-index --chmod=+x <file>\noffenders:\n  ${bad.join("\n  ")}`,
  );
});
