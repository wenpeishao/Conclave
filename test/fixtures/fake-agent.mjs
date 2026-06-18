// A minimal stand-in for a "coding agent" CLI (like `codex exec`), used to test the
// CLI-shim brain without installing Codex or calling any API. It reads a prompt (from the
// last argv element, or from stdin if none), answers an arithmetic question if it finds
// one, and prints the answer to stdout wrapped in ANSI color (to exercise stripAnsi).

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

let prompt = process.argv[2] ?? "";
if (!prompt) prompt = await readStdin();

const m = prompt.match(/(\d+)\s*\+\s*(\d+)/);
const answer = m ? String(Number(m[1]) + Number(m[2])) : "I could not parse a question";

// Wrap in green ANSI (ESC = char 27); the shim's default parser should strip it.
const ESC = String.fromCharCode(27);
process.stdout.write(ESC + "[32m" + answer + ESC + "[0m\n");
