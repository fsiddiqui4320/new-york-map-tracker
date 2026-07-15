/* New York, Explored — neighborhood tracker
   Vanilla JS + Leaflet. State in localStorage, photos in IndexedDB. */
(function () {
  "use strict";

  const STATE_KEY = "nyc-tracker-state-v1";
  const COACH_KEY = "nyc-tracker-coach-v1";
  const SETTINGS_KEY = "nyc-tracker-settings-v1";
  const DATA_URL = "data/neighborhoods.geojson";
  const LABEL_ZOOM = 13; // labels appear at this zoom and above

  // ---------- Settings ----------
  const DEFAULT_SETTINGS = { tapMode: "open" }; // 'open' = tap previews; 'mark' = tap colors in
  let SETTINGS = loadSettings();
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(raw));
    } catch (e) {}
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch (e) {}
  }

  // ---------- State ----------
  let STATE = load();
  function load() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return { hoods: {} };
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch (e) {
        toast("Couldn't save — storage may be full");
      }
    }, 120);
  }
  function hoodState(id) {
    if (!STATE.hoods[id]) STATE.hoods[id] = { visited: false, notes: "", visitedAt: 0 };
    return STATE.hoods[id];
  }

  // ---------- Colors ----------
  // Deterministic, evenly-spread pastel per neighborhood (golden-angle hue).
  const colorMap = {};
  function buildColors(trackableIdsSorted) {
    trackableIdsSorted.forEach((id, i) => {
      const hue = (i * 137.508) % 360;
      colorMap[id] = {
        fill: `hsl(${hue.toFixed(1)}, 62%, 72%)`,
        stroke: `hsl(${hue.toFixed(1)}, 52%, 52%)`,
      };
    });
  }
  function colorFor(id) { return colorMap[id] || { fill: "#cfc9be", stroke: "#a89f90" }; }

  // ---------- DOM refs ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    statCount: $("stat-count"), progressFill: $("progress-fill"), statPill: $("stat-pill"),
    menuBtn: $("menu-btn"), menuPop: $("menu-pop"), importInput: $("import-input"),
    overlay: $("overlay"), modal: $("modal"),
    sheet: $("sheet"), sheetClose: $("sheet-close"),
    dDot: $("d-dot"), dName: $("d-name"), dBoro: $("d-boro"),
    dVisit: $("d-visit"), dVisitMeta: $("d-visitmeta"),
    dNotes: $("d-notes"), dSaveHint: $("d-savehint"),
    dAddPhoto: $("d-addphoto"), dPhotoInput: $("d-photoinput"), dPhotos: $("d-photos"),
    searchWrap: $("search-wrap"), searchInput: $("search-input"), searchClear: $("search-clear"),
    searchResults: $("search-results"), searchBox: document.querySelector(".search-box"),
    locateBtn: $("locate-btn"),
    lightbox: $("lightbox"), lbImg: $("lb-img"), lbClose: $("lb-close"), lbDelete: $("lb-delete"),
    toast: $("toast"), brandSub: $("brand-sub"),
  };

  // ---------- Data / map ----------
  let features = [];          // all geojson features
  let byId = {};              // id -> feature
  let hoodLayers = {};        // id -> leaflet layer
  let boroughTotals = {};     // boro -> count of trackable
  let TRACKABLE_TOTAL = 0;
  let map, currentId = null, locMarker = null;

  const BORO_COLORS = {
    "Manhattan": "#ff7a59", "Brooklyn": "#5bc0be", "Queens": "#f2b134",
    "Bronx": "#9b8cff", "Staten Island": "#ef8ab5",
  };

  fetch(DATA_URL)
    .then((r) => r.json())
    .then((geo) => { features = geo.features; initData(); initMap(geo); updateProgress(); maybeCoach(); })
    .catch((err) => { console.error(err); toast("Couldn't load the map data"); });

  function initData() {
    const trackable = features.filter((f) => f.properties.trackable);
    TRACKABLE_TOTAL = trackable.length;
    trackable.forEach((f) => {
      const b = f.properties.borough;
      boroughTotals[b] = (boroughTotals[b] || 0) + 1;
    });
    buildColors(trackable.map((f) => f.properties.id).sort());
    features.forEach((f) => { byId[f.properties.id] = f; });
  }

  // ---------- Map ----------
  function styleFor(feature) {
    const p = feature.properties;
    if (!p.trackable) {
      return { fillColor: "#d9ead0", fillOpacity: 0.55, color: "#c3d6b6", weight: 1, interactive: false };
    }
    const st = hoodState(p.id);
    const c = colorFor(p.id);
    if (st.visited) {
      return { fillColor: c.fill, fillOpacity: 0.82, color: c.stroke, weight: 1.4, opacity: 1 };
    }
    return { fillColor: "#ffffff", fillOpacity: 0.04, color: "#b9b2a6", weight: 1, opacity: 0.75, dashArray: "3 4" };
  }

  function initMap(geo) {
    map = L.map("map", {
      zoomControl: false,
      minZoom: 10, maxZoom: 18,
      maxBounds: [[40.42, -74.32], [40.99, -73.63]],
      maxBoundsViscosity: 0.8,
      tap: true,
    });
    L.control.zoom({ position: "topleft" }).addTo(map);

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        subdomains: "abcd", maxZoom: 20,
        attribution:
          '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a> · Neighborhoods: NYC DOHMH',
      }
    ).addTo(map);

    const isTouch = window.matchMedia("(hover: none)").matches;

    L.geoJSON(geo, {
      style: styleFor,
      onEachFeature: (feature, layer) => {
        const p = feature.properties;
        if (!p.trackable) return;
        hoodLayers[p.id] = layer;
        layer.bindTooltip(shortLabel(p.name), {
          permanent: true, direction: "center", className: "hood-label", opacity: 1,
        });
        if (!isTouch) {
          layer.on("mouseover", () => {
            if (!hoodState(p.id).visited) layer.setStyle({ fillOpacity: 0.18, weight: 1.6 });
            forceLabel(p.id, true);
          });
          layer.on("mouseout", () => { refreshLayer(p.id); forceLabel(p.id, false); });
        }
        layer.on("click", () => onHoodTap(p.id));
      },
    }).addTo(map);

    map.on("zoomend", updateLabelVisibility);
    map.fitBounds([[40.495, -74.255], [40.915, -73.70]], { padding: [10, 10] });
    updateLabelVisibility();
  }

  // Shorten long combined NTA names for on-map labels (full name stays in the card/search)
  function shortLabel(name) {
    if (name.length > 16 && name.includes("-")) return name.split("-")[0].trim();
    return name;
  }
  function updateLabelVisibility() {
    const on = map.getZoom() >= LABEL_ZOOM;
    document.getElementById("map").classList.toggle("labels-on", on);
  }
  function forceLabel(id, on) {
    const layer = hoodLayers[id];
    if (!layer) return;
    const tip = layer.getTooltip();
    const node = tip && tip.getElement();
    if (node) node.classList.toggle("label-force", on);
  }

  function refreshLayer(id) {
    const layer = hoodLayers[id];
    if (layer) layer.setStyle(styleFor(byId[id]));
  }

  function onHoodTap(id) {
    if (SETTINGS.tapMode === "mark" && !hoodState(id).visited) {
      setVisited(id, true, /*silent*/ true);
      toast(byId[id].properties.name + " — colored in! 🎨");
    }
    openSheet(id);
    dismissCoach();
  }

  function setVisited(id, visited, silent) {
    const st = hoodState(id);
    st.visited = visited;
    st.visitedAt = visited ? (st.visitedAt || Date.now()) : 0;
    save();
    refreshLayer(id);
    updateProgress();
    if (currentId === id) syncSheetVisited(id);
    if (!silent && visited) toast(byId[id].properties.name + " — colored in! 🎨");
  }

  // ---------- Progress ----------
  function visitedCount() {
    return Object.keys(STATE.hoods).filter(
      (id) => STATE.hoods[id].visited && byId[id] && byId[id].properties.trackable
    ).length;
  }
  function updateProgress() {
    const n = visitedCount();
    const pct = TRACKABLE_TOTAL ? (n / TRACKABLE_TOTAL) * 100 : 0;
    el.statCount.textContent = n;
    document.querySelector(".pill-total").textContent = "/" + TRACKABLE_TOTAL;
    el.progressFill.style.width = pct.toFixed(1) + "%";
    if (el.brandSub) {
      el.brandSub.textContent = n === 0
        ? "Tap a neighborhood to color it in"
        : `You've explored ${pct.toFixed(0)}% of New York`;
    }
  }

  // ---------- Detail sheet ----------
  function openSheet(id) {
    currentId = id;
    const p = byId[id].properties;
    const c = colorFor(id);
    el.dDot.style.background = c.fill;
    el.dDot.style.borderColor = c.stroke;
    el.dName.textContent = p.name;
    el.dBoro.textContent = p.borough;
    el.dBoro.style.color = BORO_COLORS[p.borough] || "";
    el.dNotes.value = hoodState(id).notes || "";
    el.dSaveHint.classList.remove("show");
    syncSheetVisited(id);
    renderPhotos(id);
    el.sheet.classList.add("open");
    el.sheet.setAttribute("aria-hidden", "false");
  }
  function closeSheet() {
    el.sheet.classList.remove("open");
    el.sheet.setAttribute("aria-hidden", "true");
    currentId = null;
  }
  function syncSheetVisited(id) {
    const st = hoodState(id);
    el.sheet.classList.toggle("visited", st.visited);
    el.dVisit.querySelector(".vt-label").textContent = st.visited ? "Visited" : "Mark as visited";
    el.dVisit.querySelector(".vt-icon").textContent = st.visited ? "✓" : "";
    if (st.visited && st.visitedAt) {
      const d = new Date(st.visitedAt);
      el.dVisitMeta.textContent = "First colored in " + d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    } else {
      el.dVisitMeta.textContent = "";
    }
  }

  el.dVisit.addEventListener("click", () => {
    if (!currentId) return;
    setVisited(currentId, !hoodState(currentId).visited);
  });
  el.sheetClose.addEventListener("click", closeSheet);

  // Notes autosave
  let notesTimer = null;
  el.dNotes.addEventListener("input", () => {
    if (!currentId) return;
    hoodState(currentId).notes = el.dNotes.value;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      save();
      el.dSaveHint.textContent = "Saved ✓";
      el.dSaveHint.classList.add("show");
      setTimeout(() => el.dSaveHint.classList.remove("show"), 1400);
    }, 500);
  });

  // ---------- Photos ----------
  el.dAddPhoto.addEventListener("click", () => el.dPhotoInput.click());
  el.dPhotoInput.addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!currentId || !files.length) return;
    const id = currentId;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const placeholder = document.createElement("div");
      placeholder.className = "photo-thumb uploading";
      el.dPhotos.appendChild(placeholder);
      try {
        const blob = await resizeImage(file);
        const rec = { id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7), hood: id, blob, createdAt: Date.now() };
        await PhotoStore.add(rec);
        // If it was the first visit trigger, also mark visited
        if (!hoodState(id).visited) setVisited(id, true, true);
      } catch (err) {
        console.error(err); toast("Couldn't add that photo");
      }
      placeholder.remove();
      if (currentId === id) renderPhotos(id);
    }
  });

  async function renderPhotos(id) {
    const photos = await PhotoStore.listForHood(id);
    if (currentId !== id) return;
    el.dPhotos.innerHTML = "";
    photos.forEach((rec) => {
      const url = URL.createObjectURL(rec.blob);
      const div = document.createElement("div");
      div.className = "photo-thumb";
      const img = document.createElement("img");
      img.src = url; img.alt = "Photo";
      div.appendChild(img);
      div.addEventListener("click", () => openLightbox(rec.id, url, id));
      el.dPhotos.appendChild(div);
    });
  }

  function resizeImage(file, maxDim = 1400, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (Math.max(width, height) > maxDim) {
          const s = maxDim / Math.max(width, height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      img.src = url;
    });
  }

  // Lightbox
  let lbCurrent = null;
  function openLightbox(photoId, url, hoodId) {
    lbCurrent = { photoId, hoodId };
    el.lbImg.src = url;
    el.lightbox.hidden = false;
  }
  el.lbClose.addEventListener("click", () => { el.lightbox.hidden = true; lbCurrent = null; });
  el.lbDelete.addEventListener("click", async () => {
    if (!lbCurrent) return;
    await PhotoStore.remove(lbCurrent.photoId);
    const hoodId = lbCurrent.hoodId;
    el.lightbox.hidden = true; lbCurrent = null;
    if (currentId === hoodId) renderPhotos(hoodId);
    toast("Photo deleted");
  });

  // ---------- Search ----------
  el.searchInput.addEventListener("input", () => {
    const q = el.searchInput.value.trim().toLowerCase();
    el.searchBox.classList.toggle("has-text", q.length > 0);
    if (!q) { el.searchResults.classList.remove("open"); el.searchResults.innerHTML = ""; return; }
    const matches = features
      .filter((f) => f.properties.trackable && f.properties.name.toLowerCase().includes(q))
      .slice(0, 12);
    renderSearch(matches);
  });
  el.searchClear.addEventListener("click", () => {
    el.searchInput.value = ""; el.searchBox.classList.remove("has-text");
    el.searchResults.classList.remove("open"); el.searchInput.focus();
  });
  function renderSearch(matches) {
    el.searchResults.innerHTML = "";
    if (!matches.length) {
      el.searchResults.innerHTML = '<li class="sr-empty">No neighborhood found</li>';
      el.searchResults.classList.add("open");
      return;
    }
    matches.forEach((f) => {
      const p = f.properties;
      const c = colorFor(p.id);
      const li = document.createElement("li");
      const visited = hoodState(p.id).visited;
      li.innerHTML =
        `<span class="sr-dot" style="background:${visited ? c.fill : "#eee"};border-color:${c.stroke}"></span>` +
        `<span class="sr-name">${escapeHtml(p.name)}</span>` +
        (visited ? '<span class="sr-check">✓</span>' : "") +
        `<span class="sr-boro">${escapeHtml(p.borough)}</span>`;
      li.addEventListener("click", () => {
        flyToHood(p.id);
        el.searchResults.classList.remove("open");
        el.searchInput.value = ""; el.searchBox.classList.remove("has-text");
      });
      el.searchResults.appendChild(li);
    });
    el.searchResults.classList.add("open");
  }
  document.addEventListener("click", (e) => {
    if (!el.searchWrap.contains(e.target)) el.searchResults.classList.remove("open");
  });

  function flyToHood(id) {
    const layer = hoodLayers[id];
    if (!layer) return;
    map.fitBounds(layer.getBounds(), { padding: [60, 60], maxZoom: 15 });
    openSheet(id);
    // brief highlight
    const orig = styleFor(byId[id]);
    layer.setStyle({ weight: 3, color: "#ff7a59" });
    setTimeout(() => layer.setStyle(orig), 900);
  }

  // ---------- Locate ----------
  el.locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) { toast("Location isn't available on this device"); return; }
    el.locateBtn.classList.add("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        el.locateBtn.classList.remove("locating");
        const { latitude, longitude } = pos.coords;
        showLocation(latitude, longitude);
      },
      () => { el.locateBtn.classList.remove("locating"); toast("Couldn't get your location"); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });

  function showLocation(lat, lng) {
    if (locMarker) map.removeLayer(locMarker);
    locMarker = L.circleMarker([lat, lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#2f7cf6", fillOpacity: 1,
    }).addTo(map);
    const hood = findHoodAt(lng, lat);
    if (hood) {
      map.setView([lat, lng], 14, { animate: true });
      openSheet(hood.properties.id);
      toast("Looks like you're in " + hood.properties.name);
    } else {
      map.setView([lat, lng], 14, { animate: true });
      toast("You're here — but not in a tracked neighborhood");
    }
  }

  // Point-in-polygon (ray casting), supports Polygon & MultiPolygon
  function findHoodAt(lng, lat) {
    for (const f of features) {
      if (!f.properties.trackable) continue;
      if (pointInGeometry(lng, lat, f.geometry)) return f;
    }
    return null;
  }
  function pointInGeometry(x, y, geom) {
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      if (pointInPolygonRings(x, y, poly)) return true;
    }
    return false;
  }
  function pointInPolygonRings(x, y, rings) {
    if (!pointInRing(x, y, rings[0])) return false; // outer
    for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i])) return false; // holes
    return true;
  }
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ---------- Menu ----------
  el.menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    el.menuPop.hidden = !el.menuPop.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!el.menuPop.hidden && !el.menuPop.contains(e.target) && e.target !== el.menuBtn)
      el.menuPop.hidden = true;
  });
  el.menuPop.addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    el.menuPop.hidden = true;
    const act = btn.dataset.act;
    if (act === "stats") showStats();
    else if (act === "settings") showSettings();
    else if (act === "export") exportData();
    else if (act === "import") el.importInput.click();
    else if (act === "about") showAbout();
    else if (act === "reset") confirmReset();
  });
  el.statPill.addEventListener("click", showStats);

  // ---------- Modals ----------
  function openModal(html) {
    el.modal.innerHTML = html;
    el.overlay.hidden = false;
    el.modal.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModal));
  }
  function closeModal() { el.overlay.hidden = true; el.modal.innerHTML = ""; }
  el.overlay.addEventListener("click", (e) => { if (e.target === el.overlay) closeModal(); });

  function showStats() {
    const total = TRACKABLE_TOTAL;
    const n = visitedCount();
    const pct = total ? Math.round((n / total) * 100) : 0;
    const boros = Object.keys(boroughTotals).sort();
    let rows = "";
    boros.forEach((b) => {
      const tot = boroughTotals[b];
      const done = Object.keys(STATE.hoods).filter(
        (id) => STATE.hoods[id].visited && byId[id] && byId[id].properties.trackable && byId[id].properties.borough === b
      ).length;
      const bpct = tot ? Math.round((done / tot) * 100) : 0;
      rows +=
        `<div class="boro-row">
          <div class="boro-row-top"><span class="boro-row-name">${b}</span>
          <span class="boro-row-num">${done} / ${tot} · ${bpct}%</span></div>
          <div class="boro-bar"><div class="boro-bar-fill" style="width:0%;background:${BORO_COLORS[b] || "#ccc"}" data-w="${bpct}"></div></div>
        </div>`;
    });
    openModal(
      `<h2>Your New York</h2>
       <div class="stat-big"><div class="num">${n}</div><div class="lbl">of ${total} neighborhoods explored · ${pct}%</div></div>
       ${rows}
       <div class="modal-close-row"><button class="btn btn-ghost" data-close>Close</button></div>`
    );
    // animate bars
    requestAnimationFrame(() =>
      el.modal.querySelectorAll(".boro-bar-fill").forEach((f) => (f.style.width = f.dataset.w + "%"))
    );
  }

  function showSettings() {
    const opt = (mode, title, desc) =>
      `<button class="opt ${SETTINGS.tapMode === mode ? "sel" : ""}" data-mode="${mode}">
         <span class="opt-title">${title}</span>
         <span class="opt-desc">${desc}</span>
       </button>`;
    openModal(
      `<h2>Settings</h2>
       <p class="modal-sub">When you tap a neighborhood on the map…</p>
       <div class="opt-list">
         ${opt("open", "Just show me the neighborhood",
              "Tapping opens the neighborhood's card so you can read the name, notes and photos. You color it in with the “Visited” button — nothing gets marked by accident.")}
         ${opt("mark", "Color it in right away",
              "Tapping instantly marks the neighborhood visited and opens its card. Fastest for checking off lots of places quickly.")}
       </div>
       <div class="modal-close-row"><button class="btn btn-primary" data-close>Done</button></div>`
    );
    el.modal.querySelectorAll(".opt").forEach((b) =>
      b.addEventListener("click", () => {
        SETTINGS.tapMode = b.dataset.mode;
        saveSettings();
        el.modal.querySelectorAll(".opt").forEach((x) => x.classList.toggle("sel", x === b));
      })
    );
  }

  function showAbout() {
    openModal(
      `<h2>About this map 🗽</h2>
       <p class="modal-sub">A little travel diary for New York City.</p>
       <p style="font-size:14.5px;line-height:1.6;color:#4a4a55">
       Tap any of the <b>${TRACKABLE_TOTAL} neighborhoods</b> across all five boroughs to color it in as
       you visit. Add notes and photos to remember each place. Everything is saved privately
       on <b>this device</b> — nothing is uploaded anywhere.</p>
       <p style="font-size:13px;line-height:1.6;color:#8a8a95">
       Because it's stored only on your device, use <b>Export my data</b> now and then to keep a backup —
       especially before clearing your browser. Neighborhood boundaries: NYC Dept. of Health (NTA).
       Basemap: CARTO / OpenStreetMap.</p>
       <div class="modal-close-row"><button class="btn btn-primary" data-close>Got it</button></div>`
    );
  }

  function confirmReset() {
    openModal(
      `<h2>Reset everything?</h2>
       <p class="modal-sub">This clears every colored-in neighborhood, all notes and all photos on this device. This can't be undone.</p>
       <p style="font-size:13px;color:#8a8a95">Tip: export a backup first if you might want it later.</p>
       <div class="modal-close-row">
         <button class="btn btn-ghost" data-close>Cancel</button>
         <button class="btn btn-danger" id="do-reset">Reset all</button>
       </div>`
    );
    $("do-reset").addEventListener("click", async () => {
      STATE = { hoods: {} };
      try { localStorage.removeItem(STATE_KEY); } catch (e) {}
      await PhotoStore.clearAll();
      Object.keys(hoodLayers).forEach(refreshLayer);
      updateProgress();
      closeSheet(); closeModal();
      toast("Everything reset");
    });
  }

  // ---------- Export / Import ----------
  async function exportData() {
    toast("Preparing your backup…");
    try {
      const photos = await PhotoStore.exportAll();
      const payload = { app: "nyc-tracker", version: 1, exportedAt: new Date().toISOString(), state: STATE, photos };
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "new-york-explored-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast("Backup downloaded ⬇️");
    } catch (e) { console.error(e); toast("Export failed"); }
  }

  el.importInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.app !== "nyc-tracker" || !data.state) throw new Error("Not a valid backup");
      openModal(
        `<h2>Import this backup?</h2>
         <p class="modal-sub">This replaces your current map with the backup from ${new Date(data.exportedAt).toLocaleString()}.</p>
         <div class="modal-close-row">
           <button class="btn btn-ghost" data-close>Cancel</button>
           <button class="btn btn-primary" id="do-import">Import</button>
         </div>`
      );
      $("do-import").addEventListener("click", async () => {
        STATE = data.state && data.state.hoods ? data.state : { hoods: {} };
        save();
        await PhotoStore.clearAll();
        await PhotoStore.importAll(data.photos || []);
        Object.keys(hoodLayers).forEach(refreshLayer);
        updateProgress();
        if (currentId) renderPhotos(currentId);
        closeModal();
        toast("Backup restored 🎉");
      });
    } catch (err) {
      console.error(err); toast("That file isn't a valid backup");
    }
  });

  // ---------- Coach mark ----------
  function maybeCoach() {
    updateProgress();
    let seen = false;
    try { seen = localStorage.getItem(COACH_KEY); } catch (e) {}
    if (seen || visitedCount() > 0) return;
    const c = document.createElement("div");
    c.className = "coach";
    c.id = "coach";
    const how = SETTINGS.tapMode === "mark"
      ? 'tap a neighborhood to <b>color it in</b>'
      : 'tap a neighborhood, then press <b>Visited</b> to color it in';
    c.innerHTML = `Zoom in to see names — ${how} <button id="coach-ok">Got it</button>`;
    document.body.appendChild(c);
    $("coach-ok").addEventListener("click", dismissCoach);
  }
  function dismissCoach() {
    const c = $("coach");
    if (c) c.remove();
    try { localStorage.setItem(COACH_KEY, "1"); } catch (e) {}
  }

  // ---------- Helpers ----------
  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove("show");
      setTimeout(() => (el.toast.hidden = true), 300);
    }, 2400);
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
