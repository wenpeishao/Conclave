import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentCard } from "../src/core/types.js";

export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tmpDir(prefix = "conclave-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function card(name: string): AgentCard {
  return { id: `agent://${name}`, name, realtime: "poll" };
}

/** Poll a (possibly async) predicate until true or timeout — avoids brittle fixed sleeps. */
export async function until(pred: () => boolean | Promise<boolean>, timeoutMs = 4000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await wait(stepMs);
  }
}
