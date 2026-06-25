// The node-topology dashboard, served at GET /dashboard. Self-contained (no external assets —
// the server may run on an isolated network). It renders a force-directed graph of nodes grouped
// by zone, polling GET /api/nodes (admin-gated) for live presence.
//
// SECURITY: every node-supplied string (agent name, capabilities, zone) is drawn via canvas
// fillText or assigned through DOM textContent — NEVER innerHTML — so a maliciously-named agent
// (e.g. "<img onerror=…>") cannot inject script into this admin-facing page.
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
                padding:5px 8px; width:200px; font:inherit; }
  button { background:#1e2733; border:1px solid var(--line); color:var(--fg); border-radius:6px;
           padding:5px 10px; cursor:pointer; font:inherit; }
  button:hover { background:#27323f; }
  #wrap { position:relative; flex:1; overflow:hidden; }
  canvas { display:block; width:100%; height:100%; cursor:grab; }
  canvas.drag { cursor:grabbing; }
  #legend { position:absolute; left:12px; bottom:12px; background:rgba(20,26,36,.85); border:1px solid var(--line);
            border-radius:8px; padding:8px 10px; display:flex; gap:14px; flex-wrap:wrap; backdrop-filter:blur(4px); }
  #legend span { display:flex; align-items:center; gap:6px; color:var(--muted); }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
  #tip { position:absolute; pointer-events:none; background:#0b0e14; border:1px solid var(--line); border-radius:8px;
         padding:8px 10px; min-width:160px; max-width:280px; box-shadow:0 6px 24px rgba(0,0,0,.45);
         opacity:0; transition:opacity .08s; z-index:5; }
  #tip .nm { font-weight:600; margin-bottom:4px; }
  #tip .row { color:var(--muted); display:flex; justify-content:space-between; gap:10px; }
  #tip .row b { color:var(--fg); font-weight:500; }
  #tip .caps { margin-top:5px; display:flex; flex-wrap:wrap; gap:4px; }
  #tip .caps i { font-style:normal; background:#1e2733; border-radius:4px; padding:1px 6px; color:#aab6c8; }
  #err { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center; color:var(--muted); }
  #err b { color:var(--bad); }
  .hint { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>◆ Conclave</h1>
    <span class="stat"><b id="s-nodes">0</b> nodes</span>
    <span class="stat"><b id="s-online">0</b> online</span>
    <span class="stat"><b id="s-zones">0</b> zones</span>
    <span class="hint" id="s-updated"></span>
    <span class="spacer"></span>
    <input id="token" type="password" placeholder="admin token" autocomplete="off" />
    <button id="save">Connect</button>
    <button id="reheat" title="re-run layout">Relayout</button>
  </header>
  <div id="wrap">
    <canvas id="cv"></canvas>
    <div id="legend">
      <span><i class="dot" style="background:var(--on)"></i>online</span>
      <span><i class="dot" style="background:var(--busy)"></i>busy</span>
      <span><i class="dot" style="background:var(--off)"></i>offline</span>
      <span><i class="dot" style="background:var(--bad)"></i>revoked</span>
      <span><i class="dot" style="background:var(--zone)"></i>zone</span>
      <span class="hint">drag · scroll to zoom · hover for detail</span>
    </div>
    <div id="tip"></div>
    <div id="err" style="display:none"></div>
  </div>
</div>
<script>
(function(){
  "use strict";
  var cv = document.getElementById("cv"), ctx = cv.getContext("2d");
  var tip = document.getElementById("tip"), errEl = document.getElementById("err");
  var tokenIn = document.getElementById("token");
  var nodes = [], links = [], byId = {}, view = { x:0, y:0, k:1 }, dragging = null, panning = null, hot = null;
  var alpha = 1; // simulation "temperature"

  // --- token persistence (localStorage; sent as Bearer to the gated /api/nodes) ---
  try { tokenIn.value = localStorage.getItem("conclave.adminToken") || ""; } catch(e){}
  document.getElementById("save").onclick = function(){
    try { localStorage.setItem("conclave.adminToken", tokenIn.value); } catch(e){}
    fetchNodes();
  };
  document.getElementById("reheat").onclick = function(){ alpha = 1; requestAnimationFrame(loop); };

  function size(){ var r = cv.parentElement.getBoundingClientRect(); cv.width = r.width*devicePixelRatio; cv.height = r.height*devicePixelRatio; }
  window.addEventListener("resize", function(){ size(); });
  size();

  function statusColor(n){
    if (n.type === "zone") return getCss("--zone");
    if (n.revoked) return getCss("--bad");
    if (!n.online) return getCss("--off");
    if (n.status === "busy") return getCss("--busy");
    return getCss("--on");
  }
  function getCss(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  // --- merge a fresh snapshot, PRESERVING positions of nodes we already have (no jump on refresh) ---
  function ingest(data){
    var W = cv.width/devicePixelRatio, H = cv.height/devicePixelRatio;
    var next = {}, nextNodes = [];
    function ensure(id, make){
      var ex = byId[id];
      if (ex){ Object.assign(ex, make); next[id]=ex; nextNodes.push(ex); return ex; }
      var n = make; n.x = W/2 + (Math.random()-0.5)*240; n.y = H/2 + (Math.random()-0.5)*240; n.vx=0; n.vy=0;
      next[id]=n; nextNodes.push(n); return n;
    }
    var zoneSet = {};
    (data.nodes||[]).forEach(function(a){ (a.zones&&a.zones.length?a.zones:["(no zone)"]).forEach(function(z){ zoneSet[z]=true; }); });
    Object.keys(zoneSet).forEach(function(z){ ensure("zone:"+z, { id:"zone:"+z, type:"zone", label:z, r:16 }); });
    (data.nodes||[]).forEach(function(a){
      ensure("node:"+a.id, { id:"node:"+a.id, type:"agent", label:a.name||a.id, r:8,
        online:!!a.online, status:a.status, role:a.role, canRun:!!a.canRun, revoked:!!a.revoked,
        enrolled:a.enrolled!==false, zones:(a.zones&&a.zones.length?a.zones:["(no zone)"]), caps:a.capabilities||[], agentId:a.id });
    });
    byId = next; nodes = nextNodes;
    links = [];
    nodes.forEach(function(n){ if (n.type==="agent") n.zones.forEach(function(z){ var zn=byId["zone:"+z]; if (zn) links.push({a:n, b:zn}); }); });
    // header stats
    var agents = nodes.filter(function(n){ return n.type==="agent"; });
    set("s-nodes", agents.length); set("s-online", agents.filter(function(n){return n.online;}).length);
    set("s-zones", (data.zones||[]).length);
    var d = new Date(data.generatedAt||Date.now());
    set("s-updated", "updated " + d.toLocaleTimeString());
    alpha = Math.max(alpha, 0.6); requestAnimationFrame(loop);
  }
  function set(id, v){ document.getElementById(id).textContent = String(v); }

  // --- force simulation (repulsion + zone springs + gravity), Verlet-ish integration ---
  function step(){
    var W = cv.width/devicePixelRatio, H = cv.height/devicePixelRatio, cx=W/2, cy=H/2;
    for (var i=0;i<nodes.length;i++){
      var a=nodes[i];
      for (var j=i+1;j<nodes.length;j++){
        var b=nodes[j], dx=a.x-b.x, dy=a.y-b.y, d2=dx*dx+dy*dy+0.01, d=Math.sqrt(d2);
        var rep=(a.type==="zone"||b.type==="zone"?5200:2600)/d2; if (rep>4) rep=4;
        var fx=dx/d*rep, fy=dy/d*rep;
        a.vx+=fx; a.vy+=fy; b.vx-=fx; b.vy-=fy;
      }
      a.vx += (cx-a.x)*0.0016; a.vy += (cy-a.y)*0.0016; // gravity to center
    }
    for (var l=0;l<links.length;l++){
      var L=links[l], dx=L.b.x-L.a.x, dy=L.b.y-L.a.y, d=Math.sqrt(dx*dx+dy*dy)||1, rest=92, f=(d-rest)*0.02;
      var fx=dx/d*f, fy=dy/d*f;
      L.a.vx+=fx; L.a.vy+=fy; L.b.vx-=fx*0.3; L.b.vy-=fy*0.3; // zones move less
    }
    for (var k=0;k<nodes.length;k++){
      var n=nodes[k]; if (n===dragging) { n.vx=0; n.vy=0; continue; }
      n.vx*=0.86; n.vy*=0.86;
      n.vx=Math.max(-12,Math.min(12,n.vx)); n.vy=Math.max(-12,Math.min(12,n.vy));
      n.x+=n.vx*alpha; n.y+=n.vy*alpha;
    }
    alpha*=0.985; if (alpha<0.02) alpha=0.02;
  }

  function draw(){
    ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
    ctx.clearRect(0,0,cv.width,cv.height);
    ctx.save(); ctx.translate(view.x,view.y); ctx.scale(view.k,view.k);
    ctx.lineWidth=1; ctx.strokeStyle="rgba(120,140,170,0.22)";
    for (var l=0;l<links.length;l++){ var L=links[l]; ctx.beginPath(); ctx.moveTo(L.a.x,L.a.y); ctx.lineTo(L.b.x,L.b.y); ctx.stroke(); }
    for (var i=0;i<nodes.length;i++){
      var n=nodes[i], col=statusColor(n);
      ctx.beginPath(); ctx.arc(n.x,n.y,n.r,0,6.2832);
      ctx.fillStyle = n.type==="zone" ? "rgba(59,130,246,0.18)" : col; ctx.fill();
      ctx.lineWidth = (n===hot?2.5:1.4); ctx.strokeStyle = (n.type==="zone"?getCss("--zone"):col); ctx.stroke();
      if (n.type==="agent" && n.status==="busy" && n.online){ ctx.beginPath(); ctx.arc(n.x,n.y,n.r+3,0,6.2832); ctx.strokeStyle="rgba(251,189,35,0.5)"; ctx.stroke(); }
      ctx.fillStyle = n.type==="zone" ? "#cfe0ff" : "#aeb9ca";
      ctx.font = (n.type==="zone"?"600 12px ":"11px ")+"ui-sans-serif,system-ui,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="top";
      ctx.fillText(n.label, n.x, n.y+n.r+3); // canvas text = XSS-safe
    }
    ctx.restore();
  }

  function loop(){ step(); draw(); if (alpha>0.025) requestAnimationFrame(loop); }

  // --- picking + interaction (screen → world) ---
  function world(ev){ var r=cv.getBoundingClientRect(); return { x:(ev.clientX-r.left-view.x)/view.k, y:(ev.clientY-r.top-view.y)/view.k, sx:ev.clientX-r.left, sy:ev.clientY-r.top }; }
  function pick(wx,wy){ for (var i=nodes.length-1;i>=0;i--){ var n=nodes[i], dx=n.x-wx, dy=n.y-wy; if (dx*dx+dy*dy <= (n.r+4)*(n.r+4)) return n; } return null; }

  cv.addEventListener("mousedown", function(ev){
    var w=world(ev), n=pick(w.x,w.y);
    if (n){ dragging=n; cv.classList.add("drag"); } else { panning={x:ev.clientX,y:ev.clientY,vx:view.x,vy:view.y}; cv.classList.add("drag"); }
  });
  window.addEventListener("mousemove", function(ev){
    var w=world(ev);
    if (dragging){ dragging.x=w.x; dragging.y=w.y; dragging.vx=0; dragging.vy=0; alpha=Math.max(alpha,0.5); requestAnimationFrame(loop); }
    else if (panning){ view.x=panning.vx+(ev.clientX-panning.x); view.y=panning.vy+(ev.clientY-panning.y); requestAnimationFrame(loop); }
    else { var n=pick(w.x,w.y); hot=n; n ? showTip(n,w.sx,w.sy) : hideTip(); requestAnimationFrame(loop); }
  });
  window.addEventListener("mouseup", function(){ dragging=null; panning=null; cv.classList.remove("drag"); });
  cv.addEventListener("wheel", function(ev){ ev.preventDefault(); var r=cv.getBoundingClientRect(), mx=ev.clientX-r.left, my=ev.clientY-r.top;
    var f=ev.deltaY<0?1.12:0.89, nk=Math.max(0.25,Math.min(4,view.k*f));
    view.x = mx-(mx-view.x)*(nk/view.k); view.y = my-(my-view.y)*(nk/view.k); view.k=nk; requestAnimationFrame(loop);
  }, { passive:false });

  // --- tooltip (DOM textContent only — node-supplied strings are never parsed as HTML) ---
  function showTip(n,sx,sy){
    tip.textContent="";
    var nm=document.createElement("div"); nm.className="nm"; nm.textContent=(n.type==="zone"?"zone · ":"")+n.label; tip.appendChild(nm);
    function row(k,v){ var d=document.createElement("div"); d.className="row"; var a=document.createElement("span"); a.textContent=k; var b=document.createElement("b"); b.textContent=v; d.appendChild(a); d.appendChild(b); tip.appendChild(d); }
    if (n.type==="zone"){ var mem=nodes.filter(function(x){return x.type==="agent"&&x.zones.indexOf(n.label)>=0;}); row("members",String(mem.length)); row("online",String(mem.filter(function(x){return x.online;}).length)); }
    else {
      row("id", n.agentId);
      row("status", n.revoked?"revoked":(!n.online?"offline":(n.status||"available")));
      if (n.role) row("role", n.role); row("zones", n.zones.join(", ")); if (n.canRun) row("can run","yes");
      if (n.enrolled===false) row("enrolled","no (roster only)");
      if (n.caps && n.caps.length){ var c=document.createElement("div"); c.className="caps"; n.caps.forEach(function(cap){ var i=document.createElement("i"); i.textContent=cap; c.appendChild(i); }); tip.appendChild(c); }
    }
    var W=cv.parentElement.clientWidth; tip.style.left=Math.min(sx+14,W-290)+"px"; tip.style.top=(sy+14)+"px"; tip.style.opacity="1";
  }
  function hideTip(){ tip.style.opacity="0"; }

  // --- data fetch (admin-gated) ---
  function fetchNodes(){
    var tok=tokenIn.value||"";
    fetch("/api/nodes", { headers: tok?{authorization:"Bearer "+tok}:{} })
      .then(function(r){ if (r.status===401||r.status===403){ throw new Error("auth"); } if (!r.ok) throw new Error("http "+r.status); return r.json(); })
      .then(function(d){ errEl.style.display="none"; cv.style.display="block"; ingest(d); })
      .catch(function(e){ showErr(e.message==="auth" ? "Enter the <b>admin token</b> above and click Connect." : ("Could not load nodes: "+e.message)); });
  }
  function showErr(html){ errEl.style.display="block"; errEl.innerHTML=html; } // fixed strings only — never node data

  fetchNodes();
  setInterval(fetchNodes, 3000); // live refresh
})();
</script>
</body>
</html>`;
