// ---- Google Drive sync: one JSON file in the app's hidden Drive folder, shared by every device you connect ----
// Every saved value is split into small parts (a tick, a task's sessions, a done date, a plan edit…). Each part gets a
// timestamp when it changes on this device; when two devices disagree, the newer change wins, part by part, so a tick on
// the phone and a time entry on the laptop both survive. A device that has never synced counts all its parts as oldest,
// so joining a new device never overwrites what's already in Drive.
(function(){
  // Google OAuth client "Exam Prep Map site" in Cloud project leafy-galaxy-454521-j5 (origins: ylp-games.github.io, localhost:8417)
  const CLIENT_ID = "52589181701-qnqgrgs1m5qd8d08bibffs2gbq9c72us.apps.googleusercontent.com";
  const FILE = "exam-prep-map-sync.json";
  const SYNC_KEYS = ["epm-done","epm-watch","epm-tut","epm-sessions","epm-donedate","epm-edits","epm-dd-applied",
                     "epm-course","epm-sortc","epm-kind","epm-hidedone","epm-phase-view"];
  const ARR = new Set(["epm-done","epm-dd-applied"]), OBJ = new Set(["epm-watch","epm-tut","epm-sessions","epm-donedate","epm-edits"]);
  const SEP = "\u0001";
  const ls = {
    get(k){ try { const v = localStorage.getItem(k); return v === null ? undefined : JSON.parse(v); } catch(e) { return undefined; } },
    set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} },
  };
  // a saved value as {part: value}: list items, object keys, or one "" part for a plain setting
  const toMap = (k, v) => v === undefined || v === null ? {} :
    ARR.has(k) ? Object.fromEntries((Array.isArray(v) ? v : []).map(x=>[String(x), true])) :
    OBJ.has(k) ? (typeof v === "object" && !Array.isArray(v) ? v : {}) : {"": v};
  const fromMap = (k, m) => ARR.has(k) ? Object.keys(m) : OBJ.has(k) ? m : m[""];
  // compare values ignoring the order of keys and of list items, so a reorder never counts as a change
  const canon = v => Array.isArray(v) ? "[" + v.map(canon).sort().join(",") + "]" :
    v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);

  const stamps = ls.get("epm-stamps") || {};
  // called by the page just before it saves anything
  window.epmBeforeSet = (k, v) => {
    if (!SYNC_KEYS.includes(k) || !ls.get("epm-sync-joined")) return;
    const a = toMap(k, ls.get(k)), b = toMap(k, v), now = Date.now(); let ch = false;
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(s=>{
      if (JSON.stringify(a[s]) !== JSON.stringify(b[s])) { stamps[k + SEP + s] = now; ch = true; }
    });
    if (ch) { ls.set("epm-stamps", stamps); schedulePush(); }
  };

  function snapshot(){
    const data = {};
    SYNC_KEYS.forEach(k=>{ const v = ls.get(k); if (v !== undefined) data[k] = toMap(k, v); });
    return {v: 1, data, stamps: {...stamps}};
  }
  function merge(L, R){
    const out = {v: 1, data: {}, stamps: {}};
    SYNC_KEYS.forEach(k=>{
      const lm = L.data[k] || {}, rm = R.data[k] || {}, m = {};
      const parts = new Set([...Object.keys(lm), ...Object.keys(rm)]);
      [L.stamps, R.stamps].forEach(st=>Object.keys(st).forEach(ck=>{ if (ck.startsWith(k + SEP)) parts.add(ck.slice(k.length + 1)); }));
      parts.forEach(s=>{
        const ck = k + SEP + s, lt = L.stamps[ck] || 0, rt = R.stamps[ck] || 0, inL = s in lm, inR = s in rm;
        const useR = rt !== lt ? rt > lt : (inR || !inL);      // same age: Drive's copy, unless only this device has it
        if (useR ? inR : inL) m[s] = useR ? rm[s] : lm[s];
        if (Math.max(lt, rt)) out.stamps[ck] = Math.max(lt, rt);
      });
      if (Object.keys(m).length || k in L.data || k in R.data) out.data[k] = m;
    });
    return out;
  }
  // write the merged result into this browser; true if anything changed
  function applyLocal(M){
    let changed = false;
    SYNC_KEYS.forEach(k=>{
      if (!(k in M.data)) return;
      const v = fromMap(k, M.data[k]);
      if (v === undefined) return;
      if (canon(v) !== canon(ls.get(k))) { ls.set(k, v); changed = true; }
    });
    Object.keys(stamps).forEach(ck=>delete stamps[ck]); Object.assign(stamps, M.stamps); ls.set("epm-stamps", stamps);
    return changed;
  }

  // ---- Drive ----
  let token = null, tokenExp = 0, fileId = ls.get("epm-drive-file") || null, tokenClient = null;
  const saved = ls.get("epm-drive-token");
  if (saved && saved.exp > Date.now()) { token = saved.t; tokenExp = saved.exp; }
  const live = () => token && Date.now() < tokenExp;
  async function api(url, opts = {}){
    const r = await fetch(url, {...opts, headers: {...(opts.headers || {}), Authorization: "Bearer " + token}});
    if (r.status === 401) { token = null; ls.set("epm-drive-token", null); throw new Error("auth"); }
    if (!r.ok) throw Object.assign(new Error("Drive " + r.status), {status: r.status});
    return r;
  }
  async function findFile(){
    if (fileId) return fileId;
    const q = encodeURIComponent(`name='${FILE}'`);
    const j = await (await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)&orderBy=modifiedTime desc`)).json();
    fileId = (j.files && j.files[0] && j.files[0].id) || null;
    if (fileId) ls.set("epm-drive-file", fileId);
    return fileId;
  }
  async function readRemote(){
    const id = await findFile(); if (!id) return null;
    try { return await (await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json(); }
    catch(e) { if (e.status === 404) { fileId = null; ls.set("epm-drive-file", null); return readRemote(); } throw e; }
  }
  async function writeRemote(obj){
    const body = JSON.stringify(obj), id = await findFile();
    if (id) {
      await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {method: "PATCH", headers: {"Content-Type": "application/json"}, body});
      return;
    }
    const b = "epm" + Date.now(), meta = JSON.stringify({name: FILE, parents: ["appDataFolder"]});
    const r = await api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST", headers: {"Content-Type": `multipart/related; boundary=${b}`},
      body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`});
    fileId = (await r.json()).id; ls.set("epm-drive-file", fileId);
  }

  // ---- syncing ----
  let busy = false, again = false, pushTimer = null, lastOk = null;
  function schedulePush(){ clearTimeout(pushTimer); pushTimer = setTimeout(sync, 1500); }
  async function sync(){
    if (!live()) { showState(); return; }
    if (busy) { again = true; return; }
    busy = true; showState("Syncing…");
    try {
      const remote = (await readRemote()) || {v: 1, data: {}, stamps: {}};
      const merged = merge(snapshot(), remote);
      const changed = applyLocal(merged);
      if (canon(merged) !== canon({v: 1, data: remote.data || {}, stamps: remote.stamps || {}})) await writeRemote(merged);
      ls.set("epm-sync-joined", true);
      lastOk = new Date();
      if (changed) reloadSoon();
    } catch(e) { console.warn("Drive sync:", e); }
    busy = false; showState();
    if (again) { again = false; sync(); }
  }
  // changes from another device: reload to show them, keeping your place (not while you're typing)
  function reloadSoon(){
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) {
      a.addEventListener("blur", reloadSoon, {once: true}); return;
    }
    try { sessionStorage.setItem("epm-scroll", String(window.scrollY)); } catch(e) {}
    location.reload();
  }

  function showState(text){
    const b = document.getElementById("drivebtn"); if (!b) return;
    if (!CLIENT_ID) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = text || (live() ? (lastOk ? "Synced " + lastOk.toTimeString().slice(0,5) : "Drive connected")
                                    : ls.get("epm-drive-on") ? "Reconnect Drive" : "Connect Drive");
    b.setAttribute("aria-pressed", live() ? "true" : "false");
  }
  function connect(){
    if (!tokenClient) {
      if (!(window.google && google.accounts && google.accounts.oauth2)) { showState("Google didn't load, try again"); return; }
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: "https://www.googleapis.com/auth/drive.appdata",
        callback: resp => {
          if (resp.error) { showState("Couldn't connect"); return; }
          token = resp.access_token; tokenExp = Date.now() + (resp.expires_in - 60) * 1000;
          ls.set("epm-drive-token", {t: token, exp: tokenExp}); ls.set("epm-drive-on", true);
          sync();
        },
      });
    }
    tokenClient.requestAccessToken({prompt: ls.get("epm-drive-on") ? "" : "consent"});
  }

  if (window.__epmSyncTest) window.__epmSyncTest({merge, snapshot, applyLocal, stamps});   // test harness hook only

  window.addEventListener("DOMContentLoaded", ()=>{
    const b = document.getElementById("drivebtn");
    if (b) b.addEventListener("click", ()=> live() ? sync() : connect());
    try { const y = sessionStorage.getItem("epm-scroll"); if (y !== null) { sessionStorage.removeItem("epm-scroll"); setTimeout(()=>window.scrollTo(0, +y), 0); } } catch(e) {}
    showState();
    if (!CLIENT_ID) return;
    const g = document.createElement("script"); g.src = "https://accounts.google.com/gsi/client"; g.async = true; document.head.appendChild(g);
    if (live()) sync();
    // pick up the other device's changes: when you come back to the page, and every 15 s while it's open
    document.addEventListener("visibilitychange", ()=>{ if (document.visibilityState === "visible") sync(); else if (pushTimer) { clearTimeout(pushTimer); sync(); } });
    setInterval(()=>{ if (document.visibilityState === "visible") sync(); else showState(); }, 15000);
  });
})();
