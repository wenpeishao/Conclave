/**
 * music-agent — a tool-using agent that finds and downloads a PUBLIC-DOMAIN song from the
 * Internet Archive, driven by a local open model (via Ollama's function-calling API).
 *
 * This is the tool-call loop Conclave's Brain layer was missing: the model decides; the
 * harness executes (search / list / download). The source is archive.org (legal), and the
 * agent is instructed to only download pre-1925 US recordings or public-domain-licensed
 * items.
 *
 *   MODEL=qwen3-coder:30b npx tsx examples/music-agent/agent.ts
 *   MODEL=hf.co/mradermacher/VibeThinker-3B-GGUF:Q4_K_M npx tsx examples/music-agent/agent.ts
 *
 * Ollama is reached at OLLAMA (default localhost:11434, e.g. an SSH tunnel to a GPU box).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

const OLLAMA = process.env.OLLAMA ?? "http://127.0.0.1:11434";
const MODEL = process.env.MODEL ?? "qwen3-coder:30b";
const OUT_DIR = path.join(import.meta.dirname, "downloads");
const TASK =
  "Find and download ONE public-domain recording of 'Maple Leaf Rag' from the Internet Archive. " +
  "Only download a recording published before 1925 (US public domain) or one whose license is public domain. " +
  "Workflow: call ia_search to find candidates, then ia_files on a promising pre-1925 identifier to confirm it " +
  "has an mp3 and check its year, then call download with that mp3's url. Download exactly one file, then stop.";

// ---- tools (the harness executes these; the model just calls them) ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "ia_search",
      description: "Search the Internet Archive for audio recordings. Returns up to 6 {identifier,title,year}.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "search terms, e.g. 'maple leaf rag'" },
          year_max: { type: "integer", description: "only return items at or before this year (use 1924 for US public domain)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ia_files",
      description: "Get an Internet Archive item's year, license, and downloadable mp3 files (name, size, url).",
      parameters: {
        type: "object",
        properties: { identifier: { type: "string", description: "the IA item identifier from ia_search" } },
        required: ["identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "download",
      description: "Download a file from a url to local disk. Use only for verified public-domain audio.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "the mp3 url from ia_files" },
          filename: { type: "string", description: "filename to save as, e.g. maple_leaf_rag_1907.mp3" },
        },
        required: ["url", "filename"],
      },
    },
  },
];

async function iaSearch(args: { query: string; year_max?: number }): Promise<unknown> {
  const yr = args.year_max ?? 1924;
  const q = `${args.query} AND mediatype:audio AND year:[1850 TO ${yr}]`;
  const url =
    `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}` +
    `&fl[]=identifier&fl[]=title&fl[]=year&fl[]=licenseurl&rows=6&output=json`;
  const r = await fetch(url);
  const d = (await r.json()) as { response: { docs: { identifier: string; title?: string; year?: number; licenseurl?: string }[] } };
  return d.response.docs.map((x) => ({ identifier: x.identifier, title: x.title, year: x.year, licenseurl: x.licenseurl ?? null }));
}

async function iaFiles(args: { identifier: string }): Promise<unknown> {
  const r = await fetch(`https://archive.org/metadata/${encodeURIComponent(args.identifier)}`);
  const d = (await r.json()) as { metadata?: Record<string, unknown>; files?: { name: string; format?: string; size?: string }[] };
  const md = d.metadata ?? {};
  const mp3s = (d.files ?? [])
    .filter((f) => f.name.toLowerCase().endsWith(".mp3"))
    .map((f) => ({
      name: f.name,
      size: f.size,
      url: `https://archive.org/download/${args.identifier}/${encodeURIComponent(f.name)}`,
    }));
  return { identifier: args.identifier, year: md.year ?? md.date ?? null, licenseurl: md.licenseurl ?? null, mp3_files: mp3s };
}

async function download(args: { url: string; filename: string }): Promise<unknown> {
  // Safety net: only allow archive.org downloads in this demo.
  if (!/^https:\/\/archive\.org\/download\//.test(args.url)) {
    return { ok: false, error: "refused: only archive.org/download urls are allowed" };
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  const safe = path.basename(args.filename).replace(/[^a-zA-Z0-9._-]/g, "_") || "track.mp3";
  const dest = path.join(OUT_DIR, safe);
  const r = await fetch(args.url);
  if (!r.ok) return { ok: false, error: `http ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(dest, buf);
  return { ok: true, path: dest, bytes: buf.length };
}

const EXEC: Record<string, (a: any) => Promise<unknown>> = { ia_search: iaSearch, ia_files: iaFiles, download };

// ---- the agent loop (Ollama function-calling) -------------------------------
interface ChatMsg {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

async function chat(messages: ChatMsg[]): Promise<ChatMsg> {
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false, options: { temperature: 0.1, num_ctx: 8192 } }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = (await r.json()) as { message: ChatMsg };
  return d.message;
}

async function main() {
  console.log(`\n=== music-agent · model=${MODEL} ===`);
  const messages: ChatMsg[] = [
    { role: "system", content: "You are an autonomous agent that uses tools. Call tools to accomplish the task. When done, reply with a short confirmation." },
    { role: "user", content: TASK },
  ];

  let downloaded: { path: string; bytes: number } | null = null;
  for (let round = 1; round <= 8; round++) {
    let msg: ChatMsg;
    try {
      msg = await chat(messages);
    } catch (e) {
      console.error("  chat error:", (e as Error).message);
      break;
    }
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      console.log(`  [round ${round}] model: ${(msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim().slice(0, 200)}`);
      break; // model is done (no tool call)
    }
    for (const c of calls) {
      const name = c.function.name;
      const a = c.function.arguments ?? {};
      console.log(`  [round ${round}] → ${name}(${JSON.stringify(a).slice(0, 120)})`);
      let result: unknown;
      try {
        result = EXEC[name] ? await EXEC[name](a) : { error: `unknown tool ${name}` };
      } catch (e) {
        result = { error: (e as Error).message };
      }
      if (name === "download" && (result as any)?.ok) downloaded = result as any;
      const summary = JSON.stringify(result);
      console.log(`             ← ${summary.slice(0, 160)}`);
      messages.push({ role: "tool", tool_name: name, content: summary });
    }
    if (downloaded) break;
  }

  if (downloaded) {
    console.log(`\n✅ DOWNLOADED: ${downloaded.path} (${downloaded.bytes} bytes)`);
  } else {
    console.log(`\n❌ no file downloaded (the model didn't complete the tool chain)`);
  }
  return downloaded;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
