import { Storage } from '../../api/storage.js';
import { TurnKeyClient } from '../../api/turnkey-api.js';
import { mountToolbar } from './toolbar.js';
import { createTracer } from './measurement.js';
import { renderQuotePanel, renderQuoteCreated } from './quote.js';
import { captureVisibleTab, dataUrlToBlob, renderScreenshotPreview } from './screenshot.js';

const CATEGORIES = [
  { key: 'roof', label: 'Roof', shape: 'area' },
  { key: 'driveway', label: 'Driveway', shape: 'area' },
  { key: 'house', label: 'House', shape: 'area' },
  { key: 'deck', label: 'Deck', shape: 'area' },
  { key: 'concrete', label: 'Concrete', shape: 'area' },
  { key: 'custom', label: 'Custom area', shape: 'area' },
  { key: 'fence', label: 'Fence', shape: 'line' },
  { key: 'custom-line', label: 'Custom distance', shape: 'line' }
];

/** Google Earth encodes its current camera look-at point in the URL as it flies (`@lat,lng,...`) — the only property-location signal a content script can legitimately read (see measurement.js's header comment for why nothing more precise is attempted). */
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
    screenshotDataUrl: null
  };
  let client = null;

  async function hydrate() {
    const stored = await Storage.loadAll();
    state = { ...state, ...stored };
    if (state.config) {
      client = new TurnKeyClient(state.config, state.session, (session) => {
        state.session = session;
        Storage.setSession(session);
      });
    }
  }
  await hydrate();

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
    if (cam.addressGuess && cam.addressGuess !== state.address) {
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

  function openCategoryPicker(shape) {
    const options = CATEGORIES.filter((c) => c.shape === shape);
    modalLayer.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-category-modal">
          <div class="tk-modal-head">
            <h3>${shape === 'area' ? 'What are you measuring?' : 'What is this distance?'}</h3>
            <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="tk-category-grid">
            ${options.map((o) => `<button type="button" class="tk-category-btn" data-cat="${o.key}">${o.label}</button>`).join('')}
          </div>
        </div>
      </div>`;
    modalLayer.querySelector('[data-close]').addEventListener('click', closeModal);
    modalLayer.querySelectorAll('[data-cat]').forEach((b) =>
      b.addEventListener('click', () => openTracer(shape, b.getAttribute('data-cat')))
    );
  }

  function openTracer(shape, categoryKey) {
    const category = CATEGORIES.find((c) => c.key === categoryKey);
    modalLayer.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-tracer-modal">
          <div class="tk-modal-head">
            <h3>${category.label}</h3>
            <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="tk-tracer-host" data-role="tracer"></div>
          <div class="tk-tracer-readout" data-role="readout">Click points on the map to trace ${shape === 'area' ? 'the outline' : 'the line'}.</div>
          <div class="tk-modal-foot">
            <button type="button" class="tk-btn" data-undo>Undo point</button>
            <button type="button" class="tk-btn" data-clear>Clear</button>
            <button type="button" class="tk-btn tk-btn-accent" data-finish disabled>Finish</button>
          </div>
        </div>
      </div>`;
    modalLayer.querySelector('[data-close]').addEventListener('click', () => { tracer.destroy(); closeModal(); });

    const tracer = createTracer(modalLayer.querySelector('[data-role="tracer"]'), {
      lat: state.lat,
      lng: state.lng,
      shape,
      onChange: ({ points, canFinish, value }) => {
        const readout = modalLayer.querySelector('[data-role="readout"]');
        const finishBtn = modalLayer.querySelector('[data-finish]');
        finishBtn.disabled = !canFinish;
        if (!points) {
          readout.textContent = `Click points on the map to trace ${shape === 'area' ? 'the outline' : 'the line'}.`;
        } else if (shape === 'area') {
          readout.innerHTML = `<strong>${Math.round(value.m2 * 10) / 10} m²</strong> · perimeter ${Math.round(value.m)} m`;
        } else {
          readout.innerHTML = `<strong>${Math.round(value.m * 10) / 10} m</strong>`;
        }
      }
    });
    modalLayer.querySelector('[data-undo]').addEventListener('click', () => tracer.undo());
    modalLayer.querySelector('[data-clear]').addEventListener('click', () => tracer.clear());
    modalLayer.querySelector('[data-finish]').addEventListener('click', () => {
      const svc = guessServiceForCategory(category.key, shape);
      const measurement = tracer.finish(category.key, svc);
      if (!measurement) return;
      measurement.categoryLabel = category.label;
      state.measurements.push(measurement);
      toolbar.update(state);
      tracer.destroy();
      closeModal();
      toast(root, `${category.label} saved — ${measurement.size}${measurement.unit === 'm²' ? ' m²' : ' m'}`);
    });
  }

  function guessServiceForCategory(categoryKey, shape) {
    const hintMap = { roof: 'roof', driveway: 'driveway', concrete: 'driveway', house: 'housewash', fence: 'fence', deck: 'deck' };
    if (hintMap[categoryKey] && SERVICES[hintMap[categoryKey]]) return hintMap[categoryKey];
    const wantShape = shape === 'area' ? 'closed' : 'open';
    const match = Object.keys(SERVICES).find((k) => SERVICES[k].shape === wantShape);
    return match || Object.keys(SERVICES)[0];
  }

  async function openQuotePanel() {
    if (!requireConnected()) return;
    if (!state.measurements.length) {
      toast(root, 'Measure at least one area or distance first.', 'error');
      return;
    }
    if (state.business && state.business.pricing_config && state.business.pricing_config.rates) {
      applyRateOverrides(state.business.pricing_config.rates);
    }
    renderQuotePanel(
      modalLayer,
      { measurements: state.measurements, address: state.address, TK_PRICING, business: state.business },
      {
        onCancel: closeModal,
        onSearchCustomer: async (query) => {
          if (!query || query.length < 2) return [];
          try {
            const all = await client.listCustomers(state.profile.business_id);
            const q = query.toLowerCase();
            return all.filter((c) => (c.name || '').toLowerCase().includes(q)).slice(0, 8);
          } catch (e) {
            return [];
          }
        },
        onCreateQuote: async (payload) => {
          try {
            await createQuoteFlow(payload);
          } catch (err) {
            toast(root, 'Could not reach TurnKey — check your connection and try again.', 'error');
            throw err;
          }
        }
      }
    );
  }

  async function createQuoteFlow(payload) {
    const businessId = state.profile.business_id;
    let customerId = payload.isNewCustomer ? null : payload.customer.id;
    if (payload.isNewCustomer) {
      const created = await client.createCustomer(businessId, {
        name: payload.customer.name,
        phone: payload.customer.phone || '',
        email: payload.customer.email || '',
        address: payload.address || '',
        source: 'Google Earth Extension'
      });
      customerId = created.id;
    }
    const quote = await client.createQuote(businessId, { customerId, amount: payload.total });
    const job = await client.createJob(businessId, {
      customerId,
      quoteId: quote.id,
      details: {
        services: payload.lines,
        total: payload.total,
        areaPolys: payload.areaPolys,
        source: 'Google Earth Extension',
        quoteSentAt: Date.now()
      }
    });
    if (state.screenshotDataUrl) {
      try {
        await client.uploadScreenshot(businessId, customerId, job.id, dataUrlToBlob(state.screenshotDataUrl));
      } catch (e) {
        // Non-fatal — the quote itself already succeeded.
      }
    }
    await client.logActivity(businessId, {
      customerId,
      jobId: job.id,
      type: 'quote_sent',
      summary: 'Quote created from Google Earth — ' + payload.lines.length + ' service' + (payload.lines.length === 1 ? '' : 's') + ', ' + payload.total
    });

    const publicUrl = state.config.siteUrl + '/quote.html?t=' + quote.public_token;
    const openUrl = state.config.siteUrl + '/index.html';
    renderQuoteCreated(
      modalLayer,
      { address: payload.address, total: payload.total, lines: payload.lines, SERVICES, openUrl, publicUrl },
      {
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
      openCategoryPicker('area');
    } else if (action === 'measure-distance') {
      if (!requireLocation()) return;
      openCategoryPicker('line');
    } else if (action === 'screenshot') {
      handleScreenshot();
    } else if (action === 'instant-quote') {
      openQuotePanel();
    }
  }

  // Refresh cached auth/business state if the popup connects/disconnects while this tab is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    await hydrate();
    toolbar.update(state);
  });
}
