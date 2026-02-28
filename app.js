/* ============================================================
   app.js — Pemberley Dogfight Replay Console
   - Leaflet map w/ animated aircraft markers + trails
   - Radar canvas scope mirrored from same replay clock
   - Time-coded mission events (engagements, kills, impacts, notes)
   - Controls: play/pause/restart, speed slider, CRT/trails/labels toggles
   ============================================================ */

(() => {
  const $ = (s, r=document) => r.querySelector(s);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // -------- UI elements
  const elClock = $("#clockLabel");
  const elTimeline = $("#timeline");

  const elBtnPlay = $("#btnPlay");
  const elBtnPause = $("#btnPause");
  const elBtnRestart = $("#btnRestart");

  const elSpeed = $("#speed");
  const elSpeedLabel = $("#speedLabel");

  const elCRT = $("#toggleCRT");
  const elTrails = $("#toggleTrails");
  const elLabels = $("#toggleLabels");
  const elFollow = $("#toggleFollow");

  const elActiveChip = $("#activeChip");
  const elLossesChip = $("#lossesChip");

  const elHudContacts = $("#hudContacts");
  const elHudEng = $("#hudEng");
  const elHudKills = $("#hudKills");
  const elHudStatus = $("#hudStatus");

  const elStatTracks = $("#statTracks");
  const elMeterBlitz = $("#meterBlitz");
  const elStatLast = $("#statLast");
  const elStatSel = $("#statSel");

  // -------- Mission loading
  let MISSION = null;

  async function loadMission(){
    try{
      const r = await fetch("./mission.json", { cache: "no-store" });
      if (!r.ok) throw new Error("mission.json not found");
      MISSION = await r.json();
      return MISSION;
    }catch(err){
      console.warn("Mission load failed, using built-in sample. Run via local server for mission.json.", err);
      MISSION = window.__MISSION_FALLBACK__;
      if (!MISSION) throw err;
      return MISSION;
    }
  }

  // -------- Helpers: time formatting
  function fmtClock(t){
    const s = Math.max(0, Math.floor(t));
    const mm = String(Math.floor(s / 60)).padStart(2,"0");
    const ss = String(s % 60).padStart(2,"0");
    return `T+${mm}:${ss}`;
  }

  // -------- Path interpolation
  function interpPath(path, t){
    if (!path || !path.length) return null;
    if (t <= path[0].t) return { lat: path[0].lat, lng: path[0].lng, hdg: 0 };
    if (t >= path[path.length-1].t) return { lat: path[path.length-1].lat, lng: path[path.length-1].lng, hdg: 0 };

    let i = 0;
    while (i < path.length-1 && !(t >= path[i].t && t <= path[i+1].t)) i++;
    const a = path[i], b = path[i+1];
    const u = (t - a.t) / (b.t - a.t);

    const lat = a.lat + (b.lat - a.lat) * u;
    const lng = a.lng + (b.lng - a.lng) * u;

    // bearing from a->b (degrees, 0 = north)
    const lat1 = a.lat * Math.PI/180;
    const lat2 = b.lat * Math.PI/180;
    const dLon = (b.lng - a.lng) * Math.PI/180;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(dLon);
    const brng = (Math.atan2(y, x) * 180/Math.PI + 360) % 360;
    const hdg = brng;
    return { lat, lng, hdg };
  }

  // -------- Leaflet map
  let map;
  let aircraftState = new Map(); // id -> { cfg, marker, label, trailLine, trailPts, dead, lastPos }
  let selectedId = null;

  function makePlaneIcon(side){
    const wrap = document.createElement("div");
    wrap.className = `planeIcon ${side === "RAF" ? "sideRAF" : "sideENEMY"}`;
    const span = document.createElement("span");
    span.className = "planeGlyph";
    span.textContent = "✈";
    wrap.appendChild(span);
    return L.divIcon({
      className: "",
      html: wrap.outerHTML,
      iconSize: [28,28],
      iconAnchor: [14,14],
    });
  }

  function makeLabelIcon(text){
    const wrap = document.createElement("div");
    wrap.className = "planeLabel";
    wrap.textContent = text;
    return L.divIcon({
      className: "",
      html: wrap.outerHTML,
      iconSize: null
    });
  }

  function initMap(mission){
    const c = mission.center || {lat: 51.505, lng: -0.09};

    map = L.map("map", {
      zoomControl: true,
      preferCanvas: true
    }).setView([c.lat, c.lng], 13);

    // OSM tiles
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 20
    }).addTo(map);
// Soft neon tint overlay
    map.createPane("tint");
    const tint = L.rectangle(map.getBounds(), {
      pane: "tint",
      interactive: false,
      color: "rgba(255,0,184,.08)",
      weight: 0,
      fillOpacity: 0.12
    }).addTo(map);
    map.on("moveend", () => tint.setBounds(map.getBounds()));

    // Aircraft markers
    // Fit to all tracks so nothing drifts off-screen
    const allBounds = L.latLngBounds([]);
    for (const ac0 of mission.aircraft || []){
      for (const pt of (ac0.path || [])) allBounds.extend([pt.lat, pt.lng]);
    }

    for (const ac of mission.aircraft || []){
      const pos = interpPath(ac.path, 0) || {lat: c.lat, lng: c.lng, hdg: 0};
      const marker = L.marker([pos.lat, pos.lng], {
        icon: makePlaneIcon(ac.side),
        keyboard: false
      }).addTo(map);

      marker.on("click", () => selectAircraft(ac.id));

      const label = L.marker([pos.lat, pos.lng], {
        icon: makeLabelIcon(ac.callsign),
        interactive: false,
        keyboard: false
      }).addTo(map);

      // Full route (flight-history style) + progress route (so-far)
const routeAllPts = (ac.path || []).map(p => [p.lat, p.lng]);

const routeAllLine = L.polyline(routeAllPts, {
  color: ac.side === "RAF" ? "#28d7ff" : "#ff00b8",
  weight: 2,
  opacity: 0.18,
  dashArray: "6 10",
  lineCap: "round",
  lineJoin: "round"
}).addTo(map);

const trailLine = L.polyline([], {
  color: ac.side === "RAF" ? "#28d7ff" : "#ff00b8",
  weight: 4,
  opacity: 0.55,
  lineCap: "round",
  lineJoin: "round"
}).addTo(map);

      aircraftState.set(ac.id, {
  cfg: ac,
  marker,
  label,
  // Full (dashed) route + traveled route
  routeAllLine,
  routeAllPts,
  trailLine,
  trailPts: [],
  pathIdx: 0, // index into cfg.path for appending new route points
  dead: false,
  lastPos: pos
});
    }

    // lock view to mission extent (slight padding)
    if (allBounds.isValid()){
      map.fitBounds(allBounds.pad(0.18));
    }
  }

  function selectAircraft(id){
    selectedId = id;
    const st = aircraftState.get(id);
    if (!st) return;
    elActiveChip.textContent = `ACTIVE: ${st.cfg.callsign}`;
    elStatSel.textContent = `${st.cfg.callsign} (${st.cfg.side})`;
  }


  // -------- Map follow (optional)
  // Keeps the map centered on the selected aircraft (if any),
  // otherwise follows the average position of all live tracks.
  let __followTick = 0;
  let __followJustEnabled = false;
  let __followZoomTarget = null;
  const FOLLOW_INTERVAL_MS = 650;

  function getFollowTargetLatLng(){
    // Prefer the actively selected aircraft
    if (selectedId){
      const st = aircraftState.get(selectedId);
      if (st && !st.dead && st.lastPos) return L.latLng(st.lastPos.lat, st.lastPos.lng);
    }
    // Otherwise: average of all live tracks (stable, cinematic)
    let sumLat = 0, sumLng = 0, n = 0;
    for (const st of aircraftState.values()){
      if (st.dead || !st.lastPos) continue;
      sumLat += st.lastPos.lat;
      sumLng += st.lastPos.lng;
      n++;
    }
    if (!n) return null;
    return L.latLng(sumLat / n, sumLng / n);
  }

  function maybeFollowMap(){
    if (!elFollow || !elFollow.checked || !map) return;

    const nowMs = performance.now();
    if (!__followJustEnabled && (nowMs - __followTick) < FOLLOW_INTERVAL_MS) return;
    __followTick = nowMs;

    const tgt = getFollowTargetLatLng();
    if (!tgt) return;

    // One-time "zoom in" when enabling follow, then keep that zoom (or higher).
if (__followJustEnabled){
  __followJustEnabled = false;
  __followZoomTarget = Math.max(map.getZoom(), 15);
  map.setView(tgt, __followZoomTarget, { animate: true, duration: 0.85 });
  return;
}

// Stay locked on target (throttled) at the follow zoom.
const zNow = map.getZoom();
const z = (__followZoomTarget == null) ? Math.max(zNow, 15) : Math.max(zNow, __followZoomTarget);
__followZoomTarget = z;
map.setView(tgt, z, { animate: true, duration: 0.9 });
  }

  // -------- Effects on map
  function addImpact(lat, lng){
    const m = L.marker([lat,lng], {
      icon: L.divIcon({ className:"", html:`<div class="crash">💥</div>` }),
      interactive: false
    }).addTo(map);

    gsap.fromTo(m.getElement(), {scale:0.6, opacity:0}, {scale:1.15, opacity:1, duration:0.18, ease:"power2.out"});
    gsap.to(m.getElement(), {scale:1.4, opacity:0, duration:1.4, ease:"power2.inOut", onComplete: ()=> map.removeLayer(m)});

    // shock ring
    const ring = L.circle([lat,lng], {
      radius: 300,
      color: "#ff00b8",
      weight: 3,
      opacity: 0.8,
      fillOpacity: 0.10,
      fillColor: "#ffe84a"
    }).addTo(map);

    const el = ring.getElement();
    if (el){
      gsap.fromTo(el, {opacity: 0.8}, {opacity:0, duration:1.5, ease:"power2.out", onComplete: ()=> map.removeLayer(ring)});
    }else{
      setTimeout(()=> map.removeLayer(ring), 1500);
    }
  }

  function addGunBurst(lat, lng){
    const m = L.marker([lat,lng], {
      icon: L.divIcon({ className:"", html:`<div class="burst"></div>` }),
      interactive: false
    }).addTo(map);

    const node = m.getElement();
    if (node){
      gsap.fromTo(node, {scale:0.8, opacity:0}, {scale:1.2, opacity:1, duration:0.12});
      gsap.to(node, {scale:1.8, opacity:0, duration:0.45, ease:"power2.out", onComplete: ()=> map.removeLayer(m)});
    }else{
      setTimeout(()=> map.removeLayer(m), 500);
    }
  }

  // -------- Radar scope
  const radar = $("#radar");
  const rctx = radar.getContext("2d");
  const RAD = { sweepDeg: 0 };
  let __radarW = 0, __radarH = 0, __radarDPR = 1;
  function resizeRadarCanvas(){
    const stage = radar?.parentElement;
    if (!stage) return;
    const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.floor(stage.clientWidth));
    const h = Math.max(1, Math.floor(stage.clientHeight));
    if (w === __radarW && h === __radarH && dpr === __radarDPR) return;
    __radarW = w; __radarH = h; __radarDPR = dpr;
    radar.width = Math.floor(w * dpr);
    radar.height = Math.floor(h * dpr);
    // reset transform so draw coords are in CSS pixels
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }


  function latLngToRadar(lat, lng, center){
    const lat0 = center.lat, lng0 = center.lng;
    const kx = Math.cos(lat0 * Math.PI/180);
    const dx = (lng - lng0) * kx;
    const dy = (lat - lat0);
    const scale = 9000; // arbitrary normalization
    return { dx: dx * scale, dy: dy * scale };
  }

  function drawRadarFrame(W, H){
    const cx = W/2, cy = H/2;
    rctx.save();
    // phosphor persistence fade
    rctx.fillStyle = "rgba(0,0,0,0.12)";
    rctx.fillRect(0,0,W,H);

    rctx.strokeStyle = "rgba(40,215,255,0.18)";
    rctx.lineWidth = 2;

    const rMax = Math.min(W,H)*0.44;
    for (let r = rMax*0.25; r <= rMax; r += rMax*0.25){
      rctx.beginPath();
      rctx.arc(cx, cy, r, 0, Math.PI*2);
      rctx.stroke();
    }
    rctx.beginPath();
    rctx.moveTo(cx, 18); rctx.lineTo(cx, H-18);
    rctx.moveTo(18, cy); rctx.lineTo(W-18, cy);
    rctx.stroke();
    rctx.restore();
  }

  function drawRadarSweep(W,H){
    const cx=W/2, cy=H/2;
    const rMax = Math.min(W,H)*0.46;

    RAD.sweepDeg = (RAD.sweepDeg + 5.2) % 360; // fast sweep
    const a = RAD.sweepDeg * Math.PI/180;

    const ex = cx + Math.cos(a)*rMax;
    const ey = cy + Math.sin(a)*rMax;

    rctx.strokeStyle = "rgba(255,0,184,0.62)";
    rctx.lineWidth = 4;
    rctx.beginPath();
    rctx.moveTo(cx,cy);
    rctx.lineTo(ex,ey);
    rctx.stroke();

    const cone = 0.20;
    const g = rctx.createRadialGradient(cx,cy,0,cx,cy,rMax);
    g.addColorStop(0,"rgba(255,0,184,0.10)");
    g.addColorStop(1,"rgba(255,0,184,0)");
    rctx.fillStyle = g;

    rctx.beginPath();
    rctx.arc(cx,cy,rMax, a-cone, a+cone);
    rctx.lineTo(cx,cy);
    rctx.closePath();
    rctx.fill();
  }

  function roundRect(ctx,x,y,w,h,r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr);
    ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr);
    ctx.arcTo(x,y,x+w,y,rr);
    ctx.closePath();
  }

  function drawBlip(x,y,side,txt,showLabel,dangerLabel){
    const col = side === "RAF" ? "40,215,255" : "255,0,184";
    rctx.fillStyle = `rgba(${col},0.92)`;
    rctx.beginPath();
    rctx.arc(x,y,3.6,0,Math.PI*2);
    rctx.fill();

    rctx.fillStyle = `rgba(${col},0.14)`;
    rctx.beginPath();
    rctx.arc(x,y,10,0,Math.PI*2);
    rctx.fill();

    if (showLabel){
      rctx.font = "14px ui-monospace, Menlo, Consolas, monospace";
      const pad = 8;
      const w = rctx.measureText(txt).width + pad*2;
      const h = 22;
      const lx = x + 10;
      const ly = y - 26;

      rctx.fillStyle = dangerLabel ? "rgba(60,0,18,0.55)" : "rgba(0,0,0,0.45)";
      roundRect(rctx, lx, ly, w, h, 11);
      rctx.fill();
      rctx.strokeStyle = dangerLabel ? "rgba(255,0,0,0.65)" : "rgba(255,255,255,0.16)";
      rctx.lineWidth = 2;
      roundRect(rctx, lx, ly, w, h, 11);
      rctx.stroke();

      rctx.fillStyle = dangerLabel ? "rgba(255,80,120,0.95)" : "rgba(255,247,255,0.88)";
      rctx.fillText(txt, lx + pad, ly + 15);
    }
  }

  // -------- Replay engine
  let running = true;
  let speed = 10;
  let t = 0;
  let lastTs = performance.now();

  let eventsFired = new Set();
  let counts = { engagements: 0, kills: 0, losses: 0 };

  // Precompute target death times from kill events
  let deathTimes = new Map();
  function buildDeathTimes(){
    deathTimes = new Map();
    const evs = (MISSION?.events || []);
    for (const ev of evs){
      if (ev.type === 'kill' && ev.target){
        const prev = deathTimes.get(ev.target);
        if (prev == null || ev.t < prev) deathTimes.set(ev.target, ev.t);
      }
    }
  }


  function escapeHtml(str){
    return String(str ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#39;");
  }

  function pushLog(ev, now){
    const line = document.createElement("div");
    line.className = "logLine";
    const typeClass = ev.type === "contact" ? "tContact" :
                      ev.type === "engagement" ? "tEngage" :
                      ev.type === "kill" || ev.type === "impact" ? "tKill" :
                      ev.type === "loss" ? "tLoss" : "tNote";

    line.innerHTML = `
      <div><span class="logTime">${fmtClock(now)}</span>
      <span class="logType ${typeClass}">${String(ev.type || "").toUpperCase()}</span></div>
      <div class="logText">text</div>
    `;

    elTimeline.prepend(line);
    elStatLast.textContent = `${fmtClock(now)} ${String(ev.type || "").toUpperCase()}: text`;
    gsap.fromTo(line, {y: 10, opacity: 0}, {y: 0, opacity: 1, duration: 0.22, ease: "power2.out"});
  }

  function fireEvent(ev, now){
    pushLog(ev, now);

    if (ev.type === "engagement"){
      counts.engagements++;
      const a = aircraftState.get(ev.actor);
      const p = a?.lastPos;
      if (p) addGunBurst(p.lat, p.lng);
    }

    if (ev.type === "kill"){
      counts.kills++;
      const tgt = aircraftState.get(ev.target);
      if (tgt) tgt.dead = true;
      const a = aircraftState.get(ev.actor);
      const p = a?.lastPos;
      if (p) addGunBurst(p.lat, p.lng);
    }

    if (ev.type === "impact" && typeof ev.lat === "number" && typeof ev.lng === "number"){
      addImpact(ev.lat, ev.lng);
    }

    if (ev.type === "loss"){
      counts.losses++;
      elLossesChip.textContent = `LOSSES: ${counts.losses}`;
    }
  }

  function updateMap(now){
    const showTrails = !!elTrails.checked;
    const showLabels = !!elLabels.checked;

    for (const [id, st] of aircraftState.entries()){
      if (st.dead) {
  const me = st.marker.getElement();
  const le = st.label.getElement();
  if (me) me.style.opacity = "0.20";
  if (le) le.style.opacity = "0.0";
  if (st.routeAllLine) st.routeAllLine.setStyle({ opacity: 0.10 });
  st.trailLine.setStyle({ opacity: 0.18 });
  continue;
}

      const pos = interpPath(st.cfg.path, now);
      if (!pos) continue;
      st.lastPos = pos;

      st.marker.setLatLng([pos.lat, pos.lng]);
      st.label.setLatLng([pos.lat, pos.lng]);

      const node = st.marker.getElement();
      if (node){
        const glyph = node.querySelector(".planeGlyph");
        if (glyph) glyph.style.setProperty("--hdg", `${pos.hdg}deg`);
      }

      const lnode = st.label.getElement();
      if (lnode){
        lnode.style.opacity = showLabels ? "1" : "0";
        const dt = deathTimes.get(st.cfg.id);
        const imminent = (typeof dt === "number") && now >= (dt - 3) && now < dt && !st.dead;
        const inner = lnode.querySelector(".planeLabel");
        if (inner) inner.classList.toggle("danger", imminent);
}

      if (showTrails){
  // Ensure the full (dashed) route is visible
  if (st.routeAllLine) st.routeAllLine.setStyle({ opacity: 0.18 });

  // Append any newly reached path points to the traveled history
  const path = st.cfg.path || [];
  let idx = st.pathIdx || 0;

  while (idx < path.length && path[idx].t <= now){
    st.trailPts.push([path[idx].lat, path[idx].lng]);
    idx++;
  }
  st.pathIdx = idx;

  // Always include current interpolated position as the last point (smooth head)
  const pts = st.trailPts.length ? st.trailPts.slice() : [];
  pts.push([pos.lat, pos.lng]);

  st.trailLine.setLatLngs(pts);
  st.trailLine.setStyle({ opacity: 0.62 });
}else{
  // Hide both route lines when trails are off
  st.trailLine.setLatLngs([]);
  if (st.routeAllLine) st.routeAllLine.setStyle({ opacity: 0 });
}
    }

    // Keep the map centered (throttled) if FOLLOW is enabled
    maybeFollowMap();
  }

  function updateRadar(now){
    resizeRadarCanvas();
    const W = __radarW, H = __radarH;
    const c = MISSION.center || {lat: 51.505, lng: -0.09};
    const cx = W/2, cy = H/2;
    const rMax = Math.min(W,H)*0.46;

    drawRadarFrame(W,H);
    drawRadarSweep(W,H);

    let contacts = 0;

    for (const [id, st] of aircraftState.entries()){
      if (st.dead) continue;
      const p = st.lastPos || interpPath(st.cfg.path, now);
      if (!p) continue;
      const v = latLngToRadar(p.lat, p.lng, c);

      const sx = cx + (v.dx * 0.04);
      const sy = cy - (v.dy * 0.04);

      const dx = sx - cx, dy = sy - cy;
      const d = Math.hypot(dx, dy);
      if (d > rMax) continue;

      contacts++;
      const dt = deathTimes.get(st.cfg.id);
      const imminent = (typeof dt === 'number') && now >= (dt - 3) && now < dt && !st.dead;
      drawBlip(sx, sy, st.cfg.side, st.cfg.callsign, !!elLabels.checked, imminent);
    }

    elHudContacts.textContent = String(contacts);
    elHudEng.textContent = String(counts.engagements);
    elHudKills.textContent = String(counts.kills);
    elStatTracks.textContent = String(contacts);

    const blitz = clamp((counts.engagements*6 + counts.kills*10 + counts.losses*8) / 60, 0.08, 1);
    elMeterBlitz.style.width = `${Math.round(blitz*100)}%`;
  }

  function updateEvents(now){
    const evs = MISSION.events || [];
    for (let i=0;i<evs.length;i++){
      const ev = evs[i];
      const key = `${ev.type}:${ev.t}:${ev.actor || ""}:${ev.target || ""}`;
      if (eventsFired.has(key)) continue;
      if (now >= ev.t){
        eventsFired.add(key);
        fireEvent(ev, now);
      }
    }
  }

  function tick(ts){
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;

    if (running){
      t += dt * speed;
      const dur = (MISSION.duration_s || 120);
      if (t > dur) t = dur;

      // AUTO_RESTART: loop the replay
      if (t >= dur){
        // small hold at end so "END" is visible
        if (!window.__endHoldAt) window.__endHoldAt = ts;
        const held = (ts - window.__endHoldAt) / 1000;
        if (held >= 0.8){
          window.__endHoldAt = null;
          restart();
          t = 0;
        }
      }

      elClock.textContent = fmtClock(t);

      updateMap(t);
      updateEvents(t);
      updateRadar(t);

      elHudStatus.textContent = t >= (MISSION.duration_s || 120) ? "END" : "ARMED";
    }

    requestAnimationFrame(tick);
  }

  function setRunning(v){ running = v; }

  function restart(){
    t = 0;
    eventsFired.clear();
    counts = { engagements: 0, kills: 0, losses: 0 };
    elLossesChip.textContent = "LOSSES: 0";
    elActiveChip.textContent = "ACTIVE: NONE";
    elStatSel.textContent = "NONE";
    selectedId = null;

    for (const [id, st] of aircraftState.entries()){
      st.dead = false;
      st.trailPts = [];
      st.pathIdx = 0;
      st.trailLine.setLatLngs([]);
      if (st.routeAllLine) st.routeAllLine.setStyle({ opacity: (elTrails && elTrails.checked) ? 0.18 : 0 });
      const pos = interpPath(st.cfg.path, 0) || st.lastPos;
      if (pos){
        st.lastPos = pos;
        st.marker.setLatLng([pos.lat, pos.lng]);
        st.label.setLatLng([pos.lat, pos.lng]);
      }
      const node = st.marker.getElement();
      const lnode = st.label.getElement();
      if (node) node.style.opacity = "1";
      if (lnode) lnode.style.opacity = "1";
    }

    elTimeline.innerHTML = "";
    elStatLast.textContent = "—";
  }

  function wireControls(){
    elBtnPlay.addEventListener("click", ()=> setRunning(true));
    elBtnPause.addEventListener("click", ()=> setRunning(false));
    elBtnRestart.addEventListener("click", ()=> { restart(); setRunning(true); });

    elSpeed.addEventListener("input", ()=>{
      speed = Number(elSpeed.value || 10);
      elSpeedLabel.textContent = `${speed}x`;
    });

    
    if (elFollow){
      elFollow.addEventListener("change", ()=>{
        __followJustEnabled = !!elFollow.checked;
        if (!elFollow.checked) __followZoomTarget = null;
      });
    }

elCRT.addEventListener("change", ()=>{
      document.body.classList.toggle("crt", !!elCRT.checked);
    });
    document.body.classList.toggle("crt", !!elCRT.checked);
  }

  async function boot(){
    window.__MISSION_FALLBACK__ = {
      meta: { title: "Fallback mission" },
      duration_s: 120,
      center: { lat: 51.505, lng: -0.09 },
      aircraft: [
        { id:"ELIZABETH", callsign:"BENNET-01", side:"RAF", path:[
          {t:0, lat:51.47, lng:-0.32}, {t:40, lat:51.52, lng:-0.17}, {t:90, lat:51.51, lng:0.02}, {t:120, lat:51.49, lng:-0.04}
        ]},
        { id:"GOTHA-1", callsign:"KRAUT-17", side:"ENEMY", path:[
          {t:0, lat:51.60, lng:-0.38}, {t:65, lat:51.53, lng:-0.12}
        ]}
      ],
      events: [
        {t:10, type:"contact", text:"CONTACTS DETECTED: NW sector"},
        {t:30, type:"engagement", actor:"ELIZABETH", target:"GOTHA-1", text:"ELIZABETH opens fire."},
        {t:66, type:"kill", actor:"ELIZABETH", target:"GOTHA-1", text:"TARGET DESTROYED."},
        {t:66.2, type:"impact", lat:51.532, lng:-0.120, text:"IMPACT recorded."}
      ]
    };

    const mission = await loadMission();

    buildDeathTimes();

    const title = mission?.meta?.title || "MISSION";
    const sector = mission?.meta?.sector || "SECTOR";
    pushLog({type:"note", text:`${title} • ${sector} • Replay initialized.`}, 0);

    initMap(mission);
    wireControls();

    resizeRadarCanvas();
    window.addEventListener("resize", resizeRadarCanvas);


    speed = Number(elSpeed.value || 10);
    elSpeedLabel.textContent = `${speed}x`;

    selectAircraft("ELIZABETH");

    requestAnimationFrame((ts)=>{ lastTs = ts; tick(ts); });
  }

  boot().catch(err=>{
    console.error(err);
    elHudStatus.textContent = "ERROR";
    pushLog({type:"loss", text:"Console failed to boot. Open DevTools for details."}, 0);
  });
})();
