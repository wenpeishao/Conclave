import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, accessSync, constants } from "node:fs";
import path from "node:path";

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

/**
 * The strongest form: actually RUN the bin as an executable (the OS resolves the shebang), the way
 * `conclave` and the MCP server that spawns it do — not `node src/cli.ts`. Skips on Windows (no
 * shebang execution) and where the working copy isn't executable (core.fileMode quirks); the tree
 * mode is asserted unconditionally above. On Unix this is the only check that would have caught
 * "the installed command doesn't start at all."
 */
test("packaging: the bin runs via its shebang + exec-bit (not just via `node`)", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32") return t.skip("shebang execution is not applicable on Windows");
  const bin = path.resolve("src/cli.ts");
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    return t.skip("working copy not executable here (core.fileMode?) — tree mode is covered above");
  }
  const r = await pexec(bin, ["--help"], { timeout: 50_000 }); // OS execs it → shebang → npx tsx
  assert.match(r.stdout, /conclave|serve|usage/i, `the bin must run as an executable and print help:\n${r.stdout}`);
});
