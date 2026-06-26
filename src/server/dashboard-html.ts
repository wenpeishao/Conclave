// The node-topology dashboard, served at GET /dashboard. Self-contained (no external assets —
// the server may run on an isolated network). Five views over the SAME live snapshot from
// GET /api/nodes (admin-gated): a force-directed graph, a capacity matrix, zone columns, a
// sortable table, and a treemap.
//
// SECURITY: every node-supplied string (agent name, capabilities, zone) reaches the DOM only via
// canvas fillText or textContent — NEVER innerHTML — so a maliciously-named agent (e.g.
// "<img onerror=…>") cannot inject script into this admin-facing page.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Conclave · Node Topology</title>
<style>
  :root { --bg:#0b0e14; --panel:#141a24; --line:#222c3a; --fg:#d7dee8; --muted:#7d8aa0;
          --on:#36d399; --busy:#fbbd23; --off:#566073; --zone:#3b82f6; --bad:#f87272; }
  * { box-sizing: border-box; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg);
              font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  #app { display:flex; flex-direction:column; height:100vh; }
  header { display:flex; align-items:center; gap:14px; padding:10px 16px; border-bottom:1px solid var(--line);
           background:var(--panel); flex-wrap:wrap; }
  header h1 { font-size:14px; font-weight:600; margin:0; letter-spacing:.2px; }
  header .stat { color:var(--muted); }
  header .stat b { color:var(--fg); font-weight:600; }
  header .spacer { flex:1; }
  input#token { background:#0b0e14; border:1px solid var(--line); color:var(--fg); border-radius:6px;
                padding:5px 8px; width:190px; font:inherit; }
  button { background:#1e2733; border:1px solid var(--line); color:var(--fg); border-radius:6px;
           padding:5px 10px; cursor:pointer; font:inherit; }
  button:hover { background:#27323f; }
  #tabs { display:flex; gap:4px; padding:6px 12px; border-bottom:1px solid var(--line); background:#10151d; }
  #tabs button { padding:4px 12px; color:var(--muted); border-color:transparent; background:transparent; }
  #tabs button.active { color:var(--fg); background:#1e2733; border-color:var(--line); }
  #wrap { position:relative; flex:1; overflow:hidden; }
  canvas#cv { display:block; width:100%; height:100%; cursor:grab; }
  canvas#cv.drag { cursor:grabbing; }
  .view { display:none; position:absolute; inset:0; overflow:auto; padding:16px; }
  .view.active { display:block; }
  canvas#cv { display:none; }
  canvas#cv.active { display:block; }
  /* shared bits */
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; flex:0 0 auto; }
  .cap { background:#1e2733; border-radius:4px; padding:1px 6px; color:#aab6c8; font-size:11px; white-space:nowrap; }
  #legend { position:absolute; left:12px; bottom:12px; background:rgba(20,26,36,.85); border:1px solid var(--line);
            border-radius:8px; padding:8px 10px; display:flex; gap:14px; flex-wrap:wrap; backdrop-filter:blur(4px); }
  #legend span { display:flex; align-items:center; gap:6px; color:var(--muted); }
  #tip { position:absolute; pointer-events:none; background:#0b0e14; border:1px solid var(--line); border-radius:8px;
         padding:8px 10px; min-width:160px; max-width:280px; box-shadow:0 6px 24px rgba(0,0,0,.45);
         opacity:0; transition:opacity .08s; z-index:6; }
  #tip .nm { font-weight:600; margin-bottom:4px; }
  #tip .row { color:var(--muted); display:flex; justify-content:space-between; gap:10px; }
  #tip .row b { color:var(--fg); font-weight:500; }
  #tip .caps, .caps { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
  #msg { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center; color:var(--muted); z-index:7; }
  #msg b { color:var(--bad); }
  .hint { color:var(--muted); font-size:12px; }
  .vh { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  /* capacity matrix + table */
  table.grid { border-collapse:collapse; width:100%; max-width:960px; }
  table.grid th, table.grid td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  table.grid th { color:var(--muted); font-weight:600; cursor:default; position:sticky; top:-16px; background:var(--bg); }
  table.grid.sortable th { cursor:pointer; user-select:none; }
  table.grid tr.tot td { font-weight:600; border-top:2px solid var(--line); }
  td .free { color:var(--on); font-weight:600; }
  .nm { display:flex; align-items:center; gap:7px; }
  .badge { font-size:11px; color:var(--muted); border:1px solid var(--line); border-radius:4px; padding:0 5px; }
  .badge.busy { color:#0b0e14; background:var(--busy); border-color:var(--busy); }
  .badge.off { color:var(--off); } .badge.bad { color:var(--bad); border-color:var(--bad); }
  /* columns */
  .cols { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; }
  .col { background:var(--panel); border:1px solid var(--line); border-radius:10px; width:240px; overflow:hidden; }
  .col h3 { margin:0; padding:9px 12px; font-size:13px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; }
  .col h3 small { color:var(--muted); font-weight:500; }
  .card { padding:9px 12px; border-bottom:1px solid #1b2330; }
  .card:last-child { border-bottom:none; }
  .card .sub { color:var(--muted); font-size:12px; margin-top:3px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  /* treemap */
  #tmInner { display:flex; gap:6px; height:calc(100% - 0px); min-height:380px; align-items:stretch; }
  .tmZone { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:8px; overflow:hidden; min-width:90px; }
  .tmZone .zh { padding:5px 8px; font-size:12px; font-weight:600; background:#10151d; border-bottom:1px solid var(--line); }
  .tmTiles { display:flex; flex-direction:column; flex:1; }
  .tmTile { flex:1 1 0; display:flex; align-items:center; justify-content:center; text-align:center; font-size:11px;
            border-top:1px solid rgba(0,0,0,.25); padding:2px; overflow:hidden; color:#0b0e14; }
  .controls { display:flex; gap:10px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  .controls input[type=text] { background:#0b0e14; border:1px solid var(--line); color:var(--fg); border-radius:6px; padding:5px 8px; width:200px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>◆ Conclave</h1>
    <span class="stat"><b id="s-nodes">0</b> nodes</span>
    <span class="stat"><b id="s-online">0</b> online</span>
    <span class="stat"><b id="s-free">0</b> free</span>
    <span class="stat"><b id="s-zones">0</b> zones</span>
    <span class="hint" id="s-updated"></span>
    <span class="spacer"></span>
    <input id="token" type="password" placeholder="admin token" autocomplete="off" aria-label="admin token" />
    <button id="save">Connect</button>
    <button id="reheat" title="re-run graph layout">Relayout</button>
  </header>
  <nav id="tabs" aria-label="views"></nav>
  <div id="wrap">
    <canvas id="cv" class="active" role="img" aria-label="Node topology graph"></canvas>
    <div class="view" id="v-capacity"></div>
    <div class="view" id="v-columns"></div>
    <div class="view" id="v-table"></div>
    <div class="view" id="v-treemap"></div>
    <ul id="a11y" class="vh" aria-live="polite" aria-label="Nodes by zone"></ul>
    <div id="legend">
      <span><i class="dot" style="background:var(--on)"></i>online</span>
      <span><i class="dot" style="background:var(--busy)"></i>busy</span>
      <span><i class="dot" style="background:var(--off)"></i>offline</span>
      <span><i class="dot" style="background:var(--bad)"></i>revoked</span>
      <span><i class="dot" style="background:var(--zone)"></i>zone</span>
      <span class="hint">drag · scroll to zoom · hover for detail</span>
    </div>
    <div id="tip" role="tooltip"></div>
    <div id="msg" style="display:none"></div>
  </div>
</div>
<script>
(function(){
  "use strict";
  var cv = document.getElementById("cv"), ctx = cv.getContext("2d");
  var tip = document.getElementById("tip"), msgEl = document.getElementById("msg"), a11y = document.getElementById("a11y");
  var legend = document.getElementById("legend"), tokenIn = document.getElementById("token");
  var data = null, activeTab = "graph";
  var nodes = [], links = [], byId = {}, view = { x:0, y:0, k:1 }, dragging = null, panning = null, hot = null;
  var alpha = 1, rafQueued = false, selfId = null, prevKey = "", poll = null, authFailed = false;
  var sortKey = "zone", sortDir = 1, filterText = "", onlineOnly = false; // table state (persists across refresh)

  var TABS = [["graph","Graph"],["capacity","Capacity"],["columns","Columns"],["table","Table"],["treemap","Treemap"]];
  var VIEW = { capacity:document.getElementById("v-capacity"), columns:document.getElementById("v-columns"),
               table:document.getElementById("v-table"), treemap:document.getElementById("v-treemap") };
  (function buildTabs(){
    var nav=document.getElementById("tabs");
    TABS.forEach(function(t){ var b=document.createElement("button"); b.textContent=t[1]; if (t[0]===activeTab) b.className="active";
      b.onclick=function(){ setTab(t[0]); }; b.dataset.tab=t[0]; nav.appendChild(b); });
  })();
  function setTab(t){
    activeTab=t;
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function(b){ b.className = b.dataset.tab===t?"active":""; });
    cv.classList.toggle("active", t==="graph");
    for (var k in VIEW) VIEW[k].classList.toggle("active", k===t);
    legend.style.display = t==="graph" ? "flex" : "none";
    hideTip();
    if (t==="graph"){ size(); if (data) ingest(data); kick(); } else render();
  }

  try { tokenIn.value = sessionStorage.getItem("conclave.adminToken") || ""; } catch(e){}
  document.getElementById("save").onclick = function(){ try { sessionStorage.setItem("conclave.adminToken", tokenIn.value); } catch(e){} authFailed=false; fetchNodes(); startPoll(); };
  document.getElementById("reheat").onclick = function(){ alpha = 1; if (activeTab==="graph") kick(); };

  function getCss(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function statusOf(n){ return n.revoked?"revoked":(!n.online?"offline":(n.status==="busy"?"busy":"available")); }
  function statusColor(n){ if (n.type==="zone") return getCss("--zone"); var s=statusOf(n); return s==="revoked"?getCss("--bad"):s==="offline"?getCss("--off"):s==="busy"?getCss("--busy"):getCss("--on"); }
  function isFree(n){ return n.online && !n.revoked && n.status!=="busy"; }
  function nodeZones(n){ return n.zones && n.zones.length ? n.zones : ["(no zone)"]; }

  // ---- data ----
  function set(id,v){ document.getElementById(id).textContent=String(v); }
  function stats(d){
    var ns=(d.nodes||[]);
    set("s-nodes", ns.length); set("s-online", ns.filter(function(n){return n.online;}).length);
    set("s-free", ns.filter(isFree).length); set("s-zones", (d.zones||[]).length);
    set("s-updated", "updated " + new Date(d.generatedAt||Date.now()).toLocaleTimeString());
  }
  function render(){
    if (!data) return; stats(data); updateA11y(data);
    if (activeTab==="graph") { ingest(data); kick(); }
    else if (activeTab==="capacity") renderCapacity(data);
    else if (activeTab==="columns") renderColumns(data);
    else if (activeTab==="table") renderTable(data);
    else if (activeTab==="treemap") renderTreemap(data);
  }
  function updateA11y(d){
    a11y.textContent="";
    (d.nodes||[]).slice().sort(function(a,b){return (a.name||a.id)<(b.name||b.id)?-1:1;}).forEach(function(n){
      var li=document.createElement("li");
      li.textContent=(n.name||n.id)+" — zone "+nodeZones(n).join("/")+" — "+statusOf(n)+(n.role?(" — "+n.role):"")+((n.capabilities||[]).length?(" — "+n.capabilities.join(", ")):"");
      a11y.appendChild(li);
    });
  }

  // per-zone tallies (a multi-zone node counts in each of its zones)
  function zoneStats(d){
    var z={};
    (d.nodes||[]).forEach(function(n){ nodeZones(n).forEach(function(zn){
      var e=z[zn]||(z[zn]={name:zn,total:0,online:0,busy:0,free:0,freeCaps:{}});
      e.total++; if (n.online){ e.online++; if (n.status==="busy") e.busy++; else if (!n.revoked){ e.free++; (n.capabilities||[]).forEach(function(c){ e.freeCaps[c]=true; }); } }
    }); });
    return Object.keys(z).sort().map(function(k){ return z[k]; });
  }

  // ---- capacity matrix ----
  function renderCapacity(d){
    var el=VIEW.capacity; el.textContent="";
    var t=document.createElement("table"); t.className="grid";
    var head=["zone","online","busy","free","free capabilities"];
    var tr=document.createElement("tr"); head.forEach(function(h){ var th=document.createElement("th"); th.textContent=h; tr.appendChild(th); }); t.appendChild(tr);
    var zs=zoneStats(d), ns=d.nodes||[];
    // TOTAL is UNIQUE nodes (a multi-zone node is one machine), not the sum of zone rows — which
    // would double-count it. The per-zone rows do count it in each zone (that is correct there).
    var tot={ online: ns.filter(function(n){return n.online;}).length, busy: ns.filter(function(n){return n.online&&n.status==="busy";}).length, free: ns.filter(isFree).length };
    zs.forEach(function(z){
      var r=document.createElement("tr");
      cell(r, z.name); cell(r, String(z.online)); cell(r, String(z.busy));
      var f=document.createElement("td"); var s=document.createElement("span"); s.className="free"; s.textContent=String(z.free); f.appendChild(s); r.appendChild(f);
      var caps=document.createElement("td"); var box=document.createElement("div"); box.className="caps";
      var ck=Object.keys(z.freeCaps); if (!ck.length){ caps.textContent="—"; } else ck.forEach(function(c){ var i=document.createElement("span"); i.className="cap"; i.textContent=c; box.appendChild(i); });
      if (ck.length) caps.appendChild(box); r.appendChild(caps); t.appendChild(r);
    });
    var tr2=document.createElement("tr"); tr2.className="tot"; cell(tr2,"TOTAL"); cell(tr2,String(tot.online)); cell(tr2,String(tot.busy)); cell(tr2,String(tot.free)); cell(tr2,""); t.appendChild(tr2);
    el.appendChild(t);
  }
  function cell(tr,txt){ var td=document.createElement("td"); td.textContent=txt; tr.appendChild(td); return td; }

  // ---- zone columns (kanban) ----
  function renderColumns(d){
    var el=VIEW.columns; el.textContent="";
    var wrap=document.createElement("div"); wrap.className="cols";
    var byZone={}; (d.nodes||[]).forEach(function(n){ nodeZones(n).forEach(function(zn){ (byZone[zn]||(byZone[zn]=[])).push(n); }); });
    Object.keys(byZone).sort().forEach(function(zn){
      var col=document.createElement("div"); col.className="col";
      var h=document.createElement("h3"); var nm=document.createElement("span"); nm.textContent=zn; h.appendChild(nm);
      var list=byZone[zn].slice().sort(function(a,b){ return (b.online?1:0)-(a.online?1:0) || ((a.name||a.id)<(b.name||b.id)?-1:1); });
      var sm=document.createElement("small"); sm.textContent=list.filter(function(n){return n.online;}).length+"/"+list.length+" online"; h.appendChild(sm); col.appendChild(h);
      list.forEach(function(n){
        var c=document.createElement("div"); c.className="card";
        var top=document.createElement("div"); top.className="nm";
        var dot=document.createElement("i"); dot.className="dot"; dot.style.background=statusColor(n); top.appendChild(dot);
        var name=document.createElement("span"); name.textContent=n.name||n.id; top.appendChild(name);
        top.appendChild(badge(n)); c.appendChild(top);
        var sub=document.createElement("div"); sub.className="sub";
        if (n.role){ var rl=document.createElement("span"); rl.textContent=n.role; sub.appendChild(rl); }
        (n.capabilities||[]).forEach(function(cap){ var i=document.createElement("span"); i.className="cap"; i.textContent=cap; sub.appendChild(i); });
        if (sub.children.length) c.appendChild(sub);
        col.appendChild(c);
      });
      wrap.appendChild(col);
    });
    el.appendChild(wrap);
  }
  function badge(n){ var s=statusOf(n), b=document.createElement("span"); b.className="badge"+(s==="busy"?" busy":s==="offline"?" off":s==="revoked"?" bad":"");
    b.textContent = s==="available" ? (n.self?"server":"avail") : s; return b; }

  // ---- compact table (sortable / filterable). Controls are built ONCE and never re-created, so
  //      typing in the filter keeps focus across the 3s refresh; only the rows are rebuilt. ----
  var tbl = null;
  function renderTable(d){
    var el=VIEW.table;
    if (!tbl){
      el.textContent="";
      var ctrls=document.createElement("div"); ctrls.className="controls";
      var f=document.createElement("input"); f.type="text"; f.placeholder="filter name / zone / capability"; f.value=filterText;
      f.oninput=function(){ filterText=f.value; fillTable(data); }; ctrls.appendChild(f);
      var lab=document.createElement("label"); lab.className="hint"; var cb=document.createElement("input"); cb.type="checkbox"; cb.checked=onlineOnly;
      cb.onchange=function(){ onlineOnly=cb.checked; fillTable(data); }; lab.appendChild(cb); lab.appendChild(document.createTextNode(" online only")); ctrls.appendChild(lab);
      var container=document.createElement("div"); var note=document.createElement("div"); note.className="hint"; note.style.marginTop="8px";
      el.appendChild(ctrls); el.appendChild(container); el.appendChild(note);
      tbl={ filter:f, cb:cb, container:container, note:note };
    }
    if (document.activeElement!==tbl.filter) tbl.filter.value=filterText; tbl.cb.checked=onlineOnly;
    fillTable(d);
  }
  function fillTable(d){
    if (!tbl) return;
    var cols=[["name","NODE"],["zone","ZONE"],["status","STATUS"],["role","ROLE"],["caps","CAPABILITIES"]];
    var t=document.createElement("table"); t.className="grid sortable";
    var tr=document.createElement("tr");
    cols.forEach(function(c){ var th=document.createElement("th"); th.textContent=c[1]+(sortKey===c[0]?(sortDir>0?" ▲":" ▼"):""); th.onclick=function(){ if (sortKey===c[0]) sortDir=-sortDir; else { sortKey=c[0]; sortDir=1; } fillTable(data); }; tr.appendChild(th); });
    t.appendChild(tr);
    var rows=(d.nodes||[]).map(function(n){ return { n:n, name:(n.name||n.id), zone:nodeZones(n).join(","), status:statusOf(n), role:n.role||"", caps:(n.capabilities||[]).join(", ") }; });
    var q=filterText.toLowerCase();
    rows=rows.filter(function(r){ if (onlineOnly && !r.n.online) return false; if (!q) return true; return (r.name+" "+r.zone+" "+r.caps+" "+r.role).toLowerCase().indexOf(q)>=0; });
    rows.sort(function(a,b){ var x=a[sortKey], y=b[sortKey]; return (x<y?-1:x>y?1:0)*sortDir; });
    rows.forEach(function(r){
      var row=document.createElement("tr");
      var c0=document.createElement("td"); var nm=document.createElement("div"); nm.className="nm";
      var dot=document.createElement("i"); dot.className="dot"; dot.style.background=statusColor(r.n); nm.appendChild(dot);
      var sp=document.createElement("span"); sp.textContent=r.name; nm.appendChild(sp); c0.appendChild(nm); row.appendChild(c0);
      cell(row, r.zone); cell(row, r.status + (r.n.self?" (server)":"")); cell(row, r.role || "—");
      var cc=document.createElement("td"); if (!r.caps) cc.textContent="—"; else { var box=document.createElement("div"); box.className="caps"; (r.n.capabilities||[]).forEach(function(cap){ var i=document.createElement("span"); i.className="cap"; i.textContent=cap; box.appendChild(i); }); cc.appendChild(box); } row.appendChild(cc);
      t.appendChild(row);
    });
    tbl.container.textContent=""; tbl.container.appendChild(t);
    tbl.note.textContent=rows.length+" shown";
  }

  // ---- treemap (zone area ∝ node count, tiles colored by status) ----
  function renderTreemap(d){
    var el=VIEW.treemap; el.textContent="";
    var inner=document.createElement("div"); inner.id="tmInner";
    var byZone={}; (d.nodes||[]).forEach(function(n){ nodeZones(n).forEach(function(zn){ (byZone[zn]||(byZone[zn]=[])).push(n); }); });
    Object.keys(byZone).sort().forEach(function(zn){
      var list=byZone[zn]; var z=document.createElement("div"); z.className="tmZone"; z.style.flex=list.length+" 1 0";
      var zh=document.createElement("div"); zh.className="zh"; zh.textContent=zn+" ("+list.length+")"; z.appendChild(zh);
      var tiles=document.createElement("div"); tiles.className="tmTiles";
      list.slice().sort(function(a,b){ return (b.online?1:0)-(a.online?1:0); }).forEach(function(n){
        var tile=document.createElement("div"); tile.className="tmTile"; tile.style.background=statusColor(n);
        if (statusOf(n)==="offline") tile.style.color="#aeb9ca";
        tile.textContent=n.name||n.id; tile.title=(n.name||n.id)+" · "+statusOf(n)+((n.capabilities||[]).length?(" · "+n.capabilities.join(", ")):"");
        tiles.appendChild(tile);
      });
      z.appendChild(tiles); inner.appendChild(z);
    });
    el.appendChild(inner);
  }

  // ================= GRAPH (canvas force layout) =================
  function kick(){ if (rafQueued) return; rafQueued=true; requestAnimationFrame(frame); }
  function frame(){ rafQueued=false; if (activeTab!=="graph") return; step(); draw(); if (alpha>0.025) kick(); }
  function size(){ var r=cv.parentElement.getBoundingClientRect(); cv.width=r.width*devicePixelRatio; cv.height=r.height*devicePixelRatio; if (activeTab==="graph") kick(); }
  window.addEventListener("resize", function(){ size(); if (activeTab!=="graph" && data) render(); });
  size();

  function ingest(d){
    selfId = d.self ? "node:"+d.self : null;
    var W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio, next={}, nextNodes=[];
    function ensure(id, make){ var ex=byId[id]; if (ex){ for (var k in make) ex[k]=make[k]; next[id]=ex; nextNodes.push(ex); return ex; }
      make.x=W/2+(Math.random()-0.5)*240; make.y=H/2+(Math.random()-0.5)*240; make.vx=0; make.vy=0; next[id]=make; nextNodes.push(make); return make; }
    var zoneSet={}; (d.nodes||[]).forEach(function(a){ nodeZones(a).forEach(function(z){ zoneSet[z]=true; }); });
    Object.keys(zoneSet).forEach(function(z){ ensure("zone:"+z, { id:"zone:"+z, type:"zone", label:z, r:16 }); });
    (d.nodes||[]).forEach(function(a){ ensure("node:"+a.id, { id:"node:"+a.id, type:"agent", label:a.name||a.id, r:8,
      online:!!a.online, status:a.status, role:a.role, canRun:!!a.canRun, revoked:!!a.revoked, isSelf:!!a.self,
      enrolled:a.enrolled!==false, zones:nodeZones(a), caps:a.capabilities||[], agentId:a.id }); });
    byId=next; nodes=nextNodes; links=[];
    nodes.forEach(function(n){ if (n.type==="agent") n.zones.forEach(function(z){ var zn=byId["zone:"+z]; if (zn) links.push({a:n,b:zn}); }); });
    if (hot && !byId[hot.id]) hot=null; if (dragging && !byId[dragging.id]) dragging=null;
    var key=nextNodes.map(function(n){return n.id;}).sort().join(",");
    if (key!==prevKey){ prevKey=key; alpha=Math.max(alpha,0.6); }
  }
  function step(){
    var W=cv.width/devicePixelRatio, H=cv.height/devicePixelRatio, cx=W/2, cy=H/2;
    for (var i=0;i<nodes.length;i++){ var a=nodes[i];
      for (var j=i+1;j<nodes.length;j++){ var b=nodes[j], dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy+0.01, dd=Math.sqrt(d2);
        var rep=(a.type==="zone"||b.type==="zone"?5200:2600)/d2; if (rep>4) rep=4; var fx=dx/dd*rep, fy=dy/dd*rep; a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy; }
      a.vx+=(cx-a.x)*0.0016; a.vy+=(cy-a.y)*0.0016; }
    for (var l=0;l<links.length;l++){ var L=links[l], ux=L.b.x-L.a.x, uy=L.b.y-L.a.y, u=Math.sqrt(ux*ux+uy*uy)||1, f=(u-92)*0.02; var gx=ux/u*f, gy=uy/u*f; L.a.vx+=gx; L.a.vy+=gy; L.b.vx-=gx*0.3; L.b.vy-=gy*0.3; }
    for (var k=0;k<nodes.length;k++){ var n=nodes[k]; if (n===dragging){ n.vx=0; n.vy=0; continue; } n.vx*=0.86; n.vy*=0.86;
      n.vx=Math.max(-12,Math.min(12,n.vx)); n.vy=Math.max(-12,Math.min(12,n.vy)); n.x+=n.vx*alpha; n.y+=n.vy*alpha; }
    alpha*=0.985; if (alpha<0.02) alpha=0.02;
  }
  function draw(){
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); ctx.clearRect(0,0,cv.width,cv.height);
    if (!nodes.length){ msgEl.style.display = authFailed ? "block" : "none"; return; }
    ctx.save(); ctx.translate(view.x,view.y); ctx.scale(view.k,view.k);
    ctx.lineWidth=1; ctx.strokeStyle="rgba(120,140,170,0.22)";
    for (var l=0;l<links.length;l++){ var L=links[l]; ctx.beginPath(); ctx.moveTo(L.a.x,L.a.y); ctx.lineTo(L.b.x,L.b.y); ctx.stroke(); }
    for (var i=0;i<nodes.length;i++){ var n=nodes[i], col=statusColor(n);
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,6.2832); ctx.fillStyle=n.type==="zone"?"rgba(59,130,246,0.18)":col; ctx.fill();
      ctx.lineWidth=(n===hot?2.5:1.4); ctx.strokeStyle=(n.type==="zone"?getCss("--zone"):col); ctx.stroke();
      if (n.type==="agent"&&n.status==="busy"&&n.online){ ctx.beginPath(); ctx.arc(n.x,n.y,n.r+3,0,6.2832); ctx.strokeStyle="rgba(251,189,35,0.5)"; ctx.stroke(); }
      if (n.isSelf){ ctx.beginPath(); ctx.arc(n.x,n.y,n.r+4,0,6.2832); ctx.strokeStyle="#cfe0ff"; ctx.lineWidth=1; ctx.stroke(); }
      ctx.fillStyle=n.type==="zone"?"#cfe0ff":"#aeb9ca"; ctx.font=(n.type==="zone"?"600 12px ":"11px ")+"ui-sans-serif,system-ui,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="top"; ctx.fillText(n.label, n.x, n.y+n.r+3); }
    ctx.restore();
  }
  function world(ev){ var r=cv.getBoundingClientRect(); return { x:(ev.clientX-r.left-view.x)/view.k, y:(ev.clientY-r.top-view.y)/view.k, sx:ev.clientX-r.left, sy:ev.clientY-r.top }; }
  function pick(wx,wy){ for (var i=nodes.length-1;i>=0;i--){ var n=nodes[i], dx=n.x-wx, dy=n.y-wy; if (dx*dx+dy*dy<=(n.r+4)*(n.r+4)) return n; } return null; }
  cv.addEventListener("mousedown", function(ev){ if (activeTab!=="graph") return; var w=world(ev), n=pick(w.x,w.y); if (n) dragging=n; else panning={x:ev.clientX,y:ev.clientY,vx:view.x,vy:view.y}; cv.classList.add("drag"); });
  window.addEventListener("mousemove", function(ev){ if (activeTab!=="graph") return; var w=world(ev);
    if (dragging){ dragging.x=w.x; dragging.y=w.y; dragging.vx=0; dragging.vy=0; alpha=Math.max(alpha,0.5); kick(); }
    else if (panning){ view.x=panning.vx+(ev.clientX-panning.x); view.y=panning.vy+(ev.clientY-panning.y); kick(); }
    else { var n=pick(w.x,w.y); hot=n; n?showTip(n,w.sx,w.sy):hideTip(); kick(); } });
  window.addEventListener("mouseup", function(){ dragging=null; panning=null; cv.classList.remove("drag"); });
  cv.addEventListener("wheel", function(ev){ if (activeTab!=="graph") return; ev.preventDefault(); var r=cv.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
    var f=ev.deltaY<0?1.12:0.89, nk=Math.max(0.25,Math.min(4,view.k*f)); view.x=mx-(mx-view.x)*(nk/view.k); view.y=my-(my-view.y)*(nk/view.k); view.k=nk;
    if (hot) showTip(hot, hot.x*view.k+view.x, hot.y*view.k+view.y); kick(); }, { passive:false });

  function showTip(n,sx,sy){
    tip.textContent="";
    var nm=document.createElement("div"); nm.className="nm"; nm.textContent=(n.type==="zone"?"zone · ":"")+n.label+(n.isSelf?"  (server)":""); tip.appendChild(nm);
    function row(k,v){ var d=document.createElement("div"); d.className="row"; var a=document.createElement("span"); a.textContent=k; var b=document.createElement("b"); b.textContent=v; d.appendChild(a); d.appendChild(b); tip.appendChild(d); }
    if (n.type==="zone"){ var mem=nodes.filter(function(x){return x.type==="agent"&&x.zones.indexOf(n.label)>=0;}); row("members",String(mem.length)); row("online",String(mem.filter(function(x){return x.online;}).length)); }
    else { row("id", n.agentId); row("status", statusOf(n)); if (n.role) row("role", n.role); row("zones", n.zones.join(", ")); if (n.canRun) row("can run","yes"); if (n.enrolled===false) row("enrolled","no (roster only)");
      if (n.caps&&n.caps.length){ var c=document.createElement("div"); c.className="caps"; n.caps.forEach(function(cap){ var i=document.createElement("span"); i.className="cap"; i.textContent=cap; c.appendChild(i); }); tip.appendChild(c); } }
    var box=cv.parentElement, W=box.clientWidth, H=box.clientHeight; tip.style.opacity="1"; var th=tip.offsetHeight, tw=tip.offsetWidth;
    tip.style.left=Math.max(4,Math.min(sx+14, W-tw-6))+"px"; tip.style.top=Math.max(4,Math.min(sy+14, H-th-6))+"px";
  }
  function hideTip(){ tip.style.opacity="0"; }

  // ---- fetch + polling (admin-gated; explicit load always fetches, poll pauses when hidden) ----
  function fetchNodes(){
    var tok=tokenIn.value||"";
    fetch("/api/nodes", { headers: tok?{authorization:"Bearer "+tok}:{} })
      .then(function(r){ if (r.status===401||r.status===403){ throw new Error("auth"); } if (!r.ok) throw new Error("http "+r.status); return r.json(); })
      .then(function(d){ authFailed=false; msgEl.style.display="none"; data=d; render(); })
      .catch(function(e){ if (e.message==="auth"){ authFailed=true; stopPoll(); showMsg(true); } else showMsg(false, "Could not load nodes: "+e.message); });
  }
  function showMsg(isAuth, text){ msgEl.textContent=""; msgEl.style.display="block";
    if (isAuth){ var s=document.createElement("span"); s.appendChild(document.createTextNode("Enter the ")); var b=document.createElement("b"); b.textContent="admin token"; s.appendChild(b); s.appendChild(document.createTextNode(" above and click Connect.")); msgEl.appendChild(s); }
    else msgEl.textContent=text; }
  function startPoll(){ if (poll) return; poll=setInterval(function(){ if (!document.hidden) fetchNodes(); }, 3000); }
  function stopPoll(){ if (poll){ clearInterval(poll); poll=null; } }
  document.addEventListener("visibilitychange", function(){ if (!document.hidden && !authFailed) fetchNodes(); });

  fetchNodes(); startPoll();
})();
</script>
</body>
</html>`;
