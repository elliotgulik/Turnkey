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
import { measureGeometry, distanceMeters } from './geometry.js';
import { editOutline, createOutlineHistory, displayAltitude, displayPickedPoint, createCameraPickGuard } from './measurement-editor.js?v=20261022a';

const params = new URLSearchParams(location.search);
const requestId = params.get('requestId') || '';
const category = params.get('category') || 'area';
const categoryLabel = params.get('label') || 'Area';
const kind = ['area', 'perimeter', 'line'].includes(params.get('kind')) ? params.get('kind') : 'area';
const interaction = kind === 'line' ? 'open' : 'closed';
const startLat = parseFloat(params.get('lat'));
const startLng = parseFloat(params.get('lng'));
// Keep the original selected location pinned until an address resolves.
let propertyPosition = Object.freeze({lat:startLat,lng:startLng});
const propertyAddress = (params.get('address') || params.get('propertyAddress') || '').trim();
let propertyResolved = false;
let propertyLabel = propertyAddress
  ? `${propertyAddress} — locating address; pin marks the selected location`
  : 'Selected location — no property address supplied';

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

if (!requestId || !Number.isFinite(startLat) || !Number.isFinite(startLng) || Math.abs(startLat)>85 || Math.abs(startLng)>180) {
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
const history = createOutlineHistory();
let points = [], editAction='add', selectedCorner=0, selectedEdge=0, maps3dLib=null;
let activeView = '2d';
// Explicit, operator-chosen — NEVER auto-inferred from whether points
// happen to carry an altitude. Always starts (and falls back to) 'ground'.
let mode = 'ground';
let map2d = null;
let overlay2d = null; // google.maps.Polygon | Polyline
let markers2d = [];
let map3d = null;
let markers3d = [];
let propertyMarker2d = null, propertyMarker3d = null;
let overlay3d = null; // gmp-polygon-3d | gmp-polyline-3d
let maps3dAvailable = false;
const cameraGuard = createCameraPickGuard();
let pickHint = '';
const cameraHintText = {
  moving: 'Camera is moving or settling. Release the controls, wait half a second, then click the surface again.',
  loading: 'Camera has settled; 3D imagery is still loading. Wait for detail, then click again. If this persists, retry the view or use 2D.',
  zoom: 'Zoom closer to the property, wait for detail, then click again.',
  surface: 'No accurate 3D surface position was returned. Click a loaded roof or ground surface, or change the angle and retry.'
};
const hintMessage = document.createElement('span');
const retryCamera = document.createElement('button');
retryCamera.type = 'button';
retryCamera.textContent = 'Retry view';
retryCamera.addEventListener('click', () => {
  map3d?.stopCameraAnimation?.();
  cameraGuard.reset();
  pickHint = '';
  updateCameraHint();
});
els.steadyHint.replaceChildren(hintMessage, document.createTextNode(' '), retryCamera);
els.steadyHint.setAttribute('role', 'status');
function updateCameraHint() {
  if (!map3d || activeView !== '3d') { els.steadyHint.hidden = true; return; }
  const status = cameraGuard.status(map3d);
  const reason = status === 'ready' ? pickHint : status;
  hintMessage.textContent = cameraHintText[reason] || '';
  els.steadyHint.hidden = !reason;
}

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
  const canFinish = points.length >= minPoints() && !preview.blocked && !finishing;
  els.finish.disabled = !canFinish;
  els.undo.disabled = !history.canUndo || finishing;
  els.clear.disabled = points.length === 0 || finishing;
  renderEditorControls();

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
  if(finishing)return;
  if (next === 'surface' && activeView !== '3d') return; // never reachable without being in 3D view in the first place
  mode = next;
  updateModeToggle();
  render();
}
els.modeToggle.addEventListener('click', (e) => {
  const m = e.target.getAttribute('data-mode');
  if (m) setMode(m);
});

