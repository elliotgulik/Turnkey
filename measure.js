// TurnKey hosted measurement workspace — opened by the Google Earth Chrome
// extension (extension/background/service-worker.js) in its own tab, on
// this site's own origin. This page loads its own config.js and the
// Google Maps JS SDK directly, same as index.html/booking.html already do,
// so there is no remote-hosted-code-in-an-extension problem and no extra
// Maps key for the operator to configure.
//
// This page collects raw {lat,lng,altitude?} points and shows a LIVE
// preview using the SAME geometry.js the extension's content bridge uses
// as the authoritative calculation (extension/content/bridge/measure-bridge.js)
// — not a second, merely-similar implementation using the Maps SDK's own
// spherical-geometry helpers. geometry.js is deployed to this site's own
// root by scripts/build-static.js (copied from extension/geometry.js) —
// loading it here is just this website importing its own same-origin JS,
// not the extension loading remote code.
import { measureGeometry, validatePoints, distanceMeters } from './geometry.js';

const params = new URLSearchParams(location.search);
const requestId = params.get('requestId') || '';
const category = params.get('category') || 'area';
const categoryLabel = params.get('label') || 'Area';
const kind = ['area', 'perimeter', 'line'].includes(params.get('kind')) ? params.get('kind') : 'area';
const interaction = kind === 'line' ? 'open' : 'closed';
const startLat = parseFloat(params.get('lat'));
const startLng = parseFloat(params.get('lng'));

const els = {
  category: document.getElementById('tkm-category'),
  modeToggle: document.getElementById('tkm-mode-toggle'),
  viewToggle: document.getElementById('tkm-view-toggle'),
  map2d: document.getElementById('tkm-map-2d'),
  map3d: document.getElementById('tkm-map-3d'),
  unavailable3d: document.getElementById('tkm-3d-unavailable'),
  steadyHint: document.getElementById('tkm-steady-hint'),
  state: document.getElementById('tkm-state'),
  readout: document.getElementById('tkm-readout'),
  undo: document.getElementById('tkm-undo'),
  clear: document.getElementById('tkm-clear'),
  finish: document.getElementById('tkm-finish')
};
els.category.textContent = categoryLabel;

function setState(html) {
  els.state.hidden = false;
  els.state.innerHTML = `<div class="tkm-state-box">${html}</div>`;
}
function setErrorState(message, { retry } = {}) {
  els.state.hidden = false;
  els.state.innerHTML = `<div class="tkm-state-box tkm-error"><p>${escapeHtml(message)}</p>${
    retry ? '<button type="button" id="tkm-retry">Retry</button>' : ''
  }</div>`;
  if (retry) document.getElementById('tkm-retry').addEventListener('click', retry);
}
function clearState() {
  els.state.hidden = true;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (!requestId || Number.isNaN(startLat) || Number.isNaN(startLng)) {
  setErrorState('This page was opened without a valid property location. Go back to Google Earth and use the TurnKey toolbar’s Measure button again.');
  throw new Error('measure.html: missing/invalid requestId or lat/lng');
}

const cfg = window.TURNKEY_CONFIG || {};
if (!cfg.mapsKey) {
  setErrorState('Satellite measuring needs a Google Maps API key configured for this TurnKey site (TURNKEY_MAPS_KEY). Ask whoever manages your TurnKey deployment to set it, then reload.');
  throw new Error('measure.html: no mapsKey configured');
}

// ── Shared point/mode state ─────────────────────────────────────────────
// Canonical list of real points ({lat, lng, altitude?}) — both the 2D and
// 3D views render from this one array and push into it, so switching views
// never loses or re-derives a point from screen pixels.
let points = [];
let activeView = '2d';
// Explicit, operator-chosen — NEVER auto-inferred from whether points
// happen to carry an altitude. Always starts (and falls back to) 'ground'.
let mode = 'ground';
let map2d = null;
let overlay2d = null; // google.maps.Polygon | Polyline
let markers2d = [];
let map3d = null;
let markers3d = [];
let overlay3d = null; // gmp-polygon-3d | gmp-polyline-3d
let maps3dAvailable = false;
let cameraSteady = false;

function minPoints() {
  return interaction === 'open' ? 2 : 3;
}

/** Live, non-blocking preview using the SAME geometry.js the extension bridge will ultimately call — if this throws (not enough points yet, self-intersection, missing altitude for a requested surface mode, etc.) the message IS the user-facing hint, not a generic fallback. */
function livePreview() {
  if (points.length < minPoints()) return { hint: `Click points on the map to trace ${interaction === 'open' ? 'the line' : 'the outline'}.` };
  try {
    const result = measureGeometry(points, { kind, mode });
    return { result };
  } catch (err) {
    return { hint: err.message, blocked: true };
  }
}

function boundingDiagonalMeters() {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = distanceMeters(points[i], points[j]);
      if (d > max) max = d;
    }
  }
  return max;
}

