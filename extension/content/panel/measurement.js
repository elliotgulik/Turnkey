// Real geographic measurement for the extension's "Measure" tool.
//
// ── Why this doesn't draw directly on Google Earth's own view ──────────────
// Google Earth Web (earth.google.com) renders through a proprietary WebGL
// globe with no public JS API exposed to page scripts or extensions for
// reading camera state, terrain elevation, or converting a screen click into
// a real lat/lng — investigated as required by the build brief (§18/§26).
// The one thing Earth DOES expose publicly is its own URL, which encodes the
// camera's look-at point as it flies (`@lat,lng,altitude,...` — read in
// app.js). That's enough to know roughly *where* the operator is looking,
// but not enough to turn an arbitrary click on a tilted, rotated 3D view into
// an accurate ground coordinate — the view isn't an orthographic projection,
// so "pixels from center" doesn't correspond to a fixed real-world distance
// the way it does on a flat map.
//
// TurnKey already solves exactly this problem, correctly, elsewhere in this
// codebase: booking.html's property-outline tool traces on a top-down
// satellite/OSM tile image at a known zoom level, where the standard Web
// Mercator meters-per-pixel formula IS exact (see booking.html's
// loadOsmMosaic/svgToLatLng/latLngToSvg, ~line 1030-1400). Rather than invent
// a second, less accurate measurement approach for Google Earth, this module
// ports that exact technique: the "Measure" tool opens a small top-down tile
// view inside the TurnKey panel, anchored at the property Earth is currently
// centred on, and the operator traces there. Same math, same accuracy
// characteristics, same {points, geoPts} shape the CRM already knows how to
// store/render (job.details.areaPolys) — not a second, incompatible engine.
const TILE_SIZE = 256;
const OSM_TILES_ACROSS = 3; // 3x3 mosaic, same as booking.html's OSM_TILES
const CANVAS_W = 520;
const CANVAS_H = 380;
// OpenStreetMap's standard tile server only serves zoom 0-19 — requesting
// z=20+ returns 400 for every tile at that level, not a CSP block (verified
// against the real tile.openstreetmap.org live in testing). booking.html's
// already-proven OSM mosaic (OSM_ZOOM_DEFAULT/MIN/MAX, ~line 838) already
// knows this; this module ported the mosaic technique but not these bounds.
const OSM_ZOOM_DEFAULT = 18, OSM_ZOOM_MIN = 15, OSM_ZOOM_MAX = 19;
// Real aerial/satellite imagery via Google Static Maps — same provider,
// same endpoint shape, same default zoom as booking.html's proven
// reloadMapAt()/SAT_ZOOM_DEFAULT (~line 837-893), ported rather than
// reinvented. Requested at exactly CANVAS_W x CANVAS_H (scale=2 for a sharp
// retina image — scale only increases pixel density, not ground coverage,
// so it doesn't change the meters-per-pixel math below), so — unlike the
// OSM path — there's no tile-mosaic size-mismatch factor to correct for.
const SAT_ZOOM_DEFAULT = 19, SAT_ZOOM_MIN = 15, SAT_ZOOM_MAX = 21;

/** Meters per on-screen pixel at this lat/zoom. The OSM mosaic requests
 * TILE_SIZE*OSM_TILES_ACROSS raw pixels stretched/cropped into CANVAS_W
 * CSS pixels, so it needs that scale-correction factor; a Static Maps
 * satellite image is requested at exactly CANVAS_W x CANVAS_H, so it doesn't. */
function metersPerPixel(lat, zoom, satellite) {
  const base = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  return satellite ? base : base * ((OSM_TILES_ACROSS * TILE_SIZE) / CANVAS_W);
}

// Best-effort match between Google Earth's reported camera distance (how
// far the camera is from the look-at point, metres — see app.js's
// readEarthCamera()) and a Static Maps zoom level whose ground coverage is
// in the same ballpark, so the tracer opens roughly as zoomed-in as the
// property view the operator actually had — rather than always the same
// fixed default regardless of whether they were looking at one roof or a
// whole block. Earth's URL doesn't expose field-of-view in a way this
// content script reads reliably, so this uses a fixed, empirically
// reasonable FOV assumption rather than an exact figure — approximate by
// design, not a precise camera-to-zoom inverse.
function zoomForDistance(lat, distanceM) {
  if (!distanceM || !Number.isFinite(distanceM) || distanceM <= 0) return SAT_ZOOM_DEFAULT;
  const assumedGroundWidthM = distanceM * 0.7; // ~35-40° effective FOV, Earth's typical default
  for (let z = SAT_ZOOM_MAX; z >= SAT_ZOOM_MIN; z--) {
    const coverageM = CANVAS_W * metersPerPixel(lat, z, true);
    if (coverageM >= assumedGroundWidthM) return z;
  }
  return SAT_ZOOM_MIN;
}