// Updating an address anchor never edits history, points, or the current camera.
function updatePropertyAnchor(){
  const shortLabel = propertyResolved ? 'Property' : 'Location pin';
  document.getElementById('tkm-property-address').textContent = propertyLabel;
  document.getElementById('tkm-return-property').textContent = propertyResolved
    ? 'Return to property' : 'Return to location pin';
  propertyMarker2d?.setOptions({position:propertyPosition,title:propertyLabel,
    label:{text:shortLabel,color:'#9b341e',fontWeight:'bold'}});
  if(propertyMarker3d){
    propertyMarker3d.position = propertyPosition;
    if(maps3dLib.Marker3DElement) propertyMarker3d.label = propertyLabel;
    else {
      propertyMarker3d.title = propertyLabel;
      const label = propertyMarker3d.querySelector('.tkm-property-pin');
      if(label) label.textContent = shortLabel;
    }
  }
}
async function resolvePropertyAnchor(){
  if(!propertyAddress)return;
  let timer;
  try {
    const response = await Promise.race([
      (async()=>{
        const {Geocoder} = await google.maps.importLibrary('geocoding');
        return new Geocoder().geocode({address:propertyAddress});
      })(),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Address lookup timed out')),8000);})
    ]);
    const result = response.results?.[0];
    const location = result?.geometry?.location;
    const lat = location?.lat(), lng = location?.lng();
    if(response.results.length!==1 || result.partial_match ||
      !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>85 || Math.abs(lng)>180)
      throw new Error('No unambiguous property location');
    propertyPosition = Object.freeze({lat,lng});
    propertyResolved = true;
    propertyLabel = result.formatted_address || propertyAddress;
  } catch {
    propertyLabel = `${propertyAddress} — address lookup unavailable or inconclusive; pin remains at the selected location`;
  } finally {
    clearTimeout(timer);
    updatePropertyAnchor();
  }
}

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
  propertyMarker2d = new google.maps.Marker({map:map2d,position:propertyPosition,
    title:propertyLabel,label:{text:'Property',color:'#9b341e',fontWeight:'bold'},
    clickable:false,draggable:false,zIndex:0});
  updatePropertyAnchor();
  document.getElementById('tkm-return-property').disabled = false;
  map2d.addListener('click', (e) => {
    addPoint({ lat: e.latLng.lat(), lng: e.latLng.lng() });
  });
}
function renderOverlay2d() {
  if (activeView !== '2d' || !map2d) return;
  markers2d.forEach(m=>m.setMap(null));markers2d=[];
  const markerAt=(position,label,scale,drag,click)=>{
    const marker=new google.maps.Marker({position,map:map2d,draggable:!finishing,label:{text:label,color:'#fff',fontSize:'11px'},icon:{path:google.maps.SymbolPath.CIRCLE,scale,fillColor:'#0f7d6b',fillOpacity:1,strokeColor:'#fff',strokeWeight:2}});
    marker.addListener('dragend',e=>{if(!finishing)drag({lat:e.latLng.lat(),lng:e.latLng.lng()});});
    marker.addListener('click',()=>{if(!finishing)click();});
    markers2d.push(marker);
  };
  points.forEach((p,i)=>markerAt({lat:p.lat,lng:p.lng},String(i+1),9,
    p=>commitEdit({action:'move',index:i,point:p,view:'2d'}),
    ()=>{selectedCorner=i;editAction='move';render();}));
  const edges=interaction==='closed'&&points.length>2?points.length:Math.max(0,points.length-1);
  for(let i=0;i<edges;i++){
    const a=points[i],b=points[(i+1)%points.length];
    const p={lat:(a.lat+b.lat)/2,lng:((a.lng+((b.lng-a.lng+540)%360-180)/2+540)%360)-180};
    markerAt(p,'+',7,next=>commitEdit({action:'insert',index:i,point:next,view:'2d'}),()=>commitEdit({action:'insert',index:i,point:p,view:'2d'}));
  }
  if(overlay2d)overlay2d.setMap(null);
  const path=points.map(p=>({lat:p.lat,lng:p.lng}));
  overlay2d=points.length>1?(interaction==='closed'&&points.length>=3
    ?new google.maps.Polygon({paths:path,map:map2d,fillColor:'#0f7d6b',fillOpacity:0.1,strokeColor:'#0f7d6b',strokeWeight:3})
    :new google.maps.Polyline({path,map:map2d,strokeColor:'#0f7d6b',strokeWeight:3})):null;
  overlay2d?.addListener('click',e=>{e.stop?.();if(e.latLng)addPoint({lat:e.latLng.lat(),lng:e.latLng.lng()});});
}