function render() {
  const preview = livePreview();
  const canFinish = points.length >= minPoints() && !preview.blocked;
  els.finish.disabled = !canFinish;
  els.undo.disabled = points.length === 0;
  els.clear.disabled = points.length === 0;

  let readout;
  if (preview.result) {
    const r = preview.result;
    const estimated = mode === 'surface' ? ' <span class="tkm-estimated">(3D surface estimate — trace each flat face separately for best accuracy)</span>' : '';
    readout = kind === 'area'
      ? `<strong>${Math.round(r.value * 10) / 10} m²</strong> · perimeter ${Math.round(r.perimeter)} m${estimated}`
      : `<strong>${Math.round(r.value * 10) / 10} m</strong>${estimated}`;
  } else {
    readout = escapeHtml(preview.hint);
  }
  const diag = boundingDiagonalMeters();
  if (diag > 1000) {
    readout += ` <span class="tkm-warn">— this trace spans over ${Math.round(diag)} m; zoom in for an accurate measurement.</span>`;
  }
  els.readout.innerHTML = readout;

  renderOverlay2d();
  renderOverlay3d();
}

// ── Explicit ground-vs-3D-surface mode control ──────────────────────────
function updateModeToggle() {
  const surfaceBtn = els.modeToggle.querySelector('[data-mode="surface"]');
  const canOfferSurface = activeView === '3d';
  surfaceBtn.disabled = !canOfferSurface;
  surfaceBtn.textContent = kind === 'line' ? '3D distance' : '3D surface';
  els.modeToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-mode') === mode));
}
function setMode(next) {
  if (next === 'surface' && activeView !== '3d') return; // never reachable without being in 3D view in the first place
  mode = next;
  updateModeToggle();
  render();
}
els.modeToggle.addEventListener('click', (e) => {
  const m = e.target.getAttribute('data-mode');
  if (m) setMode(m);
});

// ── 2D satellite view ────────────────────────────────────────────────────
function initMap2d() {
  map2d = new google.maps.Map(els.map2d, {
    center: { lat: startLat, lng: startLng },
    zoom: 20,
    mapTypeId: 'satellite',
    tilt: 0,
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: false
  });
  map2d.addListener('click', (e) => {
    addPoint({ lat: e.latLng.lat(), lng: e.latLng.lng() });
  });
}
function renderOverlay2d() {
  if (activeView !== '2d') return;
  markers2d.forEach((m) => m.setMap(null));
  markers2d = points.map((p, i) => new google.maps.Marker({
    position: { lat: p.lat, lng: p.lng },
    map: map2d,
    label: { text: String(i + 1), color: '#fff', fontSize: '11px' },
    icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#0f7d6b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
  }));
  if (overlay2d) overlay2d.setMap(null);
  const path = points.map((p) => ({ lat: p.lat, lng: p.lng }));
  if (points.length > 1) {
    overlay2d = interaction === 'closed'
      ? new google.maps.Polygon({ paths: path, map: map2d, fillColor: '#0f7d6b', fillOpacity: 0.18, strokeColor: '#0f7d6b', strokeWeight: 3 })
      : new google.maps.Polyline({ path, map: map2d, strokeColor: '#0f7d6b', strokeWeight: 3 });
  } else {
    overlay2d = null;
  }
}

