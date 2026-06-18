import * as http from "node:http";
import type { NodeHost } from "../node/host.js";
import type { Envelope } from "../core/types.js";
import { renderBody } from "./runtime.js";

/**
 * HumanServer — puts a *person* on the bus as an agent. It wraps a NodeHost and serves a
 * tiny web UI (inbox + roster + a send form). The human reads what other agents send and
 * replies by hand. Subscribe the host to topic://human and loop-guard escalations land
 * here too, so a person is the natural escape hatch when agents get stuck.
 *
 * The HTML is a thin client over three JSON endpoints, which is what the tests exercise:
 *   GET  /                 → the single-page UI
 *   GET  /api/messages?since=N → { roster, messages, cursor }
 *   POST /api/send         → { to, body, subject?, kind? } → host.send
 */
interface InboxItem {
  id: string;
  from: string;
  subject?: string;
  body: string;
  kind: string;
  ts: string;
}

export interface HumanServerOpts {
  host: NodeHost;
  port: number; // 0 = pick a free port
}

export class HumanServer {
  private host: NodeHost;
  private wantPort: number;
  private server: http.Server | null = null;
  private inbox: InboxItem[] = [];

  constructor(o: HumanServerOpts) {
    this.host = o.host;
    this.wantPort = o.port;
    this.host.onMessage((e) => {
      this.inbox.push(this.view(e));
    });
  }

  port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === "object" ? addr.port : this.wantPort;
  }

  async start(): Promise<void> {
    await this.host.start();
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.wantPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.host.stop();
  }

  private view(e: Envelope): InboxItem {
    return { id: e.id, from: e.from, subject: e.subject, body: renderBody(e.body), kind: e.kind, ts: e.ts };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(this.host.card.id));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const since = Number(url.searchParams.get("since") ?? "0") || 0;
      const messages = this.inbox.slice(since);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ self: this.host.card.id, roster: this.host.getRoster(), messages, cursor: this.inbox.length }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void (async () => {
          try {
            const { to, body: text, subject, kind } = JSON.parse(body || "{}");
            if (!to) {
              res.writeHead(400).end(JSON.stringify({ error: "missing 'to'" }));
              return;
            }
            const recipients = to === "*" ? ("*" as const) : [String(to).startsWith("agent://") ? to : `agent://${to}`];
            const sent = await this.host.send(recipients, { body: text ?? "", subject, kind: kind ?? "message" });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, id: sent.id }));
          } catch (err) {
            res.writeHead(500).end(JSON.stringify({ error: (err as Error).message }));
          }
        })();
      });
      return;
    }
    res.writeHead(404).end();
  }
}

const PAGE = (self: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>Conclave — ${self}</title>
<style>
  body{font:14px system-ui,sans-serif;margin:0;display:flex;height:100vh}
  #main{flex:1;display:flex;flex-direction:column}
  #log{flex:1;overflow:auto;padding:12px}
  .msg{margin:6px 0;padding:8px;border-left:3px solid #888;background:#f6f6f6}
  .from{font-weight:600;color:#246}
  #side{width:220px;border-left:1px solid #ddd;padding:12px;overflow:auto}
  form{display:flex;gap:6px;padding:10px;border-top:1px solid #ddd}
  input,button{font:inherit;padding:6px}
  #body{flex:1}
</style></head><body>
<div id="main">
  <div id="log"></div>
  <form id="f">
    <input id="to" placeholder="@agent or *" size="14">
    <input id="body" placeholder="message…" autocomplete="off">
    <button>Send</button>
  </form>
</div>
<div id="side"><b>self</b><div>${self}</div><hr><b>roster</b><div id="roster"></div></div>
<script>
let cursor=0;
async function poll(){
  const r=await fetch('/api/messages?since='+cursor); const d=await r.json();
  cursor=d.cursor;
  const log=document.getElementById('log');
  for(const m of d.messages){
    const el=document.createElement('div'); el.className='msg';
    el.innerHTML='<span class="from">'+m.from+'</span>'+(m.subject?' ['+m.subject+']':'')+' <i>('+m.kind+')</i><br>'+escapeHtml(m.body);
    log.appendChild(el);
  }
  if(d.messages.length) log.scrollTop=log.scrollHeight;
  document.getElementById('roster').innerHTML=d.roster.map(a=>(a.online?'● ':'○ ')+a.id).join('<br>');
}
function escapeHtml(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
document.getElementById('f').onsubmit=async e=>{
  e.preventDefault();
  const to=document.getElementById('to').value.trim(), body=document.getElementById('body').value;
  if(!to)return;
  await fetch('/api/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({to,body})});
  document.getElementById('body').value='';
};
setInterval(poll,1500); poll();
</script></body></html>`;
