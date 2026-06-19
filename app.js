/* =====================================================================
   FSDO Notification Generator — app logic
   ===================================================================== */
(function () {
  "use strict";

  const CFG = window.FSDO_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // In-memory app state
  const state = {
    pin: null,             // the PIN the user typed (sent to the backend to authorize the send)
    lat: null,
    lon: null,
    address: null,
    city: null,
    region: null,          // state / province
    nearest: null,         // FSDO object
    fsdoEmail: "",         // the recipient email currently in use
    fsdoEmailOverride: null, // { fsdoId, email } when manually edited
    image: null,           // { name, mimeType, dataBase64 }
    fsdos: [],
    spots: []              // saved locations (shared, from the Worker)
  };

  // POST JSON to the backend Worker and return the parsed response.
  async function backend(payload) {
    const res = await fetch(CFG.BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });
    return res.json();
  }

  // Minimal fallback so the page works even before fsdo_offices.json loads.
  const FALLBACK_FSDOS = [
    { id: "slc", name: "Salt Lake City FSDO", address: "116 N 2400 W, Salt Lake City, UT 84116",
      city: "Salt Lake City", state: "UT", lat: 40.7866, lon: -111.975, email: null, email_status: "unverified" }
  ];

  /* ------------------------------------------------------------------ */
  /* PIN LOCK                                                            */
  /* ------------------------------------------------------------------ */
  async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function initLock() {
    const form = $("pin-form");
    const input = $("pin-input");
    const err = $("pin-error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const pin = input.value.trim();
      if (!pin) return;

      const expected = (CFG.PIN_SHA256 || "").toLowerCase();
      const got = await sha256Hex(pin);

      // If no hash configured yet, let any non-empty PIN through (setup mode).
      if (!expected || expected.startsWith("paste") || got === expected) {
        state.pin = pin;
        unlock();
      } else {
        err.hidden = false;
        input.select();
      }
    });
  }

  function unlock() {
    $("lock-screen").style.display = "none";
    $("app").hidden = false;
    initApp();
  }

  /* ------------------------------------------------------------------ */
  /* MAP                                                                 */
  /* ------------------------------------------------------------------ */
  let map, marker;

  function initMap() {
    const d = CFG.MAP_DEFAULT || { lat: 39.5, lon: -98.35, zoom: 4 };
    map = L.map("map", { scrollWheelZoom: true }).setView([d.lat, d.lon], d.zoom);

    const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap"
    });
    const imagery = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
    const places = L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19 });
    const satellite = L.layerGroup([imagery, places]); // imagery + city/road labels

    street.addTo(map);
    L.control.layers({ "Street": street, "Satellite": satellite }, null, { position: "topright" }).addTo(map);

    map.on("click", (e) => setLocation(e.latlng.lat, e.latlng.lng, { reverse: true, fly: false }));
  }

  function placeMarker(lat, lon) {
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.marker([lat, lon], { draggable: true }).addTo(map);
    marker.off("dragend");
    marker.on("dragend", () => {
      const p = marker.getLatLng();
      setLocation(p.lat, p.lng, { reverse: true, fly: false, skipMarker: true });
    });
  }

  /* ------------------------------------------------------------------ */
  /* LOCATION                                                            */
  /* ------------------------------------------------------------------ */
  function setLocation(lat, lon, opts = {}) {
    lat = +(+lat).toFixed(7);
    lon = +(+lon).toFixed(7);
    state.lat = lat;
    state.lon = lon;
    $("lat").value = lat;
    $("lon").value = lon;

    if (!opts.skipMarker) placeMarker(lat, lon);
    if (opts.fly) map.flyTo([lat, lon], Math.max(map.getZoom(), 13));
    else map.panTo([lat, lon]);

    computeNearest();
    if (opts.reverse) reverseGeocode(lat, lon);
    const sb = $("spot-save-btn");
    if (sb) sb.disabled = false;
    validate();
  }

  async function reverseGeocode(lat, lon) {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
      const r = await fetch(url, { headers: { "Accept-Language": "en" } });
      const j = await r.json();
      state.address = j.display_name || null;
      const a = j.address || {};
      state.city = a.city || a.town || a.village || a.hamlet || a.county || null;
      state.region = a.state || null;
      showAddress();
    } catch (_) { /* non-fatal */ }
  }

  function showAddress() {
    const box = $("resolved-address");
    if (state.address) {
      box.hidden = false;
      box.textContent = "📍 " + state.address;
    } else {
      box.hidden = true;
    }
  }

  /* ---- Address search (Nominatim) ---- */
  let searchTimer;
  function initSearch() {
    const input = $("addr-search");
    const list = $("addr-results");

    const run = async () => {
      const q = input.value.trim();
      if (q.length < 3) { list.hidden = true; return; }
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&limit=6&q=${encodeURIComponent(q)}`;
        const r = await fetch(url, { headers: { "Accept-Language": "en" } });
        const items = await r.json();
        list.innerHTML = "";
        if (!items.length) { list.hidden = true; return; }
        items.forEach((it) => {
          const li = document.createElement("li");
          li.textContent = it.display_name;
          li.addEventListener("click", () => {
            input.value = it.display_name;
            list.hidden = true;
            state.address = it.display_name;
            const a = it.address || {};
            state.city = a.city || a.town || a.village || a.hamlet || a.county || null;
            state.region = a.state || null;
            setLocation(parseFloat(it.lat), parseFloat(it.lon), { fly: true });
            showAddress();
          });
          list.appendChild(li);
        });
        list.hidden = false;
      } catch (_) { list.hidden = true; }
    };

    input.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(run, 450); });
    $("addr-search-btn").addEventListener("click", run);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
    document.addEventListener("click", (e) => {
      if (!list.contains(e.target) && e.target !== input) list.hidden = true;
    });
  }

  function initCoordEntry() {
    const go = () => {
      const lat = parseFloat($("lat").value);
      const lon = parseFloat($("lon").value);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        setLocation(lat, lon, { reverse: true, fly: true });
      } else {
        toast("Enter a valid latitude (-90..90) and longitude (-180..180).", "err");
      }
    };
    $("coord-go").addEventListener("click", go);
    ["lat", "lon"].forEach((id) =>
      $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } })
    );
  }

  /* ------------------------------------------------------------------ */
  /* FSDO DATA + NEAREST                                                 */
  /* ------------------------------------------------------------------ */
  async function loadFsdos() {
    try {
      const r = await fetch("fsdo_offices.json", { cache: "no-cache" });
      if (!r.ok) throw new Error("status " + r.status);
      const data = await r.json();
      state.fsdos = Array.isArray(data) ? data : (data.offices || []);
      if (!state.fsdos.length) throw new Error("empty");
    } catch (_) {
      state.fsdos = FALLBACK_FSDOS;
      console.warn("fsdo_offices.json not loaded — using fallback list.");
    }
  }

  function haversine(aLat, aLon, bLat, bLon) {
    const R = 3958.7613; // miles
    const dLat = (bLat - aLat) * Math.PI / 180;
    const dLon = (bLon - aLon) * Math.PI / 180;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function computeNearest() {
    if (state.lat == null || !state.fsdos.length) return;
    let best = null, bestD = Infinity;             // nearest office that HAS an email
    let nearestAny = null, nearestAnyD = Infinity; // nearest office overall
    for (const f of state.fsdos) {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      const d = haversine(state.lat, state.lon, f.lat, f.lon);
      if (d < nearestAnyD) { nearestAnyD = d; nearestAny = f; }
      if (f.email && d < bestD) { bestD = d; best = f; }
    }
    state.nearest = best;
    renderFsdo(best, bestD, nearestAny, nearestAnyD);
  }

  function renderFsdo(f, dist, nearestAny, nearestAnyD) {
    const box = $("fsdo-box");
    if (!f) { box.className = "fsdo-box empty"; box.innerHTML = '<p class="fsdo-empty">No FSDO with a published email found nearby.</p>'; state.fsdoEmail = ""; return; }
    box.className = "fsdo-box";
    const miles = Number.isFinite(dist) ? `${Math.round(dist)} mi away` : "";
    const fellBack = nearestAny && nearestAny.id !== f.id;
    const unverified = f.email_status && f.email_status !== "verified";

    // Default to this office's email. Keep a manual override only while the
    // same office stays nearest, so nudging the pin doesn't wipe an edit.
    const override = state.fsdoEmailOverride && state.fsdoEmailOverride.fsdoId === f.id
      ? state.fsdoEmailOverride.email : null;
    if (!override) state.fsdoEmailOverride = null;
    state.fsdoEmail = override != null ? override : (f.email || "");

    box.innerHTML = `
      <p class="fsdo-name">${esc(f.name)} <span class="dist">${miles}</span></p>
      <p class="fsdo-addr">${esc(f.address || [f.city, f.state].filter(Boolean).join(", "))}</p>
      <div class="fsdo-email-row" id="fsdo-email-view">
        <span class="fsdo-email-label">Email</span>
        <span class="fsdo-email-display" id="fsdo-email-display">${esc(state.fsdoEmail)}</span>
        <button id="fsdo-email-edit" type="button" class="btn btn-ghost btn-sm">Edit</button>
      </div>
      <div class="fsdo-email-row" id="fsdo-email-edit-row" hidden>
        <input id="fsdo-email-input" type="email" value="${esc(state.fsdoEmail)}" placeholder="FSDO email address…" />
        <button id="fsdo-email-done" type="button" class="btn btn-ghost btn-sm">Done</button>
      </div>
      ${override != null ? `<p class="hint">Using a custom email you entered.</p>` : ""}
      ${fellBack ? `<div class="fsdo-warn">ℹ The closest office (${esc(nearestAny.name)}, ${Math.round(nearestAnyD)} mi) has no published email, so this is the nearest office that does. Confirm it's the right one.</div>` : ""}
      ${unverified ? `<div class="fsdo-warn">⚠ This email is unverified — confirm it's correct before sending.</div>` : ""}
    `;

    const fsdoId = f.id;
    $("fsdo-email-edit").addEventListener("click", () => {
      $("fsdo-email-view").hidden = true;
      $("fsdo-email-edit-row").hidden = false;
      $("fsdo-email-input").focus();
    });
    $("fsdo-email-input").addEventListener("input", () => {
      state.fsdoEmail = $("fsdo-email-input").value.trim();
      state.fsdoEmailOverride = { fsdoId, email: state.fsdoEmail };
      validate();
    });
    $("fsdo-email-done").addEventListener("click", () => {
      $("fsdo-email-display").textContent = state.fsdoEmail;
      $("fsdo-email-edit-row").hidden = true;
      $("fsdo-email-view").hidden = false;
    });
    validate();
  }

  /* ------------------------------------------------------------------ */
  /* SAVED SPOTS (shared across the team via the Worker)                 */
  /* ------------------------------------------------------------------ */
  async function loadSpots() {
    if (!CFG.BACKEND_URL || CFG.BACKEND_URL.startsWith("PASTE")) return;
    try {
      const out = await backend({ action: "listSpots", pin: state.pin });
      if (out && out.ok) { state.spots = out.spots || []; renderSpots(); }
    } catch (_) { /* non-fatal — spots just stay empty */ }
  }

  function renderSpots() {
    const list = $("spot-list");
    list.innerHTML = "";
    state.spots.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.name;
      list.appendChild(o);
    });
  }

  function findSpotByName(name) {
    name = String(name || "").trim().toLowerCase();
    return state.spots.find((s) => s.name.toLowerCase() === name) || null;
  }

  function initSpots() {
    const search = $("spot-search");
    const hint = $("spot-hint");

    search.addEventListener("input", () => {
      const sp = findSpotByName(search.value);
      if (sp) {
        state.address = sp.address || null;
        setLocation(sp.lat, sp.lon, { fly: true });
        showAddress();
        hint.hidden = false;
        hint.innerHTML = `★ Loaded “${esc(sp.name)}”. <a href="#" id="spot-del" class="link-danger">Remove this saved spot</a>`;
        $("spot-del").addEventListener("click", (e) => { e.preventDefault(); deleteSpot(sp); });
      } else {
        hint.hidden = true;
      }
    });

    $("spot-save-btn").addEventListener("click", () => {
      if (state.lat == null) return;
      $("spot-save-row").hidden = false;
      $("spot-name").value = state.city || "";
      $("spot-name").focus();
    });
    $("spot-save-cancel").addEventListener("click", () => {
      $("spot-save-row").hidden = true; $("spot-name").value = "";
    });
    $("spot-name").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveSpot(); }
    });
    $("spot-save-confirm").addEventListener("click", saveSpot);
  }

  async function saveSpot() {
    const name = $("spot-name").value.trim();
    if (!name) { $("spot-name").focus(); return; }
    if (state.lat == null) { toast("Set a location first.", "err"); return; }
    const btn = $("spot-save-confirm");
    btn.disabled = true;
    try {
      const out = await backend({
        action: "saveSpot", pin: state.pin, name,
        lat: state.lat, lon: state.lon, address: state.address || ""
      });
      if (out && out.ok) {
        state.spots = out.spots || [];
        renderSpots();
        $("spot-save-row").hidden = true; $("spot-name").value = "";
        toast("Saved spot: " + name, "ok");
      } else {
        toast((out && out.error) || "Could not save spot.", "err");
      }
    } catch (_) { toast("Network error saving spot.", "err"); }
    btn.disabled = false;
  }

  async function deleteSpot(sp) {
    if (!sp) return;
    try {
      const out = await backend({ action: "deleteSpot", pin: state.pin, id: sp.id });
      if (out && out.ok) {
        state.spots = out.spots || [];
        renderSpots();
        $("spot-search").value = "";
        $("spot-hint").hidden = true;
        toast("Removed spot: " + sp.name, "ok");
      } else {
        toast((out && out.error) || "Could not remove spot.", "err");
      }
    } catch (_) { toast("Network error removing spot.", "err"); }
  }

  /* ------------------------------------------------------------------ */
  /* IMAGE UPLOAD                                                        */
  /* ------------------------------------------------------------------ */
  function initUpload() {
    const drop = $("excl-drop");
    const input = $("excl-image");

    input.addEventListener("change", () => { if (input.files[0]) handleFile(input.files[0]); });

    ["dragover", "dragenter"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
    ["dragleave", "drop"].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
    drop.addEventListener("drop", (e) => {
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith("image/")) handleFile(f);
    });

    $("excl-remove").addEventListener("click", () => {
      state.image = null;
      input.value = "";
      $("excl-preview-wrap").hidden = true;
      $("excl-drop").style.display = "";
      validate();
    });
  }

  function handleFile(file) {
    if (!file.type.startsWith("image/")) { toast("Please upload an image file.", "err"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(",")[1];
      state.image = { name: file.name, mimeType: file.type, dataBase64: base64 };
      $("excl-preview").src = dataUrl;
      $("excl-preview-wrap").hidden = false;
      $("excl-drop").style.display = "none";
      validate();
    };
    reader.readAsDataURL(file);
  }

  /* ------------------------------------------------------------------ */
  /* VALIDATION                                                          */
  /* ------------------------------------------------------------------ */
  function currentToEmail() {
    return (state.fsdoEmail || (state.nearest && state.nearest.email) || "").trim();
  }

  function validate() {
    const problems = [];
    if (!$("sender-name").value.trim()) problems.push("your name");
    if (state.lat == null) problems.push("a show location");
    if (!$("start-date").value) problems.push("a start date");
    if (!$("end-date").value) problems.push("an end date");
    if (!$("start-time").value || !$("end-time").value) problems.push("show times");
    if (!state.image) problems.push("the exclusion-zone image");
    if (!state.nearest) problems.push("a nearby FSDO");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentToEmail())) problems.push("a valid FSDO email");

    const ok = problems.length === 0;
    $("review-btn").disabled = !ok;
    $("validation-msg").textContent = ok ? "" : "Still needed: " + problems.join(", ") + ".";
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* EMAIL BUILD                                                         */
  /* ------------------------------------------------------------------ */
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function ordinal(n) {
    const s = ["th","st","nd","rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${MONTHS[m - 1]} ${ordinal(d)}`;
  }
  function fmtDateRange(startIso, endIso) {
    const a = fmtDate(startIso), b = fmtDate(endIso);
    if (!b || a === b) return a;
    // same month? "June 2nd - 6th" reads fine but keep month for clarity
    return `${a} - ${b}`;
  }
  function fmtTime(t) {
    if (!t) return "";
    let [h, m] = t.split(":").map(Number);
    const ap = h >= 12 ? "pm" : "am";
    h = h % 12; if (h === 0) h = 12;
    return m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`;
  }

  function buildSubject() {
    const place = [state.city, state.region].filter(Boolean).join(", ")
      || (state.nearest ? `${state.nearest.city}, ${state.nearest.state}` : "");
    const range = fmtDateRange($("start-date").value, $("end-date").value);
    return `Drone Light Show Notification — ${place}${range ? " (" + range + ")" : ""}`;
  }

  function buildBody() {
    const name = $("sender-name").value.trim();
    const range = fmtDateRange($("start-date").value, $("end-date").value);
    const t1 = fmtTime($("start-time").value);
    const t2 = fmtTime($("end-time").value);
    const alt = $("alt-ft").value || CFG.DEFAULT_ALT_FT || 400;
    const coords = `${state.lat}, ${state.lon}`;
    const addrLine = state.address ? `\n${state.address}` : "";

    return [
      "Hello,",
      "",
      "Below is our notification that we will be flying a drone light show in your area.",
      "",
      `Location of planned sUAS operation: ${coords}${addrLine}`,
      `Date(s) of operation: ${range}`,
      `Time(s) of operation: ${t1}–${t2}`,
      `Maximum altitude: no higher than ${alt} feet AGL.`,
      "",
      "I have attached our waiver and CoW as well as the flight plan and exclusion zone screenshot.",
      "",
      "Thank you,",
      name
    ].join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* REVIEW MODAL                                                        */
  /* ------------------------------------------------------------------ */
  function openReview() {
    if (!validate()) return;
    $("rv-from").textContent = CFG.FROM_LABEL || "orders@illuminatedrones.com";
    $("rv-to").value = currentToEmail();
    $("rv-to-name").textContent = state.nearest ? state.nearest.name : "";
    $("rv-cc").textContent = (CFG.CC || []).join(", ");
    $("rv-subject").value = buildSubject();
    $("rv-body").value = buildBody();

    const att = $("rv-attach");
    att.innerHTML = "";
    [CFG.WAIVER_ZIP_LABEL || "Waiver packet.zip", state.image.name].forEach((n) => {
      const li = document.createElement("li");
      li.textContent = n;
      att.appendChild(li);
    });

    $("send-status").textContent = "";
    $("send-status").className = "send-status";
    $("review-modal").hidden = false;
  }

  function closeReview() { $("review-modal").hidden = true; }

  /* ------------------------------------------------------------------ */
  /* SEND                                                                */
  /* ------------------------------------------------------------------ */
  async function send() {
    const to = $("rv-to").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setSendStatus("Enter a valid FSDO email address.", "err");
      return;
    }
    if (!CFG.BACKEND_URL || CFG.BACKEND_URL.startsWith("PASTE")) {
      setSendStatus("Backend not configured yet (BACKEND_URL in config.js).", "err");
      return;
    }

    const btn = $("send-btn");
    btn.disabled = true;
    setSendStatus('<span class="spin"></span>Sending…', "");

    const payload = {
      pin: state.pin,
      senderName: $("sender-name").value.trim(),
      to: to,
      toName: state.nearest ? state.nearest.name : "",
      cc: CFG.CC || [],
      subject: $("rv-subject").value,
      body: $("rv-body").value,
      image: state.image, // { name, mimeType, dataBase64 }
      meta: {
        lat: state.lat, lon: state.lon, address: state.address,
        fsdoId: state.nearest ? state.nearest.id : null
      }
    };

    try {
      const res = await fetch(CFG.BACKEND_URL, {
        method: "POST",
        // text/plain keeps this a "simple" request → no CORS preflight to Apps Script
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let out;
      try { out = JSON.parse(text); } catch (_) { out = { ok: res.ok, raw: text }; }

      if (out.ok) {
        setSendStatus("✅ Sent to " + to + (out.cc ? " (cc " + out.cc + ")" : ""), "ok");
        btn.textContent = "Sent ✓";
        setTimeout(() => { closeReview(); resetAfterSend(); }, 1800);
      } else {
        setSendStatus("❌ " + (out.error || "Send failed. Check the Apps Script logs."), "err");
        btn.disabled = false;
      }
    } catch (err) {
      setSendStatus("❌ Network error: " + err.message +
        " — the backend Worker may be unreachable. Check your connection and try again.", "err");
      btn.disabled = false;
    }
  }

  function setSendStatus(html, cls) {
    const el = $("send-status");
    el.innerHTML = html;
    el.className = "send-status" + (cls ? " " + cls : "");
  }

  function resetAfterSend() {
    $("send-btn").disabled = false;
    $("send-btn").textContent = "Send to FSDO";
    toast("Notification sent. You can submit another show.", "ok");
  }

  /* ------------------------------------------------------------------ */
  /* MISC                                                                */
  /* ------------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  let toastTimer;
  function toast(msg, cls) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (cls ? " " + cls : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  }

  /* ------------------------------------------------------------------ */
  /* INIT                                                                */
  /* ------------------------------------------------------------------ */
  function initApp() {
    initMap();
    initSearch();
    initCoordEntry();
    initSpots();
    initUpload();
    loadFsdos();
    loadSpots();

    $("alt-ft").value = CFG.DEFAULT_ALT_FT || 400;

    // popup calendars; end date can't be before start date
    if (window.flatpickr) {
      const endFp = flatpickr("#end-date", {
        dateFormat: "Y-m-d", altInput: true, altFormat: "M j, Y", disableMobile: true, onChange: validate
      });
      flatpickr("#start-date", {
        dateFormat: "Y-m-d", altInput: true, altFormat: "M j, Y", disableMobile: true,
        onChange: function (sel) { if (sel[0]) endFp.set("minDate", sel[0]); validate(); }
      });
    }

    ["sender-name", "start-time", "end-time", "alt-ft"]
      .forEach((id) => $(id).addEventListener("input", validate));

    $("review-btn").addEventListener("click", openReview);
    $("review-close").addEventListener("click", closeReview);
    $("send-cancel").addEventListener("click", closeReview);
    $("send-btn").addEventListener("click", send);
    $("review-modal").addEventListener("click", (e) => { if (e.target === $("review-modal")) closeReview(); });

    validate();
  }

  initLock();
})();
