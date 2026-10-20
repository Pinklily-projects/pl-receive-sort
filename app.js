/* Pink Lily Receive & Sort — scan PO → (pallet shown) → SKU (→ Size) → Qty, save locally, bulk upload to ShipHero.
 *
 * Sorting: the moment a PO is recognized, the app asks the shared truck-session backend (the same
 * Supabase project + assign_pallet function the PO Sort app uses) which staging pallet it goes on,
 * and shows the number in a big sticky banner while the receiver keeps scanning SKUs and quantities.
 * Pallet lookup runs in the background, so it never slows down receiving; if it fails the receiver can
 * keep scanning and tap Retry.
 *
 * On start the app preloads every open (pending) PO with its lines, so scanning a PO is instant.
 *
 * Upload = for each PO + location group ("batch"):
 *   1. inventory_add each line into the scanned location. Every add carries a unique tag in its
 *      reason, e.g. "PL Receiving · PO 1105736 · Receiving · JD [PLR-k3x9a1b2c3.4]".
 *   2. purchase_order_update to add the same quantities to Quantity received.
 * Each step's state is saved on the device before and after it runs. If a result is unknown
 * (dropped connection, server error, app closed), nothing is resent blindly:
 *   - an inventory add is checked in ShipHero's inventory history by its tag
 *   - the PO update is checked against a before-snapshot of quantity_received
 *     (all == before + qty → done · all == before → resend · otherwise → manual review)
 */
