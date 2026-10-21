import { Storage, connectionChanged } from '../../api/storage.js';
import { TurnKeyApi } from '../../api/client-bridge.js';
import { mountToolbar } from './toolbar.js';
import { renderQuotePanel, renderQuoteCreated } from './quote.js';
import { createQuoteDraft } from './quote-create.js';
import { configureCosts } from './quote-pricing.js';
import { captureVisibleTab, renderScreenshotPreview } from './screenshot.js';

// `kind` matches extension/geometry.js's own vocabulary exactly
// (measureGeometry's {kind:'area'|'line'|'perimeter'}) — no translation
// layer between what a category means and what the geometry engine
// computes. `interaction` (derived below, not stored) is just the click
// behaviour: a closed loop (area AND perimeter both trace an outline the
// same way — House measures the drawn outline's PERIMETER in metres, for
// per-linear-metre house-wash pricing, not its area) or an open path.
const CATEGORIES = [
  { key: 'roof', label: 'Roof', kind: 'area' },
  { key: 'driveway', label: 'Driveway', kind: 'area' },
  { key: 'house', label: 'House', kind: 'perimeter' },
  { key: 'deck', label: 'Deck', kind: 'area' },
  { key: 'concrete', label: 'Concrete', kind: 'area' },
  { key: 'custom', label: 'Custom area', kind: 'area' },
  { key: 'fence', label: 'Fence', kind: 'line' },
  { key: 'custom-line', label: 'Custom distance', kind: 'line' }
];
function interactionForKind(kind) {
  return kind === 'line' ? 'open' : 'closed';
}

/**
 * Same-length placeholder "pixel" points for job.details.areaPolys.points
 * — compatibility only, NEVER used for measurement math (geoPts/real
 * lat-lng is the source of truth end to end; see geometry.js). index.html's
 * own Quote Editor immediately recomputes real screen coordinates from
 * geoPts whenever `points.length === geoPts.length` (qeLatLngToSvg), and
 * several other spots (map-snapshot.js, the Quote Editor's own centroid/
 * edge math) assume `points` exists with that same length even when
 * geoPts is also present — an empty/mismatched array there, not wrong
 * values, is what breaks those. A simple local tangent-plane projection
 * (not tied to any fixed canvas size or zoom level — that fixed-scale
 * assumption was the old in-panel tracer's root bug) is enough to satisfy
 * that contract.
 */
function toDisplayPoints(geoPts) {
  if (!geoPts.length) return [];
  const originLat = geoPts[0].lat;
  const originLng = geoPts[0].lng;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return geoPts.map((p) => ({
    x: (p.lng - originLng) * metersPerDegLng,
    y: -(p.lat - originLat) * metersPerDegLat
  }));
}

/** Google Earth encodes its current camera look-at point in the URL as it flies (`@lat,lng,...`) — the only property-location signal a content script can legitimately read. It seeds where the measurement workspace opens; the operator can pan/zoom freely once there. */
function readEarthCamera() {
  const m = location.href.match(/@(-?\d+\.\d{3,}),(-?\d+\.\d{3,})/);
  if (!m) return null;
  const searchMatch = location.href.match(/\/search\/([^/@]+)/);
  const addressGuess = searchMatch ? decodeURIComponent(searchMatch[1]).replace(/\+/g, ' ') : '';
  return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), addressGuess };
}

function toast(root, message, tone = 'info') {
  const el = document.createElement('div');
  el.className = 'tk-toast tk-toast-' + tone;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 4000);
}