/** Local flat-earth (equirectangular) projection around the view center — accurate at residential-property scale. */
function svgToLatLng(p, center, scale) {
  const dxM = (p.x - CANVAS_W / 2) * scale;
  const dyM = (p.y - CANVAS_H / 2) * scale;
  return {
    lat: center.lat - dyM / 111320,
    lng: center.lng + dxM / (111320 * Math.cos((center.lat * Math.PI) / 180))
  };
}
function latLngToSvg(ll, center, scale) {
  const dLat = ll.lat - center.lat;
  const dLng = ll.lng - center.lng;
  const dyM = -dLat * 111320;
  const dxM = dLng * 111320 * Math.cos((center.lat * Math.PI) / 180);
  return { x: CANVAS_W / 2 + dxM / scale, y: CANVAS_H / 2 + dyM / scale };
}

function shoelaceArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a / 2);
}
function polyPerimeter(pts) {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    p += Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y);
  }
  return p;
}
function lineLength(pts) {
  let p = 0;
  for (let i = 1; i < pts.length; i++) p += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return p;
}

function tileXY(lat, lng, zoom) {
  const n = Math.pow(2, zoom);
  const xF = ((lng + 180) / 360) * n;
  const yF = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { xF, yF };
}

/**
 * Mounts an interactive top-down tracer into `container` (a plain DOM node).
 * `shape` is 'area' (closed polygon, min 3 points) or 'line' (open path, min 2 points).
 * Returns a controller: {setZoom, undo, clear, finish, destroy, onChange}.
 */