// ── 3D "Inspect" view (optional — multi-angle, altitude-aware) ──────────
async function tryInit3d() {
  try {
    const maps3d = await google.maps.importLibrary('maps3d');
    if (!maps3d || !maps3d.Map3DElement) throw new Error('maps3d library unavailable');
    map3d = new maps3d.Map3DElement({
      center: { lat: startLat, lng: startLng, altitude: 0 },
      range: 300,
      tilt: 60,
      heading: 0,
      mode: maps3d.MapMode ? maps3d.MapMode.SATELLITE : 'SATELLITE'
    });
    els.map3d.appendChild(map3d);
    // Only add a point once the camera has actually settled — a click
    // mid-flight (the operator still panning/tilting/zooming) can land on
    // a transient, not-yet-resolved 3D position. gmp-steadychange is the
    // Map3DElement's own signal for this.
    map3d.addEventListener('gmp-steadychange', (e) => {
      cameraSteady = !!e.isSteady;
      els.steadyHint.hidden = cameraSteady;
    });
    map3d.addEventListener('gmp-click', (e) => {
      if (!cameraSteady) return;
      if (map3d.range > 1500) {
        els.steadyHint.textContent = 'Zoom closer to the property before placing accurate points.';
        els.steadyHint.hidden = false;
        return;
      }
      if (!e.position) return;
      addPoint({ lat: e.position.lat, lng: e.position.lng, altitude: e.position.altitude });
    });
    maps3dAvailable = true;
    els.viewToggle.hidden = false;
    els.viewToggle.querySelector('[data-view="3d"]').disabled = false;
    els.unavailable3d.hidden = true;
  } catch (err) {
    // 3D support can fail for perfectly legitimate reasons (no WebGL, no
    // 3D tile coverage for this location, API not enabled on this key).
    // The 2D workspace already works without it — surfaced as a visible
    // banner (not just a console warning) so the operator isn't left
    // wondering why the 3D toggle never appeared.
    maps3dAvailable = false;
    els.viewToggle.hidden = true;
    els.unavailable3d.hidden = false;
    console.warn('[TurnKey Measure] 3D inspect unavailable:', err && err.message);
  }
}
function renderOverlay3d() {
  if (!map3d || activeView !== '3d') return;
  markers3d.forEach((m) => m.remove());
  markers3d = [];
  const MarkerEl = window.customElements && window.customElements.get('gmp-marker-3d');
  points.forEach((p) => {
    if (!MarkerEl) return;
    const marker = document.createElement('gmp-marker-3d');
    // ABSOLUTE when this point actually has a real elevation; CLAMP_TO_GROUND
    // otherwise — the SDK's own default altitude mode can otherwise bury a
    // roof-height marker visually at ground level, which looks like the
    // click failed even though the coordinate itself was captured fine.
    marker.altitudeMode = p.altitude != null ? 'ABSOLUTE' : 'CLAMP_TO_GROUND';
    marker.position = { lat: p.lat, lng: p.lng, altitude: p.altitude || 0 };
    map3d.appendChild(marker);
    markers3d.push(marker);
  });

  if (overlay3d) { overlay3d.remove(); overlay3d = null; }
  if (points.length > 1) {
    const tagName = interaction === 'closed' ? 'gmp-polygon-3d' : 'gmp-polyline-3d';
    const OverlayEl = window.customElements && window.customElements.get(tagName);
    if (OverlayEl) {
      const el = document.createElement(tagName);
      const allAltitude = points.every((p) => p.altitude != null);
      el.altitudeMode = allAltitude ? 'ABSOLUTE' : 'CLAMP_TO_GROUND';
      const coords = points.map((p) => ({ lat: p.lat, lng: p.lng, altitude: p.altitude || 0 }));
      if (interaction === 'closed') el.outerCoordinates = coords;
      else el.coordinates = coords;
      el.strokeColor = '#0f7d6b';
      el.strokeWidth = 3;
      if (interaction === 'closed') { el.fillColor = '#0f7d6b'; el.fillOpacity = 0.18; }
      map3d.appendChild(el);
      overlay3d = el;
    }
  }
}