(function () {
  "use strict";

  const STORE_KEY = "plrs.v1"; // separate from the old Receiving app so both can run on one device
  const API = "/api/shiphero";
  const MAX_QTY = 9999;
  const HISTORY_DAYS = 30;
  const CACHE_FRESH_MS = 2 * 3600e3;   // a preloaded PO is used instantly if younger than this
  const RESYNC_MS = 30 * 60e3;          // re-pull open POs every 30 min while the app is open

  // ---------------------------------------------------------------- storage
  const blank = () => ({
    pos: {}, scans: [], batches: [], poLoc: {}, locs: {}, open: { keys: [], at: 0 }, truck: null, palletMap: {},
    settings: { pin: "", receiver: "", sound: true }, defaultLoc: "Receiving",
  });
  let S = load();
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return blank();
      const s = Object.assign(blank(), JSON.parse(raw));
      s.settings = Object.assign(blank().settings, s.settings || {});
      return s;
    } catch (e) { return blank(); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
    catch (e) { say("err", "Could not save on this device (storage full or blocked). Upload now."); }
  }
  function prune() {
    const cutoff = Date.now() - HISTORY_DAYS * 864e5;
    S.batches = S.batches.filter((b) => b.state !== "done" || b.ts > cutoff);
    const live = new Set(S.scans.map((x) => x.po)
      .concat(S.batches.filter((b) => b.state !== "done").map((b) => b.po))
      .concat(S.open.keys));
    if (cur.po) live.add(cur.po); // prune only runs after boot, so cur exists
    for (const k of Object.keys(S.pos)) if (!live.has(k)) delete S.pos[k];
    for (const k of Object.keys(S.poLoc)) if (!live.has(k)) delete S.poLoc[k];
    for (const k of Object.keys(S.palletMap)) if (!S.truck || k !== S.truck.id) delete S.palletMap[k];
  }

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const norm = (v) => String(v || "").trim().toUpperCase();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let audioCtx = null;
  function beep(kind) {
    if (!S.settings.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === "ok" ? [880] : kind === "save" ? [880, 1320] : [220, 180];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = kind === "err" ? "square" : "sine"; o.frequency.value = f;
        g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination);
        const t = audioCtx.currentTime + i * 0.11;
        o.start(t); o.stop(t + (kind === "err" ? 0.22 : 0.09));
      });
    } catch (e) {}
    if (kind === "err" && navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }

  function say(kind, text) {
    const m = $("msg");
    m.className = "msg" + (kind ? " " + kind : "");
    m.textContent = text;
  }

  class ApiError extends Error {
    constructor(msg, status, network, retryAfter) { super(msg); this.status = status; this.network = !!network; this.retryAfter = retryAfter; }
  }
  async function api(action, payload, opts) {
    const tries = (opts && opts.retries) || 0;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-app-pin": S.settings.pin || "" },
          body: JSON.stringify(Object.assign({ action }, payload || {})),
        });
      } catch (e) {
        throw new ApiError("No connection to the server.", 0, true);
      }
      let body = null;
      try { body = await res.json(); } catch (e) {}
      if (res.status === 401) { openSettings("Enter the app PIN to connect."); throw new ApiError("App PIN needed.", 401); }
      if (res.status === 429 && attempt < tries) { await sleep(Math.min(((body && body.retry_after) || 5) + 1, 90) * 1000); continue; }
      if (!res.ok) throw new ApiError((body && body.error) || `Server error (HTTP ${res.status}).`, res.status, false, body && body.retry_after);
      return body;
    }
  }

  // ---------------------------------------------------------------- PO data
  function lineFor(po, code) {
    const c = norm(code);
    if (!po || !c) return null;
    return po.lines.find((l) => norm(l.sku) === c)
      || po.lines.find((l) => l.barcode && norm(l.barcode) === c)
      || po.lines.find((l) => l.vendor_sku && norm(l.vendor_sku) === c)
      || null;
  }
  // ---- split labels: base SKU barcode + separate size barcode
  const compact = (v) => norm(v).replace(/[\s\-_.\/]/g, "");
  const SIZE_ALIASES = {
    XXSMALL: "XXS", "2XS": "XXS", XSMALL: "XS", EXTRASMALL: "XS", XSM: "XS",
    SMALL: "S", SM: "S", SML: "S", MEDIUM: "M", MED: "M", MD: "M", LARGE: "L", LG: "L", LRG: "L", LAR: "L", SMA: "S",
    XLARGE: "XL", EXTRALARGE: "XL", XLG: "XL", XXL: "2XL", XXLARGE: "2XL", XXXL: "3XL",
    "1XL": "1X", ONESIZE: "OS", OSFA: "OS", ONE: "OS",
  };
  function canonSize(v) {
    let s = compact(v);
    if (/^\d+$/.test(s)) s = String(parseInt(s, 10)); // "08" → "8"
    return SIZE_ALIASES[s] || s;
  }
  function baseCandidates(po, code) {
    const b = compact(code);
    if (!po || b.length < 2) return [];
    return po.lines.filter((l) => { const c = compact(l.sku); return c.length > b.length && c.startsWith(b); });
  }
  const sizeOf = (line, base) => compact(line.sku).slice(compact(base).length);
  function resolveSize(base, cands, sizeRaw) {
    const want = canonSize(sizeRaw);
    if (!want) return [];
    let hits = cands.filter((l) => canonSize(sizeOf(l, base)) === want);
    if (!hits.length) hits = cands.filter((l) => l.option_title && canonSize(l.option_title) === want);
    if (!hits.length) hits = cands.filter((l) => { const t = String(l.name || "").split("—").pop(); return t && canonSize(t) === want; });
    return hits;
  }

  const ACTIVE = new Set(["queued", "sending", "unknown", "review"]);
  function pendingQty(poKey, sku) {
    const s = norm(sku);
    let n = 0;
    for (const x of S.scans) if (x.po === poKey && norm(x.sku) === s) n += x.qty;
    // units in a batch whose PO step hasn't been confirmed yet
    for (const b of S.batches) if (b.po === poKey && ACTIVE.has(b.state) && b.poStep !== "done")
      for (const l of b.lines) if (norm(l.sku) === s) n += l.qty;
    return n;
  }
  // FAI: lines whose product has no weight/dimensions in ShipHero and still have units to receive
  const faiLines = (po) => (po && po.lines ? po.lines.filter((l) => l.fai && l.received < l.ordered) : []);
  const onHold = (key) => faiLines(S.pos[key]).length > 0;

  function applyPO(po) {
    const key = norm(po.po_number);
    S.pos[key] = Object.assign({}, po, { fetchedAt: Date.now() });
    return key;
  }

  // ---------------------------------------------------------------- open-PO preload
  let syncing = false;
  async function syncOpenPOs(manual) {
    if (syncing) return;
    syncing = true;
    $("btn-sync").classList.add("busy");
    const keys = [];
    let after = null, page = 0;
    try {
      do {
        $("sync-status").textContent = `Loading open POs… ${keys.length}`;
        const r = await api("openPOs", { after }, { retries: 4 });
        for (const po of r.pos) {
          const k = norm(po.po_number);
          // don't clobber a fuller copy fetched by a scan (POs with >100 lines)
          if (po.complete === false && S.pos[k] && S.pos[k].complete !== false) { S.pos[k].fetchedAt = Date.now(); }
          else applyPO(po);
          keys.push(k);
        }
        after = r.next; page++;
        if (after) await sleep(800); // be gentle with the shared ShipHero credit pool
      } while (after && page < 40);
      S.open = { keys, at: Date.now() };
      prune(); save();
      renderOpenList();
      if (manual) say("ok", `Loaded ${keys.length} open POs.`);
    } catch (e) {
      $("sync-status").textContent = S.open.at ? `Open POs: ${S.open.keys.length} (sync failed)` : "Open POs: couldn't load";
      if (manual) say("warn", `Couldn't load open POs: ${e.message}`);
    } finally {
      syncing = false;
      $("btn-sync").classList.remove("busy");
    }
  }
  function renderOpenList() {
    const n = S.open.keys.length;
    $("sync-status").textContent = S.open.at
      ? `${n} open PO${n === 1 ? "" : "s"} · ${new Date(S.open.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Open POs: —";
    const keys = S.open.keys.slice().sort((a, b) => faiLines(S.pos[b]).length - faiLines(S.pos[a]).length);
    $("open-pos").innerHTML = keys.map((k) => {
      const p = S.pos[k]; if (!p) return "";
      const n = faiLines(p).length;
      return `<option value="${esc(p.po_number)}">${n ? `FAI (${n}) · ` : ""}${esc(p.vendor || "")}</option>`;
    }).join("");
    renderFaiList();
  }

  function renderFaiList() {
    const list = S.open.keys.map((k) => S.pos[k]).filter((p) => p && faiLines(p).length)
      .sort((a, b) => faiLines(b).length - faiLines(a).length);
    $("fai-wrap").hidden = !list.length;
    $("fai-count").textContent = list.length;
    $("fai-list").innerHTML = list.map((p) => `<li><button class="link" data-fai-po="${esc(p.po_number)}">PO ${esc(p.po_number)}</button>
      <span>${faiLines(p).length} SKU${faiLines(p).length > 1 ? "s" : ""} need FAI · ${esc(p.vendor || "")}</span></li>`).join("");
  }


  // ---------------------------------------------------------------- sorting (truck session + pallets)
  const SC = window.PL_SORT_CONFIG || {};
  const SORT_ON = !!(SC.supabaseUrl && SC.supabaseAnonKey);
  const RESET_PIN = String(SC.resetPin || "0901");
  const TRUCK_POLL_MS = 15000, PALLET_POLL_MS = 8000;

  async function sb(path, opts) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    try {
      const res = await fetch(`${SC.supabaseUrl.replace(/\/+$/, "")}/rest/v1/${path}`, Object.assign({
        headers: { apikey: SC.supabaseAnonKey, Authorization: `Bearer ${SC.supabaseAnonKey}`, "Content-Type": "application/json" },
        signal: ctl.signal,
      }, opts || {}));
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError((body && (body.message || body.error)) || `Sort server error (HTTP ${res.status}).`, res.status);
      return body;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("No connection to the sort server.", 0, true);
    } finally { clearTimeout(t); }
  }
  const rpc = (fn, params) => sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(params || {}) });

  // ---- truck session
  async function loadTruck() {
    if (!SORT_ON) return;
    try {
      const rows = await rpc("current_truck_session");
      const t = (rows && rows[0]) || null;
      const changed = (t && t.id) !== (S.truck && S.truck.id);
      S.truck = t; save();
      renderTruck();
      if (changed && cur.pallet && cur.pallet.kind !== "none") { cur.pallet = null; renderPallet(); }
      if (activeTab === "pallets") renderPalletList();
    } catch (e) { renderTruck(true); }
  }
  function renderTruck(stale) {
    const t = S.truck, bar = $("truck-bar");
    bar.classList.toggle("no-truck", !t);
    $("truck-label").textContent = t ? `Truck: ${t.label}` : (SORT_ON ? "No truck in progress — pallets need a truck" : "Pallet sorting not configured");
    $("truck-used").textContent = t ? `${Math.min(t.next_pallet - 1, t.pallet_capacity)} / ${t.pallet_capacity} pallets${stale ? " · offline" : ""}` : "";
    $("btn-truck").textContent = t ? "New Truck" : "Start Truck";
    $("btn-truck").hidden = !SORT_ON;
  }
  async function startTruck() {
    if (S.truck) {
      const code = window.prompt("A truck is in progress. Enter the 4-digit code to start a new one:", "");
      if (code === null) return;
      if (code.trim() !== RESET_PIN) { beep("err"); say("err", "Wrong code — truck was not reset."); return; }
    }
    const label = window.prompt('Label this truck (e.g. "10/20 AM - Dock 2"), or leave blank:', "");
    if (label === null) return;
    try {
      await rpc("start_truck_session", { p_label: label, p_started_by: S.settings.receiver || "" });
      S.truck = null; await loadTruck();
      cur.pallet = null; renderPallet();
      beep("ok"); say("ok", `Truck started${S.truck ? `: ${S.truck.label}` : ""}. Pallets restart at 1. Scan a PO.`);
      if (cur.po) assignPallet(cur.po);
      else setStep("po");
    } catch (e) { beep("err"); say("err", `Couldn't start truck: ${e.message}`); }
  }

  // ---- pallet for a PO
  let flashTimer = null;
  function flashScreen() {
    const el = $("screen-flash"); if (!el) return;
    clearTimeout(flashTimer); el.classList.remove("flash-red"); void el.offsetWidth; el.classList.add("flash-red");
    flashTimer = setTimeout(() => el.classList.remove("flash-red"), 10000);
  }
  const savedPallet = (key) => S.truck && (S.palletMap[S.truck.id] || {})[key];

  async function assignPallet(key) {
    const po = S.pos[key];
    if (!po) return;
    const base = { key, priority: !!po.priority };
    if (po.priority) { flashScreen(); beep("err"); }
    if (!SORT_ON) { cur.pallet = Object.assign({}, base, { kind: "none", text: "Pallet sorting isn't configured (config.js)." }); renderPallet(); return; }
    if (!S.truck) { cur.pallet = Object.assign({}, base, { kind: "none", text: "No truck started — tap Start Truck to get pallet numbers." }); renderPallet(); return; }
    const known = savedPallet(key);
    cur.pallet = Object.assign({}, base, known ? { kind: "repeat", n: known, quick: true } : { kind: "wait" });
    renderPallet();
    const truckId = S.truck.id;
    try {
      const rows = await rpc("assign_pallet", {
        p_session_id: truckId, p_po_number: po.po_number,
        p_scanned_by: S.settings.receiver || "", p_shiphero_status: "validated",
      });
      const row = rows && rows[0];
      if (!row) throw new ApiError("Sort server returned no pallet.", 500);
      let p;
      if (row.capacity_reached) p = { kind: "full" };
      else {
        (S.palletMap[truckId] = S.palletMap[truckId] || {})[key] = row.pallet_number; save();
        p = { kind: row.was_new ? "new" : "repeat", n: row.pallet_number };
        if (row.was_new && S.truck && S.truck.id === truckId) { S.truck.next_pallet = Math.max(S.truck.next_pallet, row.pallet_number + 1); renderTruck(); }
      }
      if (cur.po === key) { cur.pallet = Object.assign({}, base, p); renderPallet(); }
    } catch (e) {
      if (/closed truck session/i.test(e.message)) { S.truck = null; loadTruck(); }
      if (cur.po !== key) return;
      cur.pallet = known
        ? Object.assign({}, base, { kind: "repeat", n: known, offline: true })
        : Object.assign({}, base, { kind: "error", text: e.network ? "Couldn't reach the sort server." : e.message });
      renderPallet();
      if (!known) beep("err");
    }
  }

  function renderPallet() {
    const el = $("pallet"), p = cur.pallet;
    if (!p || !cur.po || p.key !== cur.po) { el.hidden = true; return; }
    const po = S.pos[p.key] || {};
    const flag = p.priority ? `<div class="priority-flag">⚠ PRIORITY</div>` : "";
    const who = `<b>PO ${esc(po.po_number || p.key)}</b><div>${esc(po.vendor || "")}</div>`;
    let cls = "pallet", num = "", info = "";
    if (p.kind === "new" || p.kind === "repeat") {
      cls += p.kind === "repeat" ? " repeat" : "";
      num = p.n;
      info = `${flag}${who}<div class="sub-l">${p.kind === "new" ? "New pallet" : p.offline ? "Saved pallet (offline)" : p.quick ? "Already on this pallet…" : "Already on this pallet"}</div>`;
    } else if (p.kind === "wait") {
      cls += " wait"; num = "…"; info = `${flag}${who}<div>Getting pallet…</div>`;
    } else if (p.kind === "full") {
      cls += " bad"; num = "FULL"; info = `${flag}${who}<div>All ${(S.truck && S.truck.pallet_capacity) || 20} pallets are used. See a lead for an overflow spot.</div>`;
    } else if (p.kind === "error") {
      cls += " bad"; num = "?"; info = `${flag}${who}<div>${esc(p.text)}</div><button class="btn sm" id="btn-pallet-retry">Retry pallet</button>`;
    } else {
      cls += " wait"; num = "—"; info = `${flag}${who}<div>${esc(p.text)}</div>`;
    }
    el.className = cls;
    el.innerHTML = `<div><div class="p-label">Pallet</div><div class="p-num">${num}</div></div><div class="p-info">${info}</div>`;
    el.hidden = false;
    const rb = $("btn-pallet-retry"); if (rb) rb.onclick = () => { assignPallet(p.key); setStep(cur.step); };
  }

  async function renderPalletList() {
    const box = $("pallet-list");
    if (!SORT_ON) { box.innerHTML = `<div class="empty">Pallet sorting isn't configured.</div>`; return; }
    if (!S.truck) { box.innerHTML = `<div class="empty">No truck in progress. Start one on the Scan tab.</div>`; return; }
    try {
      const rows = await sb(`po_scans?session_id=eq.${encodeURIComponent(S.truck.id)}&select=po_number,pallet_number,first_scanned_by,first_scanned_at&order=pallet_number.asc`);
      if (activeTab !== "pallets") return;
      if (!rows.length) { box.innerHTML = `<div class="empty">No POs sorted on "${esc(S.truck.label)}" yet.</div>`; return; }
      box.innerHTML = `<div class="card"><div class="card-head"><h2>${esc(S.truck.label)}</h2><span class="hint">${rows.length} PO${rows.length > 1 ? "s" : ""}</span></div><ul class="plist">${rows.map((r) => {
        const po = S.pos[norm(r.po_number)] || {};
        const mine = S.scans.filter((x) => x.po === norm(r.po_number)).reduce((a, x) => a + x.qty, 0);
        return `<li><span class="pn">${r.pallet_number != null ? r.pallet_number : "—"}</span><span class="grow"><b>PO ${esc(r.po_number)}</b>${po.priority ? ' <span class="priority-flag">PRIORITY</span>' : ""}
          <div class="sub">${esc(po.vendor || "")}${r.first_scanned_by ? " · " + esc(r.first_scanned_by) : ""} · ${fmtTime(r.first_scanned_at)}${mine ? ` · ${mine} units saved here` : ""}</div></span></li>`;
      }).join("")}</ul></div>`;
    } catch (e) {
      if (activeTab === "pallets") box.innerHTML = `<div class="alert warn">Couldn't load pallets: ${esc(e.message)}</div>`;
    }
  }

  // ---------------------------------------------------------------- scan flow
  const cur = { po: null, line: null, overConfirm: null, base: null, cands: null, step: "po", pallet: null };
  const STEPS = ["po", "loc", "sku", "size", "qty"];

  function setStep(step) {
    cur.step = step;
    const sizeUsed = !!cur.base;
    document.querySelectorAll(".steps li").forEach((li) => {
      const i = STEPS.indexOf(li.dataset.step), j = STEPS.indexOf(step);
      li.classList.toggle("active", i === j);
      li.classList.toggle("done", i < j && (li.dataset.step !== "size" || sizeUsed));
      li.classList.toggle("skipped", li.dataset.step === "size" && j > i && !sizeUsed);
    });
    $("in-loc").disabled = step !== "loc";
    $("in-sku").disabled = !(step === "sku" || step === "size" || step === "qty");
    $("in-size").disabled = step !== "size";
    $("size-wrap").hidden = !(step === "size" || (step === "qty" && sizeUsed));
    $("in-qty").disabled = step !== "qty";
    $("btn-save").disabled = step !== "qty";
    const target = { po: "in-po", loc: "in-loc", sku: "in-sku", size: "in-size", qty: "in-qty" }[step];
    // focus synchronously: a scanner can send the next code within milliseconds
    $(target).focus(); $(target).select();
  }

  async function loadPO(raw) {
    const num = String(raw || "").trim();
    if (!num) return;
    const key = norm(num);
    const cached = S.pos[key];
    // Preloaded and fresh → instant; refresh quietly in the background
    if (cached && cached.complete !== false && Date.now() - cached.fetchedAt < CACHE_FRESH_MS) {
      cur.po = key;
      onPOReady("cached");
      assignPallet(key);
      api("getPO", { id: cached.id }).then(({ po }) => {
        applyPO(po); save();
        if (cur.po === key) { renderPOCard(); if (cur.line) { cur.line = lineFor(S.pos[key], cur.line.sku) || cur.line; renderLineCard(); } }
      }).catch(() => {});
      return;
    }
    say("", `Looking up PO ${num}…`);
    $("btn-po").disabled = true;
    try {
      const { po } = await api("getPO", { po_number: num });
      cur.po = applyPO(po); save();
      onPOReady("live");
      assignPallet(cur.po);
    } catch (e) {
      if (e.network && cached) {
        cur.po = key;
        onPOReady("offline");
        assignPallet(key);
      } else {
        cur.po = null; cur.pallet = null; renderPallet(); beep("err");
        say("err", e.network ? `Offline and PO ${num} isn't saved on this device. Reconnect and rescan.` : e.message);
        $("po-card").hidden = true; $("loc-card").hidden = true;
        setStep("po");
      }
    } finally { $("btn-po").disabled = false; }
  }

  function onPOReady(how) {
    const po = S.pos[cur.po];
    const closed = /closed|cancel/i.test(po.status || "");
    beep(closed ? "err" : "ok");
    renderPOCard();
    $("in-po").value = po.po_number;
    cur.line = null; cur.base = null; cur.cands = null;
    $("line-card").hidden = true; $("in-sku").value = ""; $("in-size").value = ""; $("in-qty").value = ""; $("in-loc").value = "";
    renderRecent();
    const pre = closed ? `PO ${po.po_number} is ${po.status} in ShipHero — the upload may be rejected. `
      : how === "offline" ? `Offline — using saved copy of PO ${po.po_number}. ` : `PO ${po.po_number} ready. `;
    const kind = closed || how === "offline" ? "warn" : "ok";
    const key = cur.po;
    if (onHold(key)) {
      $("loc-card").hidden = true;
      beep("err");
      say("err", `FAI HOLD — PO ${po.po_number} has ${faiLines(po).length} SKU(s) that need First Article Inspection in ShipHero first. Do those, then tap Re-check.`);
      setStep("po");
      return;
    }
    if (S.poLoc[key]) { renderLocCard(); say(kind, `${pre}Putting away to ${S.poLoc[key].name}. Scan a SKU.`); setStep("sku"); renderPallet(); return; }
    // No location yet → use the default (Receiving). Scanning a location barcode later changes it.
    $("loc-card").hidden = true;
    setStep("sku");
    cur.locPending = lookupLocation(S.defaultLoc, po);
    cur.locPending.then((loc) => {
      if (cur.po !== key) return;
      S.poLoc[key] = loc; save(); renderLocCard();
      say(kind, `${pre}Putting away to ${loc.name} (default — scan a location to change). Scan a SKU.`);
    }).catch((e) => {
      if (cur.po !== key) return;
      beep("err");
      say("err", `${pre}Couldn't set the default location ${S.defaultLoc}: ${e.message} Scan a location.`);
      setStep("loc");
    });
  }

  // Resolve a location name in the PO's warehouse (cached so it works offline)
  async function lookupLocation(name, po) {
    const ck = `${po.warehouse_id || ""}|${norm(name)}`;
    try {
      const loc = (await api("getLocation", { name, warehouse_id: po.warehouse_id })).location;
      S.locs[ck] = { id: loc.id, name: loc.name, sellable: loc.sellable, pickable: loc.pickable };
      return S.locs[ck];
    } catch (e) {
      if (e.network && S.locs[ck]) return S.locs[ck];
      throw e;
    }
  }
  const knownLocation = (po, name) => S.locs[`${po.warehouse_id || ""}|${norm(name)}`] || null;

  function setLocation(loc, how) {
    S.poLoc[cur.po] = loc; save();
    renderLocCard();
    $("in-loc").value = "";
    beep("ok");
    say("ok", `${how === "changed" ? "Location changed" : "Putting away"} to ${loc.name}. Scan a SKU.`);
    setStep("sku");
  }

  function renderPOCard() {
    const po = S.pos[cur.po];
    if (!po) { $("po-card").hidden = true; return; }
    const ordered = po.lines.reduce((a, l) => a + l.ordered, 0);
    const received = po.lines.reduce((a, l) => a + l.received, 0);
    $("po-card").innerHTML = `<b>PO ${esc(po.po_number)}</b>
      <div class="kv"><span>${esc(po.vendor || "Vendor —")}</span><span>${esc(po.warehouse || "")}</span>
      <span>Status: ${esc(po.status || "—")}</span><span>${po.lines.length} SKUs</span>
      <span>Received ${received} / ${ordered}</span></div>
      <button class="link" id="btn-change-po">Change PO</button>
      ${holdBox(po)}`;
    $("po-card").hidden = false;
    const rc = $("btn-recheck-fai"); if (rc) rc.onclick = recheckFAI;
    $("btn-change-po").onclick = () => {
      cur.po = null; cur.line = null; cur.base = null; cur.cands = null; cur.pallet = null; renderPallet();
      $("in-po").value = ""; $("po-card").hidden = true; $("loc-card").hidden = true; $("line-card").hidden = true; $("recent-wrap").hidden = true;
      say("", "Scan a PO number to start."); setStep("po");
    };
  }

  function holdBox(po) {
    const lines = faiLines(po);
    if (!lines.length) return "";
    const shown = lines.slice(0, 12).map((l) => `<li><span class="mono">${esc(l.sku)}</span> <span class="sub">${esc(l.name || "")}</span></li>`).join("");
    return `<div class="fai-hold"><b>FAI HOLD — do these first</b>
      <div class="sub">These SKUs have no weight/dimensions in ShipHero, so they need First Article Inspection. Receive them through ShipHero's receiving screen (it prompts for FAI), then come back and tap Re-check to finish this PO here.</div>
      <ul>${shown}${lines.length > 12 ? `<li class="sub">+${lines.length - 12} more</li>` : ""}</ul>
      <button class="btn sm primary" id="btn-recheck-fai">Re-check FAI</button></div>`;
  }

  async function recheckFAI() {
    const key = cur.po, po = S.pos[key];
    if (!po) return;
    say("", `Re-checking PO ${po.po_number}…`);
    try {
      const fresh = (await api("getPO", { id: po.id })).po;
      applyPO(fresh); save(); renderOpenList();
      if (cur.po !== key) return;
      if (onHold(key)) { renderPOCard(); beep("err"); say("err", `Still on hold: ${faiLines(S.pos[key]).length} SKU(s) need FAI.`); }
      else { onPOReady("live"); }
    } catch (e) { beep("err"); say("err", `Couldn't re-check: ${e.message}`); }
  }

  function renderLocCard() {
    const loc = cur.po && S.poLoc[cur.po];
    if (!loc) { $("loc-card").hidden = true; return; }
    $("loc-card").innerHTML = `<span>→ ${esc(loc.name)}<div class="sub">${loc.sellable ? "Sellable" : "Not sellable"} · ${loc.pickable ? "pickable" : "not pickable"}</div></span>
      <button class="link" id="btn-change-loc">Change</button>`;
    $("loc-card").hidden = false;
    $("btn-change-loc").onclick = () => { $("in-loc").value = ""; say("", "Scan the new location."); setStep("loc"); };
  }

  async function onLoc(raw) {
    const name = String(raw || "").trim();
    if (!name) return;
    const po = S.pos[cur.po];
    if (!po) { setStep("po"); return; }
    if (lineFor(po, name) || baseCandidates(po, name).length) {
      beep("err"); say("err", `That looks like a SKU (${name}). Scan a location barcode.`); $("in-loc").select(); return;
    }
    say("", `Checking location ${name}…`);
    try { setLocation(await lookupLocation(name, po), "changed"); }
    catch (e) { beep("err"); say("err", e.network ? `Offline and location ${name} isn't saved on this device.` : e.message); $("in-loc").select(); }
  }

  function onSku(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    const po = S.pos[cur.po];
    if (!po) { setStep("po"); return; }
    if (onHold(cur.po)) { beep("err"); say("err", `PO ${po.po_number} is on FAI hold. Do the FAI SKUs first, then tap Re-check.`); setStep("po"); return; }
    cur.base = null; cur.cands = null; $("in-size").value = "";
    const line = lineFor(po, code);
    if (!line) {
      // A known location scanned in the SKU field → switch location instantly
      const known = knownLocation(po, code);
      if (known) { $("in-sku").value = ""; setLocation(known, "changed"); return; }
      const cands = baseCandidates(po, code);
      if (cands.length) {
        cur.base = code; cur.cands = cands; cur.line = null;
        $("in-sku").value = norm(code);
        $("line-card").hidden = true;
        renderSizeOpts();
        beep("ok");
        say("ok", `Base SKU ${norm(code)} — now scan the size barcode.`);
        setStep("size");
        return;
      }
      // Not a SKU on this PO → maybe it's a location barcode
      say("", `Checking ${code}…`);
      lookupLocation(code, po).then((loc) => {
        $("in-sku").value = ""; setLocation(loc, "changed");
      }).catch(() => {
        beep("err");
        say("err", `${code} is not on PO ${po.po_number} and isn't a location. Set it aside and check with a lead.`);
        $("in-sku").select();
      });
      return;
    }
    if (!S.poLoc[cur.po]) {
      // default location still resolving (scanner was faster than the network) → wait for it
      const key = cur.po;
      if (cur.locPending) { cur.locPending.then(() => { if (cur.po === key && S.poLoc[key]) pickLine(line); }).catch(() => {}); return; }
      beep("err"); say("err", "No location set for this PO yet. Scan a location."); setStep("loc"); return;
    }
    pickLine(line);
  }

  function pickLine(line) {
    cur.line = line; cur.overConfirm = null;
    if (!cur.base) $("in-sku").value = line.sku;
    renderLineCard();
    beep("ok");
    say("ok", `${line.sku} — scan or type the quantity.`);
    $("in-qty").value = "";
    setStep("qty");
  }

  function renderSizeOpts() {
    const base = cur.base;
    $("size-opts").innerHTML = (cur.cands || []).map((l, i) => {
      const left = l.ordered - l.received - pendingQty(cur.po, l.sku);
      return `<button type="button" data-cand="${i}" title="${esc(l.sku)}">${esc(sizeOf(l, base) || l.option_title || l.sku)}<small>${left > 0 ? left + " left" : "full"}</small></button>`;
    }).join("");
  }

  function onSize(raw) {
    const v = String(raw || "").trim();
    if (!v || !cur.cands) return;
    const po = S.pos[cur.po];
    const exact = lineFor(po, v);
    if (exact) { cur.base = null; cur.cands = null; $("in-sku").value = exact.sku; pickLine(exact); return; }
    const hits = resolveSize(cur.base, cur.cands, v);
    if (hits.length === 1) { $("in-size").value = canonSize(v); pickLine(hits[0]); return; }
    beep("err");
    const sizes = cur.cands.map((l) => sizeOf(l, cur.base) || l.option_title).join(", ");
    say("err", hits.length > 1
      ? `Size ${v} matches more than one SKU (${hits.map((h) => h.sku).join(", ")}). Tap the right size below.`
      : `Size "${v}" isn't on this PO for ${norm(cur.base)}. Sizes on PO: ${sizes}.`);
    $("in-size").select();
  }

  function renderLineCard(extra) {
    const l = cur.line;
    if (!l) { $("line-card").hidden = true; return; }
    const pend = pendingQty(cur.po, l.sku) + (extra || 0);
    const remaining = l.ordered - l.received - pend;
    $("line-card").innerHTML = `<b class="mono">${esc(l.sku)}</b><div>${esc(l.name || "")}</div>
      <div class="nums">
        <div><span>Ordered</span><strong>${l.ordered}</strong></div>
        <div><span>In ShipHero</span><strong>${l.received}</strong></div>
        <div><span>Scanned</span><strong>${pend}</strong></div>
        <div class="${remaining < 0 ? "over" : ""}"><span>${remaining < 0 ? "Over" : "Left"}</span><strong>${Math.abs(remaining)}</strong></div>
      </div>`;
    $("line-card").hidden = false;
  }

  function onQty(raw) {
    const v = String(raw || "").trim();
    const po = S.pos[cur.po], l = cur.line, loc = S.poLoc[cur.po];
    if (!po || !l) { setStep("sku"); return; }
    if (!loc) { setStep("loc"); return; }
    if (onHold(cur.po)) { beep("err"); say("err", `PO ${po.po_number} is on FAI hold.`); setStep("po"); return; }
    if (!v) return;
    if (lineFor(po, v)) { beep("err"); say("err", `That's a SKU (${v}), not a quantity. Scan or type the quantity.`); $("in-qty").select(); return; }
    if (!/^\d+$/.test(v)) { beep("err"); say("err", `"${v}" isn't a quantity. Use whole numbers only.`); $("in-qty").select(); return; }
    const qty = parseInt(v, 10);
    if (qty < 1 || qty > MAX_QTY) { beep("err"); say("err", `Quantity must be 1–${MAX_QTY}. Got ${qty}.`); $("in-qty").select(); return; }

    const remaining = l.ordered - l.received - pendingQty(cur.po, l.sku);
    if (qty > remaining && cur.overConfirm !== qty) {
      cur.overConfirm = qty;
      beep("err");
      renderLineCard(qty);
      say("warn", `That's ${qty - Math.max(remaining, 0)} over the PO. Press Enter again to save anyway, or fix the qty.`);
      return;
    }
    S.scans.push({ id: uid(), po: cur.po, sku: l.sku, qty, loc: { id: loc.id, name: loc.name }, ts: Date.now(), by: S.settings.receiver || "" });
    save();
    beep("save");
    say("ok", `Saved ${qty} × ${l.sku} → ${loc.name}. Scan the next SKU.`);
    cur.overConfirm = null;
    renderLineCard();
    renderRecent(); renderBadge();
    cur.base = null; cur.cands = null;
    $("in-qty").value = ""; $("in-sku").value = ""; $("in-size").value = "";
    setStep("sku");
  }

  function renderRecent() {
    const list = S.scans.filter((x) => x.po === cur.po).slice(-5).reverse();
    $("recent-wrap").hidden = !list.length;
    $("recent").innerHTML = list.map((x) => `<li><span class="mono">${esc(x.sku)}</span><span><b>${x.qty}</b> → ${esc(x.loc ? x.loc.name : "?")} · ${fmtTime(x.ts)}</span></li>`).join("");
  }

  function undoLast() {
    for (let i = S.scans.length - 1; i >= 0; i--) {
      if (S.scans[i].po === cur.po) {
        const x = S.scans.splice(i, 1)[0];
        save(); renderRecent(); renderBadge();
        if (cur.line && norm(cur.line.sku) === norm(x.sku)) renderLineCard();
        say("warn", `Removed ${x.qty} × ${x.sku}.`);
        return;
      }
    }
  }

  // ---------------------------------------------------------------- saved view
  const gkey = (x) => `${x.po}|${x.loc ? x.loc.id : "none"}`;
  function groupPending() {
    const groups = {};
    for (const x of S.scans) {
      const k = gkey(x);
      const g = groups[k] || (groups[k] = { key: k, po: x.po, loc: x.loc || null, lines: {}, units: 0 });
      const sk = norm(x.sku);
      const ln = g.lines[sk] || (g.lines[sk] = { sku: x.sku, qty: 0, scans: 0 });
      ln.qty += x.qty; ln.scans++; g.units += x.qty;
    }
    return groups;
  }

  function renderBadge() {
    const n = S.scans.length;
    $("saved-badge").hidden = !n;
    $("saved-badge").textContent = n;
    $("btn-upload").disabled = !n || uploading;
  }

  function stepText(b) {
    const inv = b.lines.filter((l) => l.inv === "done").length;
    return `Inventory added: ${inv}/${b.lines.length} lines · PO updated: ${b.poStep === "done" ? "yes" : "no"}`;
  }

  function renderSaved() {
    const groups = groupPending();
    const keys = Object.keys(groups);
    const alerts = S.batches.filter((b) => b.state === "unknown" || b.state === "review");
    $("batch-alerts").innerHTML = alerts.map((b) => `
      <div class="alert ${b.state === "review" ? "err" : "warn"}">
        <b>PO ${esc(b.po_number)} → ${esc(b.location ? b.location.name : "?")} — ${b.state === "review" ? "needs a manual check" : "upload not finished"}</b>
        <div>${esc(b.error || "")}</div>
        <div class="hint">${stepText(b)}</div>
        <div>${b.lines.map((l) => `${esc(l.sku)} × ${l.qty}`).join(", ")}</div>
        <div class="acts">
          ${b.state === "unknown" ? `<button class="btn sm primary" data-verify="${b.id}">Check ShipHero &amp; finish</button>` : ""}
          ${b.state === "review" ? `<button class="btn sm" data-resolve="${b.id}">I fixed it in ShipHero</button>` : ""}
        </div>
      </div>`).join("");

    if (!keys.length) {
      $("saved-list").innerHTML = `<div class="empty">No saved scans waiting to upload.</div>`;
    } else {
      $("saved-list").innerHTML = keys.map((k) => {
        const g = groups[k], po = S.pos[g.po] || { po_number: g.po, lines: [] };
        const rows = Object.values(g.lines).map((ln) => {
          const pl = lineFor(po, ln.sku) || { ordered: 0, received: 0, name: "" };
          const after = pl.received + pendingQty(g.po, ln.sku);
          const over = after - pl.ordered;
          return `<tr><td><span class="mono">${esc(ln.sku)}</span>${over > 0 ? `<span class="over-tag">+${over} over</span>` : ""}<div class="sub">${esc(pl.name || "")}</div></td>
            <td class="num"><b>${ln.qty}</b><div class="sub">${ln.scans} scan${ln.scans > 1 ? "s" : ""}</div></td>
            <td class="num">${pl.received} → ${after}<div class="sub">of ${pl.ordered}</div></td>
            <td class="num"><button class="link" data-del-sku="${esc(k)}" data-sku="${esc(ln.sku)}" aria-label="Remove">✕</button></td></tr>`;
        }).join("");
        return `<div class="card po-block">
          <div class="card-head"><div><h3>PO ${esc(po.po_number)} <span class="loc-tag">→ ${esc(g.loc ? g.loc.name : "NO LOCATION")}</span></h3>
          <div class="meta">${esc(po.vendor || "")} · ${Object.keys(g.lines).length} SKUs · ${g.units} units</div></div>
          <button class="btn sm danger" data-del-po="${esc(k)}">Remove</button></div>
          <table><thead><tr><th>SKU</th><th class="num">Qty</th><th class="num">Received</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        </div>`;
      }).join("");
    }
    renderBadge();
  }

  function onSavedClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.delSku) {
      const k = t.dataset.delSku, sku = norm(t.dataset.sku);
      S.scans = S.scans.filter((x) => !(gkey(x) === k && norm(x.sku) === sku));
      save(); renderSaved();
    } else if (t.dataset.delPo) {
      const k = t.dataset.delPo;
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Tap again to remove"; return; }
      S.scans = S.scans.filter((x) => gkey(x) !== k);
      save(); renderSaved();
    } else if (t.dataset.verify) {
      runBatches([S.batches.find((b) => b.id === t.dataset.verify)]);
    } else if (t.dataset.resolve) {
      const b = S.batches.find((x) => x.id === t.dataset.resolve);
      if (t.dataset.armed !== "1") { t.dataset.armed = "1"; t.textContent = "Confirm: fixed in ShipHero"; return; }
      b.state = "done"; b.error = "Marked fixed manually."; b.ts = Date.now();
      save(); renderSaved();
    }
  }

  // ---------------------------------------------------------------- upload
  let uploading = false;

  function openUpload() {
    const groups = Object.values(groupPending());
    if (!groups.length) return;
    const units = groups.reduce((a, g) => a + g.units, 0);
    const lines = groups.reduce((a, g) => a + Object.keys(g.lines).length, 0);
    $("upload-summary").innerHTML = `<p><b>${groups.length}</b> PO/location group${groups.length > 1 ? "s" : ""} · <b>${lines}</b> lines · <b>${units}</b> units</p>
      <ul>${groups.map((g) => `<li>PO ${esc((S.pos[g.po] || {}).po_number || g.po)} → ${esc(g.loc ? g.loc.name : "NO LOCATION")} — ${g.units} units</li>`).join("")}</ul>`;
    $("dlg-upload").showModal();
  }

  async function startUpload() {
    $("dlg-upload").close();
    const groups = groupPending();
    const batches = [];
    for (const k of Object.keys(groups)) {
      const g = groups[k], po = S.pos[g.po];
      const b = {
        id: uid(), tag: uid().replace(/[^a-z0-9]/g, ""), po: g.po, po_id: po && po.id, po_number: (po && po.po_number) || g.po,
        warehouse_id: po && po.warehouse_id, location: g.loc,
        lines: Object.values(g.lines).map((l) => ({ sku: l.sku, qty: l.qty, inv: "pending" })),
        poStep: "pending", scans: S.scans.filter((x) => gkey(x) === k),
        before: null, state: "queued", ts: Date.now(), by: S.settings.receiver || "",
      };
      S.scans = S.scans.filter((x) => gkey(x) !== k);
      S.batches.push(b); batches.push(b);
    }
    save(); renderSaved();
    await runBatches(batches);
  }

  function releaseBatch(b, msg) {
    // nothing from this batch reached ShipHero → put the scans back in the queue
    S.scans = S.scans.concat(b.scans || []);
    b.state = "failed"; b.error = msg; b.ts = Date.now();
  }
  const anyApplied = (b) => b.poStep !== "pending" || b.lines.some((l) => l.inv !== "pending");
  function stopBatch(b, msg, definite) {
    // definite = ShipHero rejected the step, so it didn't happen
    if (definite && !anyApplied(b)) return releaseBatch(b, msg);
    b.state = definite ? "review" : "unknown";
    b.error = msg;
  }

  async function runBatches(list) {
    if (uploading) return;
    uploading = true; renderBadge();
    const results = { done: 0, failed: 0, unknown: 0, review: 0 };
    try {
      for (const b of list) {
        if (!b) continue;
        say("", `Uploading PO ${b.po_number}…`);
        await runOne(b);
        results[b.state] = (results[b.state] || 0) + 1;
        save(); renderSaved();
      }
    } finally {
      uploading = false; renderSaved(); renderHistory();
    }
    const parts = [];
    if (results.done) parts.push(`${results.done} uploaded`);
    if (results.failed) parts.push(`${results.failed} not sent (scans kept)`);
    if (results.unknown) parts.push(`${results.unknown} not finished`);
    if (results.review) parts.push(`${results.review} need review`);
    const bad = results.failed || results.unknown || results.review;
    beep(bad ? "err" : "save");
    say(bad ? "warn" : "ok", `Upload finished: ${parts.join(", ") || "nothing to do"}.`);
  }

  // Receiving log written to the PO line's note so it's visible on the PO page in ShipHero.
  // Keeps whatever note was there; trims the oldest app entries if it gets long.
  function lineNote(po, l, b) {
    const pl = lineFor(po, l.sku);
    const prev = String((pl && pl.note) || "").trim();
    const d = new Date();
    const stamp = `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    const entry = `PLR ${stamp} ${b.by || "-"} +${l.qty} → ${b.location.name}`;
    let lines = prev ? prev.split("\n") : [];
    lines.push(entry);
    while (lines.join("\n").length > 900 && lines.findIndex((x) => x.startsWith("PLR ")) !== -1 && lines.length > 1) {
      lines.splice(lines.findIndex((x) => x.startsWith("PLR ")), 1);
    }
    return lines.join("\n");
  }

  const lineTag = (b, i) => `[PLR-${b.tag}.${i}]`;
  const lineReason = (b, i) => `PL Receiving · PO ${b.po_number} · ${b.location.name} · ${b.by || "-"} ${lineTag(b, i)}`.slice(0, 200);

  async function runOne(b) {
    if (!b.location || !b.location.id) return releaseBatch(b, "No location on these scans. Remove them, scan the PO's location, and rescan.");

    // 1. Fresh read of the PO (validation + snapshot for verifying the PO step)
    let po;
    try {
      po = (await api("getPO", b.po_id ? { id: b.po_id } : { po_number: b.po_number }, { retries: 3 })).po;
      applyPO(po);
      b.po_id = po.id; b.warehouse_id = po.warehouse_id;
    } catch (e) {
      return stopBatch(b, `Couldn't read the PO from ShipHero: ${e.message}`, !anyApplied(b) && !e.network);
    }
    if (!anyApplied(b) && faiLines(po).length) {
      return releaseBatch(b, `FAI hold: ${faiLines(po).length} SKU(s) on PO ${po.po_number} need First Article Inspection in ShipHero first (${faiLines(po).slice(0, 5).map((l) => l.sku).join(", ")}${faiLines(po).length > 5 ? "…" : ""}). Scans kept.`);
    }
    if (!b.before) {
      const missing = b.lines.filter((l) => !lineFor(po, l.sku));
      if (missing.length) return releaseBatch(b, `Not on PO ${po.po_number}: ${missing.map((m) => m.sku).join(", ")}. Remove them and upload again.`);
      b.before = {};
      b.lines = b.lines.map((l) => { const pl = lineFor(po, l.sku); b.before[norm(pl.sku)] = pl.received; return Object.assign(l, { sku: pl.sku }); });
    }
    b.state = "sending"; save();

    // 2. Add inventory to the location, one line at a time
    for (let i = 0; i < b.lines.length; i++) {
      const l = b.lines[i];
      if (l.inv === "done") continue;
      if (l.inv === "unknown" || l.inv === "sending") {
        try {
          const r = await api("findChange", { sku: l.sku, tag: lineTag(b, i), warehouse_id: b.warehouse_id, since: b.ts }, { retries: 3 });
          if (r.found > 0) { l.inv = "done"; save(); continue; }
        } catch (e) { return stopBatch(b, `Couldn't check inventory history for ${l.sku}: ${e.message}`, false); }
      }
      say("", `PO ${b.po_number}: adding ${l.qty} × ${l.sku} to ${b.location.name}…`);
      l.inv = "sending"; save();
      try {
        const r = await api("addInventory", {
          sku: l.sku, warehouse_id: b.warehouse_id, location_id: b.location.id, quantity: l.qty, reason: lineReason(b, i),
        });
        l.inv = "done"; l.request_id = r.request_id; save();
      } catch (e) {
        const definite = e.status === 400 || e.status === 401 || e.status === 404 || e.status === 429;
        l.inv = definite ? "pending" : "unknown";
        return stopBatch(b, `Adding ${l.sku} to ${b.location.name} failed: ${e.message}`, definite);
      }
    }

    // 3. Add the quantities to Quantity received on the PO
    if (b.poStep === "unknown" || b.poStep === "sending") {
      let applied = true, untouched = true;
      for (const l of b.lines) {
        const pl = lineFor(po, l.sku); const now = pl ? pl.received : -1;
        const was = b.before[norm(l.sku)];
        if (now !== was + l.qty) applied = false;
        if (now !== was) untouched = false;
      }
      if (applied) { b.poStep = "done"; }
      else if (!untouched) { return stopBatch(b, "Inventory was added, but the PO's received counts changed in a way that doesn't match this upload. Check the PO in ShipHero, then mark it fixed.", true); }
      else b.poStep = "pending";
    }
    if (b.poStep !== "done") {
      b.poStep = "sending"; save();
      try {
        const r = await api("receive", { po_id: b.po_id, line_items: b.lines.map((l) => ({ sku: l.sku, quantity_received: l.qty, note: lineNote(po, l, b) })) });
        b.poStep = "done"; b.request_id = r.request_id;
      } catch (e) {
        const definite = e.status === 400 || e.status === 401 || e.status === 404 || e.status === 429;
        b.poStep = definite ? "pending" : "unknown";
        return stopBatch(b, `Inventory was added, but updating the PO failed: ${e.message}`, definite);
      }
    }
    b.state = "done"; b.ts = Date.now(); b.error = "";
    for (const l of b.lines) { const pl = lineFor(S.pos[b.po], l.sku); if (pl) pl.received += l.qty; }
    save();
  }

  // ---------------------------------------------------------------- history
  function renderHistory() {
    const list = S.batches.filter((b) => b.state !== "queued").slice().reverse();
    $("history-list").innerHTML = list.length ? list.map((b) => `
      <div class="card hist">
        <div class="top"><b>PO ${esc(b.po_number)}${b.location ? ` → ${esc(b.location.name)}` : ""}</b><span class="pill ${b.state}">${{ done: "Uploaded", failed: "Not sent", unknown: "Not finished", review: "Needs review", sending: "Sending" }[b.state] || b.state}</span></div>
        <div class="hint">${fmtTime(b.ts)}${b.by ? " · " + esc(b.by) : ""}${b.tag ? " · PLR-" + esc(b.tag) : ""}</div>
        <div>${b.lines.map((l) => `<span class="mono">${esc(l.sku)}</span> × ${l.qty}`).join(" · ")}</div>
        ${b.state !== "done" && b.lines[0] && b.lines[0].inv ? `<div class="hint">${stepText(b)}</div>` : ""}
        ${b.error ? `<div class="hint">${esc(b.error)}</div>` : ""}
      </div>`).join("") : `<div class="empty">No uploads yet.</div>`;
  }

  // ---------------------------------------------------------------- CSV export
  function exportCSV() {
    const rows = [["status", "po_number", "location", "sku", "qty", "scanned_at", "receiver", "tag"]];
    for (const x of S.scans) rows.push(["pending", (S.pos[x.po] || {}).po_number || x.po, x.loc ? x.loc.name : "", x.sku, x.qty, new Date(x.ts).toISOString(), x.by || "", ""]);
    for (const b of S.batches) b.lines.forEach((l, i) => rows.push([b.state, b.po_number, b.location ? b.location.name : "", l.sku, l.qty, new Date(b.ts).toISOString(), b.by || "", b.tag ? `PLR-${b.tag}.${i}` : ""]));
    const csv = rows.map((r) => r.map((c) => { const s = String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `receiving-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------------------------------------------------------------- settings / misc UI
  function openSettings(note) {
    $("in-pin").value = S.settings.pin || "";
    $("in-receiver").value = S.settings.receiver || "";
    $("in-sound").checked = S.settings.sound !== false;
    if (note) say("warn", note);
    if (!$("dlg-settings").open) $("dlg-settings").showModal();
  }
  function saveSettings() {
    const pinChanged = $("in-pin").value.trim() !== S.settings.pin;
    S.settings.pin = $("in-pin").value.trim();
    S.settings.receiver = $("in-receiver").value.trim().toUpperCase();
    S.settings.sound = $("in-sound").checked;
    save(); $("dlg-settings").close();
    if (pinChanged || !S.open.at) syncOpenPOs(false);
  }

  let activeTab = "scan";
  function showTab(name) {
    activeTab = name;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    ["scan", "saved", "pallets", "history"].forEach((v) => { $("view-" + v).hidden = v !== name; });
    if (name === "saved") renderSaved();
    if (name === "history") renderHistory();
    if (name === "pallets") renderPalletList();
    if (name === "scan") setStep(cur.po ? cur.step === "po" ? (S.poLoc[cur.po] ? "sku" : "loc") : cur.step : "po");
  }

  function setNet() { $("net").classList.toggle("off", !navigator.onLine); $("net").title = navigator.onLine ? "Online" : "Offline — scans still save"; }

  function onEnter(el, fn) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") { if (e.key === "Tab" && !el.value) return; e.preventDefault(); fn(el.value); }
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    // migrate batches from the first version (PO update only, no inventory steps)
    S.batches.forEach((b) => { if (!b.lines.length || b.lines[0].inv) return; if (b.state !== "done") { b.state = "review"; b.error = "Uploaded by an older version (PO only, no location). Check this PO in ShipHero."; } });
    // any step left mid-send by a crash/reload is unknown → must be verified
    let stuck = 0;
    S.batches.forEach((b) => {
      if (b.state === "sending" || b.state === "queued") {
        b.lines.forEach((l) => { if (l.inv === "sending") l.inv = "unknown"; });
        if (b.poStep === "sending") b.poStep = "unknown";
        if (b.state === "queued" && !anyApplied(b)) { releaseBatch(b, "App closed before upload started."); }
        else { b.state = "unknown"; b.error = "App closed during upload."; stuck++; }
      }
    });
    prune(); save();

    onEnter($("in-po"), loadPO);
    onEnter($("in-loc"), onLoc);
    onEnter($("in-sku"), onSku);
    onEnter($("in-size"), onSize);
    onEnter($("in-qty"), onQty);
    $("in-po").addEventListener("change", () => { const v = $("in-po").value; if (S.pos[norm(v)] && document.activeElement === $("in-po")) loadPO(v); });
    $("size-opts").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-cand]");
      if (b && cur.cands) pickLine(cur.cands[+b.dataset.cand]);
    });
    $("btn-po").onclick = () => loadPO($("in-po").value);
    $("btn-sync").onclick = () => syncOpenPOs(true);
    $("fai-list").addEventListener("click", (e) => { const b = e.target.closest("[data-fai-po]"); if (b) { showTab("scan"); loadPO(b.dataset.faiPo); } });
    $("btn-save").onclick = () => onQty($("in-qty").value);
    $("btn-undo").onclick = undoLast;
    $("in-sku").addEventListener("input", () => { if (cur.step !== "sku") { cur.line = null; cur.base = null; cur.cands = null; setStep("sku"); } });
    $("saved-list").addEventListener("click", onSavedClick);
    $("batch-alerts").addEventListener("click", onSavedClick);
    $("btn-upload").onclick = openUpload;
    $("dlg-upload-go").onclick = startUpload;
    $("dlg-upload-cancel").onclick = () => $("dlg-upload").close();
    $("btn-export").onclick = exportCSV;
    $("btn-settings").onclick = () => openSettings();
    $("dlg-settings-save").onclick = saveSettings;
    $("dlg-settings-cancel").onclick = () => $("dlg-settings").close();
    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
    window.addEventListener("online", setNet); window.addEventListener("offline", setNet);
    $("view-scan").addEventListener("click", (e) => {
      if (e.target.closest("input,button,a")) return;
      const f = ["in-qty", "in-size", "in-sku", "in-loc", "in-po"].map($).find((x) => !x.disabled);
      f && f.focus();
    });
    $("btn-truck").onclick = startTruck;
    setNet(); renderBadge(); renderOpenList(); renderTruck(); setStep("po");
    loadTruck();
    setInterval(() => { if (navigator.onLine && !document.hidden) loadTruck(); }, TRUCK_POLL_MS);
    setInterval(() => { if (activeTab === "pallets" && navigator.onLine && !document.hidden) renderPalletList(); }, PALLET_POLL_MS);
    if (S.batches.some((b) => b.state === "unknown" || b.state === "review")) say("warn", "An earlier upload needs checking — open the Saved tab.");
    else say("", "Scan a PO number to start.");
    api("ping").then((r) => { if (r && r.default_location && r.default_location !== S.defaultLoc) { S.defaultLoc = r.default_location; save(); } }).catch(() => {});
    syncOpenPOs(false);
    setInterval(() => { if (!uploading && navigator.onLine) syncOpenPOs(false); }, RESYNC_MS);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