// ── 3D "Inspect" view (optional — multi-angle, altitude-aware) ──────────
async function tryInit3d() {
  try {
    const maps3d = await google.maps.importLibrary('maps3d');
    maps3dLib=maps3d;
    if (!maps3d || !maps3d.Map3DElement) throw new Error('maps3d library unavailable');
    map3d = new maps3d.Map3DElement({
      center: { lat: startLat, lng: startLng, altitude: 0 },
      range: 300,
      tilt: 60,
      heading: 0,
      mode: maps3d.MapMode ? maps3d.MapMode.SATELLITE : 'SATELLITE'
    });
    // Listen before connecting: the SDK may announce initial readiness on mount.
    // Do not use render/scene notifications as a camera-movement clock.
    map3d.addEventListener('gmp-steadychange', (e) => {
      cameraGuard.scene(e.isSteady);
      updateCameraHint();
    });
    for (const property of ['center', 'heading', 'tilt', 'range', 'roll', 'fov', 'cameraposition']) {
      map3d.addEventListener(`gmp-${property}change`, () => {
        updateCameraHint();
      });
    }
    map3d.addEventListener('gmp-click', (e) => {
      // Marker clicks bubble too, but are not geographic surface picks.
      if (e.target !== map3d || activeView !== '3d' || finishing) return;
      e.preventDefault();
      const pick = cameraGuard.pick(map3d, e.position);
      pickHint = ['zoom', 'surface'].includes(pick.reason) ? pick.reason : '';
      updateCameraHint();
      if (pick.point) addPoint(pick.point);
      // Never queue a rejected point: its screen position belongs to the old view.
    });
    cameraGuard.sample(map3d);
    els.map3d.appendChild(map3d);
    // The constructor's center altitude is absolute. Resolve the initial target
    // against terrain so elevated properties are not viewed below the ground.
    focusProperty3d();
    // Separate from editable overlays: Clear/Undo and mode changes retain it.
    const PropertyMarker = maps3d.Marker3DElement || maps3d.MarkerElement;
    if (PropertyMarker) {
      propertyMarker3d = new PropertyMarker({position:propertyPosition,
        altitudeMode:maps3d.AltitudeMode.CLAMP_TO_GROUND});
      if (maps3d.Marker3DElement) {
        propertyMarker3d.label = propertyLabel;
        propertyMarker3d.drawsWhenOccluded = true;
        propertyMarker3d.extruded = false;
      } else {
        propertyMarker3d.title = propertyLabel;
        const label = document.createElement('span');
        label.className = 'tkm-property-pin'; label.textContent = '⌂ Property';
        propertyMarker3d.appendChild(label);
      }
      map3d.appendChild(propertyMarker3d);
      updatePropertyAnchor();
    }
    // Page timers pause/resume with the browser's back-forward cache.
    setInterval(updateCameraHint, 100);
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
  if(!map3d||activeView!=='3d'||!maps3dLib)return;
  markers3d.forEach(m=>m.remove());markers3d=[];
  if(overlay3d){overlay3d.remove();overlay3d=null;}
  // Pick elevations affect display only; livePreview/Finish retain the chosen
  // ground vs surface math. Roof clicks must not disappear below the roof.
  const display=displayAltitude(points,'surface',maps3dLib.AltitudeMode);
  const Marker=maps3dLib.MarkerInteractiveElement||maps3dLib.Marker3DInteractiveElement;
  if(Marker)points.forEach((point,i)=>{
    const marker=new Marker({...displayPickedPoint(point,maps3dLib.AltitudeMode),title:'Corner '+(i+1)});
    if(maps3dLib.MarkerInteractiveElement){
      const dot=document.createElement('span');dot.textContent=String(i+1);
      dot.style.cssText='display:block;width:22px;height:22px;border:2px solid white;border-radius:50%;background:#138a72;color:white;text-align:center;font:bold 12px/18px sans-serif;box-shadow:0 1px 4px #0005';
      marker.anchorLeft='-50%';marker.anchorTop='-50%';marker.appendChild(dot);
    }else{marker.label=String(i+1);marker.extruded=false;marker.drawsWhenOccluded=true;}
    marker.addEventListener('gmp-click',e=>{e.stopPropagation();if(!finishing){selectedCorner=i;editAction='move';render();}});
    map3d.appendChild(marker);markers3d.push(marker);
  });
  if(points.length>1){
    const path=[...display.coordinates];if(interaction==='closed'&&points.length>=3)path.push({...path[0]});
    // Outline only: no filled sheet spanning roofs, no extruded walls,
    // and no drawing through buildings. Always use the SDK's actual enums.
    overlay3d=new maps3dLib.Polyline3DElement({path,altitudeMode:display.altitudeMode,strokeColor:'#138a72',strokeWidth:3,drawsOccludedSegments:false,extruded:false});
    map3d.appendChild(overlay3d);
  }
}

function switchView(view) {
  if(finishing)return;
  if (view === activeView) return;
  if (view === '3d' && !maps3dAvailable) return;
  activeView = view;
  if (view === '3d') { cameraGuard.reset(); pickHint = ''; }
  updateCameraHint();
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
function focusProperty3d(){
    map3d.stopCameraAnimation?.();
    cameraGuard.reset(); pickHint='';
    // CameraOptions supports ground-relative centers; do not aim below elevated terrain.
    map3d.flyCameraTo({endCamera:{center:propertyPosition,
      altitudeMode:maps3dLib.AltitudeMode.CLAMP_TO_GROUND,range:300,heading:0,tilt:60,roll:0},durationMillis:0});
    document.getElementById('tkm-camera-tilt').value='60';
    updateCameraHint();
}
document.getElementById('tkm-return-property').addEventListener('click',()=>{
  if(activeView==='3d' && map3d){
    focusProperty3d();
  }else if(map2d){
    map2d.setCenter(propertyPosition); map2d.setZoom(20); map2d.setTilt(0); map2d.setHeading(0);
  }
});
document.getElementById('tkm-camera-controls').addEventListener('click',e=>{
  const button=e.target.closest('button');
  if (!button || !map3d) return;
  if (button.dataset.heading !== undefined) map3d.heading = Number(button.dataset.heading);
  if (button.dataset.range) map3d.range = Math.min(1500,Math.max(30,map3d.range*Number(button.dataset.range)));
});
document.getElementById('tkm-camera-tilt').addEventListener('change',e=>{if(map3d)map3d.tilt=Number(e.target.value);});

function commitEdit(operation){
  if(finishing)return;
  try{
    const next=editOutline(points,operation);
    if(!history.commit(next))return;
    points=history.points;
    if(operation.action==='insert'){selectedCorner=operation.index+1;editAction='move';}
    render();
  }catch(error){document.getElementById('tkm-edit-help').textContent=error.message;}
}
function addPoint(p){
  commitEdit({action:editAction,index:editAction==='insert'?selectedEdge:selectedCorner,point:p,view:activeView});
}
function renderEditorControls(){
  selectedCorner=Math.min(selectedCorner,Math.max(0,points.length-1));
  const edgeCount=interaction==='closed'&&points.length>2?points.length:Math.max(0,points.length-1);
  selectedEdge=Math.min(selectedEdge,Math.max(0,edgeCount-1));
  if((editAction==='move'&&!points.length)||(editAction==='insert'&&!edgeCount))editAction='add';
  const corner=document.getElementById('tkm-corner'),edge=document.getElementById('tkm-edge');
  if(corner.options.length!==points.length)corner.innerHTML=points.map((_,i)=>`<option value="${i}">${i+1}</option>`).join('');
  const edgeOptions=Array.from({length:edgeCount},(_,i)=>`<option value="${i}">${i+1} → ${(i+1)%points.length+1}</option>`).join('');
  if(edge.dataset.options!==edgeOptions){edge.innerHTML=edgeOptions;edge.dataset.options=edgeOptions;}
  corner.value=String(selectedCorner);edge.value=String(selectedEdge);
  corner.disabled=finishing||!points.length;edge.disabled=finishing||!edgeCount;
  document.querySelectorAll('[data-edit]').forEach(button=>{
    button.setAttribute('aria-pressed',String(button.dataset.edit===editAction));
    button.disabled=finishing||(button.dataset.edit==='move'&&!points.length)||(button.dataset.edit==='insert'&&!edgeCount);
  });
  document.getElementById('tkm-delete').disabled=finishing||!points.length;
  document.getElementById('tkm-edit-help').textContent=editAction==='insert'
    ?'Click the new position to insert a corner on the selected edge.'
    :editAction==='move'?`Click a new ${activeView==='3d'?'surface ':''}position for corner ${selectedCorner+1}.`
    :activeView==='2d'?'Draw around the property. Drag numbered corners or the + edge handles to refine it.'
    :'Draw on the loaded surface. Select an edge to insert a point, or select a corner to move it.';
}
 document.querySelector('.tkm-edit-controls').addEventListener('click',e=>{
   const button=e.target.closest('[data-edit]');if(button&&!finishing){editAction=button.dataset.edit;render();}
 });
 document.getElementById('tkm-corner').addEventListener('input',e=>{selectedCorner=Number(e.target.value);editAction='move';});
 document.getElementById('tkm-edge').addEventListener('input',e=>{selectedEdge=Number(e.target.value);editAction='insert';});
 document.getElementById('tkm-corner').addEventListener('change',e=>{selectedCorner=Number(e.target.value);editAction='move';render();});
 document.getElementById('tkm-edge').addEventListener('change',e=>{selectedEdge=Number(e.target.value);editAction='insert';render();});
 document.getElementById('tkm-delete').addEventListener('click',()=>commitEdit({action:'delete',index:selectedCorner}));
 els.undo.addEventListener('click',()=>{if(!finishing){points=history.undo();render();}});
 els.clear.addEventListener('click',()=>{if(!finishing){history.commit([]);points=history.points;editAction='add';render();}});

let finishing = false;
let finishTimer;
els.finish.addEventListener('click', () => {
  if (finishing || points.length < minPoints()) return;
  finishing = true;
  render();
  els.finish.disabled = true;
  els.finish.textContent = 'Sending…';
  clearTimeout(finishTimer);
  finishTimer=setTimeout(()=>{
    finishing=false;
    els.finish.textContent='Finish';
    render();
    els.readout.textContent='No extension confirmation received. Keep the original Earth tab open and check that TurnKey v0.2.0 is loaded in Chrome Extensions before retrying.';
  },15000);
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
    clearTimeout(finishTimer);
    els.finish.textContent = 'Sent to Google Earth ✓';
    setState('<p>Measurement sent back to Google Earth — you can close this tab, or keep tracing another shape there.</p>');
  } else if (msg.type === 'TURNKEY_MEASURE_ERROR') {
    clearTimeout(finishTimer);
    finishing = false;
    els.finish.disabled = points.length < minPoints();
    els.finish.textContent = 'Finish';
    setErrorState(msg.message || 'Could not send this measurement back to Google Earth.',{retry:()=>{clearState();render();}});
  }
});

// ── Boot ──────────────────────────────────────────────────────────────
let mapsAuthFailed=false;
window.gm_authFailure=()=>{
  mapsAuthFailed=true;
  setErrorState('Google Maps rejected this site’s API key or billing configuration. Correct TURNKEY_MAPS_KEY in Netlify, redeploy, then reload this workspace. No measurement has been sent.');
};
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
    if(mapsAuthFailed)return;
    clearState();
    render();
    void resolvePropertyAnchor();
    await tryInit3d();
  } catch (err) {
    setErrorState(err.message || 'Could not load the satellite map.', { retry: () => boot() });
  }
})();