function switchView(view) {
  if (view === activeView) return;
  if (view === '3d' && !maps3dAvailable) return;
  activeView = view;
  document.getElementById('tkm-camera-controls').hidden = view !== '3d';
  els.map2d.hidden = view !== '2d';
  els.map3d.hidden = view !== '3d';
  els.viewToggle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.getAttribute('data-view') === view));
  if (view === '2d' && mode === 'surface') {
    // 2D clicks never carry an altitude — a surface measurement started
    // in 3D can't continue honestly here, so fall back rather than keep
    // showing a "surface" readout the 2D view can no longer support.
    setMode('ground');
  }
  updateModeToggle();
  render();
}
els.viewToggle.addEventListener('click', (e) => {
  const v = e.target.getAttribute('data-view');
  if (v) switchView(v);
});
document.getElementById('tkm-camera-controls').addEventListener('click',e=>{
  const button=e.target.closest('button');
  if (!button || !map3d) return;
  if (button.dataset.heading !== undefined) map3d.heading = Number(button.dataset.heading);
  if (button.dataset.range) map3d.range = Math.min(1500,Math.max(30,map3d.range*Number(button.dataset.range)));
});
document.getElementById('tkm-camera-tilt').addEventListener('change',e=>{if(map3d)map3d.tilt=Number(e.target.value);});

function addPoint(p) {
  if (interaction === 'closed' && points.length >= 3) {
    const first = points[0];
    const d = distanceMeters({ lat: p.lat, lng: p.lng }, { lat: first.lat, lng: first.lng });
    if (d < 2) return; // closing the loop near the start point — don't add a duplicate
  }
  points.push(p);
  render();
}

els.undo.addEventListener('click', () => { points.pop(); render(); });
els.clear.addEventListener('click', () => { points = []; render(); });

let finishing = false;
els.finish.addEventListener('click', () => {
  if (finishing || points.length < minPoints()) return;
  finishing = true;
  els.finish.disabled = true;
  els.finish.textContent = 'Sending…';
  // Posted to this same window/origin — the extension's dynamically
  // injected bridge content script (extension/content/bridge/measure-bridge.js)
  // listens for this and re-runs the SAME geometry.js calculation
  // authoritatively before routing it back to Google Earth. No extension
  // APIs are called from this page directly.
  window.postMessage(
    {
      source: 'turnkey-measure-workspace',
      type: 'TURNKEY_MEASURE_FINISH',
      requestId,
      category,
      kind,
      mode,
      points: points.map((p) => ({ lat: p.lat, lng: p.lng, ...(p.altitude != null ? { altitude: p.altitude } : {}) }))
    },
    location.origin
  );
});

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const msg = e.data;
  if (!msg || msg.source !== 'turnkey-measure-bridge') return;
  if (msg.requestId !== requestId) return;
  if (msg.type === 'TURNKEY_MEASURE_ACK') {
    els.finish.textContent = 'Sent to Google Earth ✓';
    setState('<p>Measurement sent back to Google Earth — you can close this tab, or keep tracing another shape there.</p>');
  } else if (msg.type === 'TURNKEY_MEASURE_ERROR') {
    finishing = false;
    els.finish.disabled = points.length < minPoints();
    els.finish.textContent = 'Finish';
    setErrorState(msg.message || 'Could not send this measurement back to Google Earth.');
  }
});

// ── Boot ──────────────────────────────────────────────────────────────
function loadMapsSdk() {
  return new Promise((resolve, reject) => {
    const cbName = '__tkMeasureMapsReady';
    window[cbName] = () => { resolve(); delete window[cbName]; };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.mapsKey)}&v=weekly&libraries=geometry&callback=${cbName}`;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load the Google Maps SDK — check your network connection and the configured Maps API key.'));
    document.head.appendChild(script);
  });
}

(async function boot() {
  setState('<div class="tkm-spinner"></div><p>Loading satellite map…</p>');
  updateModeToggle();
  try {
    await loadMapsSdk();
    initMap2d();
    clearState();
    render();
    await tryInit3d();
  } catch (err) {
    setErrorState(err.message || 'Could not load the satellite map.', { retry: () => boot() });
  }
})();