export async function init(shadowRoot) {
  const cssUrl = chrome.runtime.getURL('content/panel/panel.css');
  const cssRes = await fetch(cssUrl);
  const styleEl = document.createElement('style');
  styleEl.textContent = await cssRes.text();
  shadowRoot.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'tk-root';
  shadowRoot.appendChild(root);

  const modalLayer = document.createElement('div');
  modalLayer.className = 'tk-modal-layer';
  root.appendChild(modalLayer);

  // pricing-engine.js is vendored verbatim from the repo root (see
  // vendor/pricing-engine.js's header) and written as a plain
  // window-attaching script, same as index.html/booking.html load it — not
  // an ES module. Dynamically importing it still executes it and lets it
  // attach window.TK_PRICING as a side effect; we read the global
  // afterward rather than using named exports.
  await import(chrome.runtime.getURL('vendor/pricing-engine.js'));
  const TK_PRICING = window.TK_PRICING;
  await import(chrome.runtime.getURL('vendor/cost-engine.js'));
  const TK_COST=window.TK_COST;
  if (!TK_PRICING) {
    toast(root, 'TurnKey pricing engine failed to load — try reloading the page.', 'error');
    return;
  }
  const { SERVICES, applyRateOverrides } = TK_PRICING;

  let state = {
    config: null,
    session: null,
    profile: null,
    business: null,
    settings: null,
    address: '',
    lat: null,
    lng: null,
    measurements: [],
    screenshotDataUrl: null,
    pendingMeasureRequests: {}, // requestId -> {category, categoryLabel, kind, serviceId}
    boundCustomer: null, // {id,name,address} when this tab was opened from an existing customer's "Build quote" button
    boundCustomerBusinessId: null,
    boundJob: null,
    boundRecordId: null,
    addressLocked: false // true once boundCustomer is set — the Earth-camera address polling below must not overwrite it
  };

  let connectionGeneration = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && connectionChanged(changes)) connectionGeneration++;
  });

  async function hydrate() {
    const stored = await Storage.loadAll();
    state = { ...state, ...stored };
  }
  await hydrate();

  /**
   * Asks the background worker (customer-handoff.js) whether THIS tab was
   * opened for a specific customer — see extension-quote-link.js's
   * launchViaExtension()/TK_CUSTOMER_LAUNCH. The background worker already
   * re-checks the signed-in business before answering; `businessId` is
   * compared again here so a business switched in THIS tab's own session
   * (not just the background worker's) never binds to a foreign customer.
   */
  async function loadBoundCustomerContext() {
    const generation = connectionGeneration;
    const businessId = state.profile?.business_id;
    const userId = state.session?.userId;
    const res = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'TK_GET_CUSTOMER_CONTEXT' }, resolve);
      } catch {
        resolve(null);
      }
    });
    if (generation !== connectionGeneration || businessId !== state.profile?.business_id || userId !== state.session?.userId) throw new Error('Your account changed while loading this customer. Reopen Google Earth from TurnKey.');
    if (!res || !res.ok || !res.data) {
      if (state.boundCustomer || res?.ok === false) throw new Error(res?.error || 'The linked customer context expired. Reopen Google Earth from TurnKey.');
      return;
    }
    const ctx = res.data;
    if (!state.session || !state.profile || ctx.businessId !== state.profile.business_id) throw new Error('Your business changed. Reopen Google Earth from TurnKey.');
    state.boundCustomer = ctx.customer || { id: ctx.customerId, name: ctx.customerName || '', address: ctx.address };
    state.boundJob = ctx.job || null;
    state.boundRecordId = ctx.recordId;
    state.boundCustomerBusinessId = ctx.businessId;
    if (ctx.address) {
      state.address = ctx.address;
      state.addressLocked = true;
    }
  }
  try { await loadBoundCustomerContext(); } catch (error) { state.contextError = error.message; toast(root, error.message, 'error'); }

  const toolbar = mountToolbar(root, {
    onAction: handleToolbarAction,
    onAddressChange: (v) => {
      state.address = v;
      toolbar.update(state);
    },
    onRemoveMeasurement: (id) => {
      state.measurements = state.measurements.filter((m) => m.id !== id);
      toolbar.update(state);
    }
  });

  const camera = readEarthCamera();
  if (camera) {
    state.lat = camera.lat;
    state.lng = camera.lng;
    if (!state.address && camera.addressGuess) state.address = camera.addressGuess;
  }
  toolbar.update(state);

  // Google Earth is a single-page app — it changes the URL via history
  // APIs as the operator flies/searches, with no event this content script
  // can subscribe to. Lightweight polling (cheap, read-only) rather than
  // monkey-patching history.pushState, which would risk interfering with
  // Earth's own navigation (build brief §3's hard requirement).
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const cam = readEarthCamera();
    if (!cam) return;
    state.lat = cam.lat;
    state.lng = cam.lng;
    // A bound-customer address (see loadBoundCustomerContext() above) is
    // authoritative for this tab — Earth's own camera/search URL polling
    // must never silently swap it out from under the operator.
    if (cam.addressGuess && cam.addressGuess !== state.address && !state.addressLocked) {
      state.address = cam.addressGuess;
      toolbar.update(state);
    }
  }, 1500);

  function closeModal() {
    modalLayer.innerHTML = '';
  }

  function requireConnected() {
    if (!state.session) {
      toast(root, 'Connect your TurnKey account first — click the TurnKey icon in your browser toolbar.', 'error');
      return false;
    }
    return true;
  }

  function requireLocation() {
    if (state.lat == null) {
      toast(root, 'Search for or fly to a property in Google Earth first, so TurnKey knows where to measure.', 'error');
      return false;
    }
    return true;
  }

  function openCategoryPicker(interaction) {
    const options = CATEGORIES.filter((c) => interactionForKind(c.kind) === interaction);
    modalLayer.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-category-modal">
          <div class="tk-modal-head">
            <h3>${interaction === 'closed' ? 'What are you measuring?' : 'What is this distance?'}</h3>
            <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="tk-category-grid">
            ${options.map((o) => `<button type="button" class="tk-category-btn" data-cat="${o.key}">${o.label}</button>`).join('')}
          </div>
        </div>
      </div>`;
    modalLayer.querySelector('[data-close]').addEventListener('click', closeModal);
    modalLayer.querySelectorAll('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => {
        closeModal();
        openWorkspaceMeasure(b.getAttribute('data-cat'));
      })
    );
  }

  /**
   * "Measure" opens a dedicated TurnKey-hosted workspace tab (measure.html,
   * on the business's own TurnKey site) rather than tracing in-page —
   * see the extension README for why: Google Earth's own view can't be
   * turned into accurate ground coordinates, and the previous in-panel
   * OSM tile tracer broke under Earth's page CSP and used a stretched
   * fixed-canvas pixel scale that didn't match the real tile zoom. The
   * background service worker owns opening the tab and routing the result
   * back here (background/service-worker.js) — this content script never
   * talks to that tab directly.
   */
  async function openWorkspaceMeasure(categoryKey) {
    const category = CATEGORIES.find((c) => c.key === categoryKey);
    const svc = guessServiceForCategory(category.key, category.kind);
    toast(root, `Opening the TurnKey measurement workspace for ${category.label}…`);
    chrome.runtime.sendMessage(
      {
        type: 'TK_OPEN_WORKSPACE',
        payload: { category: category.key, categoryLabel: category.label, kind: category.kind, lat: state.lat, lng: state.lng, address: state.address }
      },
      (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          toast(root, 'Could not open the measurement workspace — ' + ((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'unknown error'), 'error');
          return;
        }
        state.pendingMeasureRequests[res.requestId] = { category: category.key, categoryLabel: category.label, kind: category.kind, serviceId: svc };
      }
    );
  }

  /** Dispatched by background/service-worker.js once the workspace tab finishes a trace (see the chrome.runtime.onMessage listener at the bottom of init()). */
  function handleMeasureComplete({ requestId, result }) {
    if (state.measurements.some(m => m.id === requestId)) return true;
    const pending = state.pendingMeasureRequests[requestId];
    if (!pending) return false;
    if (!result || typeof result.value !== 'number') {
      toast(root, 'That measurement could not be completed — ' + ((result && result.error) || 'try again from Google Earth.'), 'error');
      return false;
    }
    // geometry.js's measureGeometry() already returns `value` in the right
    // unit for this exact `kind` (area → m², perimeter/line → m) — no
    // per-kind field-picking needed here, unlike the old shape-only model.
    const geoPts = (result.points || []).map((p) => ({ lat: p.lat, lng: p.lng, ...(p.altitude != null ? { altitude: p.altitude } : {}) }));
    const measurement = {
      id: requestId,
      type: pending.kind,
      category: pending.category,
      categoryLabel: pending.categoryLabel,
      service: pending.serviceId,
      unit: result.unit || (pending.kind === 'area' ? 'm²' : 'm'),
      size: Math.round(result.value * 10) / 10,
      quantities: pending.kind === 'line' ? null : {area: result.mode === 'surface' ? result.surfaceArea : result.groundArea, perimeter: result.perimeter},
      mode: result.mode || 'ground',
      points: toDisplayPoints(geoPts),
      geoPts,
      method: result.method || (pending.kind === 'area' ? 'ground' : 'haversine'),
      notes: '',
      photoPaths: []
    };
    state.measurements.push(measurement);
    delete state.pendingMeasureRequests[requestId];
    toolbar.update(state);
    toast(root, `${pending.categoryLabel} saved — ${measurement.size}${measurement.unit === 'm²' ? ' m²' : ' m'}`);
    return true;
  }

  function guessServiceForCategory(categoryKey, kind) {
    const hintMap = { roof: 'roof', driveway: 'driveway', concrete: 'driveway', house: 'housewash', fence: 'fence', deck: 'deck' };
    if (hintMap[categoryKey] && SERVICES[hintMap[categoryKey]]) return hintMap[categoryKey];
    const wantShape = interactionForKind(kind);
    const wantUnit = kind === 'area' ? 'm²' : 'm';
    const match = Object.keys(SERVICES).find((k) => SERVICES[k].shape === wantShape && SERVICES[k].unit === wantUnit);
    return match || Object.keys(SERVICES)[0];
  }

  async function openQuotePanel(manualWindows = false) {
    if (!requireConnected()) return;
    if (!state.measurements.length && !manualWindows) {
      toast(root, 'Measure at least one area or distance first.', 'error');
      return;
    }
    if (state.contextError) { toast(root, state.contextError, 'error'); return; }
    const businessId = state.profile?.business_id;
    const generation = connectionGeneration;
    try {
      await loadBoundCustomerContext();
      const profile = await TurnKeyApi.getProfile();
      if (!businessId || profile.business_id !== businessId) throw new Error('Your business changed. Reconnect before quoting.');
      const business=await TurnKeyApi.getBusiness(businessId);
      if (generation !== connectionGeneration || state.profile?.business_id !== businessId) throw new Error('Your account changed. Reopen the quote.');
      if(!business)throw new Error('Reconnect the extension to load your business pricing.');
      state.business=business;
    }catch(error){toast(root,error.message,'error');return;}
    configureCosts(TK_COST,state.business.pricing_config||{});
    if (state.business && state.business.pricing_config && state.business.pricing_config.rates) {
      applyRateOverrides(state.business.pricing_config.rates);
    }
    const binding = state.boundCustomer ? Object.freeze({businessId, customerId:state.boundCustomer.id, jobId:state.boundJob?.id || null, quoteId:state.boundJob?.quote_id || null, recordId:state.boundRecordId}) : null;
    state.quoteCreateProgress = null; // fresh quote-panel session — any earlier partial create attempt is unrelated
    renderQuotePanel(
      modalLayer,
      { measurements: state.measurements, address: state.address, TK_PRICING, TK_COST, business: state.business, boundCustomer: state.boundCustomer, boundJob: state.boundJob, manualWindows },
      {
        onCancel: closeModal,
        onSearchCustomer: async (query) => {
          if (!query || query.length < 2) return [];
          try {
            const all = await TurnKeyApi.listCustomers(businessId);
            if (generation !== connectionGeneration || state.profile?.business_id !== businessId) return [];
            const q = query.toLowerCase();
            return all.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 8);
          } catch (e) {
            return [];
          }
        },
        onCreateQuote: async (payload) => {
          try {
            await createQuoteFlow(payload, businessId, binding, generation);
          } catch (err) {
            toast(root, err.message || 'Could not save this draft. Please retry.', 'error');
            throw err;
          }
        }
      }
    );
  }

  /**
   * Creates the DRAFT quote + job via createQuoteDraft() (quote-create.js)
   * — `state.quoteCreateProgress` carries whatever already succeeded
   * across retries of the SAME quote-panel session (reset fresh each time
   * openQuotePanel() opens, or after a successful create here), so a retry
   * after a partial failure reuses ids instead of duplicating them.
   */
  async function createQuoteFlow(payload, businessId, binding, generation) {
    const profile = await TurnKeyApi.getProfile();
    if (generation !== connectionGeneration || !state.session || state.profile?.business_id !== businessId || profile.business_id !== businessId) throw new Error('Your business changed. Reopen the quote before saving.');
    if (binding && (binding.businessId !== businessId || payload.customer.id !== binding.customerId || payload.isNewCustomer)) throw new Error('This quote must stay linked to its original customer.');
    if (binding?.recordId != null && !binding.jobId) throw new Error('This CRM launch is missing its saved job ID. Update TurnKey and reopen this opportunity before saving.');
    const progress = state.quoteCreateProgress || (state.quoteCreateProgress = {});
    const { quote, job, warning } = await createQuoteDraft(TurnKeyApi, progress, { businessId, payload, binding, screenshotDataUrl: state.screenshotDataUrl });
    if (generation !== connectionGeneration || !state.session || state.profile?.business_id !== businessId) return;
    state.quoteCreateProgress = null; // this intent fully succeeded — a future quote starts a clean one

    const publicUrl = state.config.siteUrl + '/quote.html?t=' + quote.public_token;
    // `open=pipeline&job=<id>` lets index.html's own quote-link helper jump
    // straight to the record this just created, instead of landing on the
    // generic dashboard — see extension-quote-link.js (owned separately).
    const openUrl = state.config.siteUrl + '/index.html?open=pipeline&job=' + encodeURIComponent(job.id);
    renderQuoteCreated(
      modalLayer,
      { address: payload.address, total: payload.total, lines: payload.lines, SERVICES, openUrl, publicUrl, warning },
      {
        onSendServiceM8: () => TurnKeyApi.sendQuoteToServiceM8(businessId,job.id),
        onCheckServiceM8: () => TurnKeyApi.serviceM8TransferStatus(businessId,job.id),
        onDone: () => {
          state.measurements = [];
          state.screenshotDataUrl = null;
          toolbar.update(state);
          closeModal();
        }
      }
    );
  }

  async function handleScreenshot() {
    try {
      const dataUrl = await captureVisibleTab();
      state.screenshotDataUrl = dataUrl;
      renderScreenshotPreview(modalLayer, dataUrl, {
        onClose: closeModal,
        onRetake: handleScreenshot,
        onKeep: closeModal
      });
    } catch (err) {
      toast(root, 'Screenshot failed — ' + err.message, 'error');
    }
  }

  function handleToolbarAction(action) {
    if (!requireConnected()) return;
    if (action === 'measure-area') {
      if (!requireLocation()) return;
      openCategoryPicker('closed');
    } else if (action === 'measure-distance') {
      if (!requireLocation()) return;
      openCategoryPicker('open');
    } else if (action === 'manual-windows') {
      openQuotePanel(true);
    } else if (action === 'screenshot') {
      handleScreenshot();
    } else if (action === 'instant-quote') {
      openQuotePanel();
    }
  }

  // Refresh cached auth/business state if the popup connects/disconnects while this tab is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    const previousBusinessId = state.profile?.business_id;
    const changed = connectionChanged(changes);
    if (changed) {
      closeModal();
      state.boundCustomer = null;
      state.boundJob = null;
      state.address = '';
      state.measurements = [];
      state.pendingMeasureRequests = {};
      state.screenshotDataUrl = null;
      state.quoteCreateProgress = null;
      state.contextError = 'Your account changed. Reopen Google Earth from TurnKey.';
      toolbar.update(state);
    }
    await hydrate();
    // The signed-in business changed since this tab bound to a customer
    // (operator disconnected/reconnected a different TurnKey account) —
    // that bound context is now for a different business and must be
    // dropped rather than carried forward.
    if (changed || !state.session || previousBusinessId !== state.profile?.business_id) {
      closeModal();
      state.measurements = [];
      state.screenshotDataUrl = null;
      state.quoteCreateProgress = null;
      state.boundJob = null;
      state.boundRecordId = null;
      state.boundCustomer = null;
      state.boundCustomerBusinessId = null;
      state.addressLocked = false;
      state.address = '';
      state.contextError = 'Your account changed. Reopen Google Earth from TurnKey.';
    }
    toolbar.update(state);
  });

  // The background worker forwards the finished measurement here once the
  // workspace tab/bridge complete it — see background/service-worker.js's
  // TK_MEASURE_RESULT handler and openWorkspaceMeasure() above.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'TK_MEASURE_COMPLETE') sendResponse({ok: handleMeasureComplete(msg)});
  });
}