export function createTracer(container, { lat, lng, zoom, mapsKey, distance, shape = 'area', onChange }) {
  const satellite = !!mapsKey; // same choice booking.html's reloadMapAt() makes: Google satellite when a key is configured, free OSM otherwise
  let center = { lat, lng };
  let currentZoom = zoom != null ? zoom : (satellite ? zoomForDistance(lat, distance) : OSM_ZOOM_DEFAULT);
  let scale = metersPerPixel(center.lat, currentZoom, satellite);
  let points = []; // {x,y} canvas space
  let geoPts = []; // parallel real {lat,lng}

  container.innerHTML = `
    <div class="tk-tracer">
      <div class="tk-tracer-tiles"></div>
      <div class="tk-tracer-tilefail" data-role="tilefail" hidden>
        Map tiles didn't load — Google Earth's page may be blocking embedded images. Try again, or use "Instant Quote" with a manual measurement instead.
      </div>
      <svg class="tk-tracer-svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}"></svg>
      <div class="tk-tracer-zoom">
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
        <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
      </div>
    </div>`;
  const tilesEl = container.querySelector('.tk-tracer-tiles');
  const svgEl = container.querySelector('.tk-tracer-svg');
  const tileFailEl = container.querySelector('[data-role="tilefail"]');

  function attachFailDetection(imgs) {
    let failed = 0;
    imgs.forEach((img) =>
      img.addEventListener('error', () => {
        failed++;
        if (failed >= imgs.length) tileFailEl.hidden = false;
      })
    );
  }

  function renderSatellite() {
    // Same endpoint/params booking.html's reloadMapAt() already uses in
    // production (~line 887) — single image, no mosaic math needed since
    // it's requested at exactly CANVAS_W x CANVAS_H.
    const url = 'https://maps.googleapis.com/maps/api/staticmap?center=' + center.lat + ',' + center.lng +
      '&zoom=' + currentZoom + '&size=' + CANVAS_W + 'x' + CANVAS_H + '&scale=2&maptype=satellite&key=' + encodeURIComponent(mapsKey);
    tilesEl.innerHTML = `<img src="${url}" style="width:100%;height:100%;position:absolute;left:0;top:0">`;
    attachFailDetection(Array.from(tilesEl.querySelectorAll('img')));
  }

  function renderOsmMosaic() {
    const n = Math.pow(2, currentZoom);
    const { xF, yF } = tileXY(center.lat, center.lng, currentZoom);
    const tx = Math.floor(xF);
    const ty = Math.floor(yF);
    const half = (OSM_TILES_ACROSS - 1) / 2;
    const offX = (xF - tx - 0.5) * 100;
    const offY = (yF - ty - 0.5) * 100;
    let html = '';
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const yy = ((ty + dy) % n + n) % n;
        html += `<img src="https://tile.openstreetmap.org/${currentZoom}/${tx + dx}/${yy}.png" loading="lazy"
          style="width:${100 / OSM_TILES_ACROSS}%;height:${100 / OSM_TILES_ACROSS}%;position:absolute;
          left:${(dx + half) * (100 / OSM_TILES_ACROSS) - offX / OSM_TILES_ACROSS}%;
          top:${(dy + half) * (100 / OSM_TILES_ACROSS) - offY / OSM_TILES_ACROSS}%">`;
      }
    }
    tilesEl.innerHTML = html;
    attachFailDetection(Array.from(tilesEl.querySelectorAll('img')));
  }

  function renderTiles() {
    tileFailEl.hidden = true;
    if (satellite) renderSatellite();
    else renderOsmMosaic();
  }

  function reproject() {
    scale = metersPerPixel(center.lat, currentZoom, satellite);
    points = geoPts.map((g) => latLngToSvg(g, center, scale));
  }

  function currentValue() {
    if (shape === 'area') return { m2: shoelaceArea(points) * scale * scale, m: polyPerimeter(points) * scale };
    return { m: lineLength(points) * scale };
  }

  function render() {
    const minPts = shape === 'area' ? 3 : 2;
    const canFinish = points.length >= minPts;
    const path = points.map((p) => `${p.x},${p.y}`).join(' ');
    const closed = shape === 'area' && points.length > 1 ? `${path} ${points[0].x},${points[0].y}` : path;
    let svg = '';
    if (points.length > 1) {
      svg += `<polyline points="${closed}" fill="${shape === 'area' ? 'rgba(15,125,107,.18)' : 'none'}" stroke="#0f7d6b" stroke-width="3" stroke-linejoin="round"/>`;
    }
    points.forEach((p, i) => {
      svg += `<circle class="tk-tracer-pt" data-idx="${i}" cx="${p.x}" cy="${p.y}" r="${i === 0 ? 9 : 7}" fill="#fff" stroke="#0f7d6b" stroke-width="3"/>`;
    });
    svgEl.innerHTML = svg;
    onChange && onChange({ points: points.length, canFinish, value: currentValue() });
  }

  svgEl.addEventListener('click', (e) => {
    const rect = svgEl.getBoundingClientRect();
    const p = { x: ((e.clientX - rect.left) / rect.width) * CANVAS_W, y: ((e.clientY - rect.top) / rect.height) * CANVAS_H };
    // Closing the loop: clicking back on the first point (area shapes only) finishes the trace instead of adding a duplicate point.
    if (shape === 'area' && points.length >= 3 && Math.hypot(p.x - points[0].x, p.y - points[0].y) < 10) return;
    points.push(p);
    geoPts.push(svgToLatLng(p, center, scale));
    render();
  });

  container.querySelector('.tk-tracer-zoom').addEventListener('click', (e) => {
    const dir = e.target.getAttribute('data-zoom');
    if (!dir) return;
    const [zMin, zMax] = satellite ? [SAT_ZOOM_MIN, SAT_ZOOM_MAX] : [OSM_ZOOM_MIN, OSM_ZOOM_MAX];
    currentZoom = Math.max(zMin, Math.min(zMax, currentZoom + (dir === 'in' ? 1 : -1)));
    renderTiles();
    reproject();
    render();
  });

  renderTiles();
  render();

  return {
    undo() {
      points.pop();
      geoPts.pop();
      render();
    },
    clear() {
      points = [];
      geoPts = [];
      render();
    },
    recenter(newLat, newLng) {
      center = { lat: newLat, lng: newLng };
      renderTiles();
      reproject();
      render();
    },
    /** Returns the finished measurement in the exact shape job.details.areaPolys already uses elsewhere in TurnKey. */
    finish(category, serviceId) {
      const minPts = shape === 'area' ? 3 : 2;
      if (points.length < minPts) return null;
      const value = currentValue();
      return {
        id: 'a' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        type: shape,
        category,
        service: serviceId || null,
        unit: shape === 'area' ? 'm²' : 'm',
        size: shape === 'area' ? Math.round(value.m2 * 10) / 10 : Math.round(value.m * 10) / 10,
        points: points.slice(),
        geoPts: geoPts.slice(),
        notes: '',
        photoPaths: []
      };
    },
    destroy() {
      container.innerHTML = '';
    }
  };
}

export { CANVAS_W, CANVAS_H };
