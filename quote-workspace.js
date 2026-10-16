/* Staff quote workspace. Load AFTER index.html's app script and sales-platform.js.
 * Reuses the existing map, draft lines, engines, preview/send and approval guards.
 * No persistence occurs until an operator uses the existing save/send actions. */
(function () {
  'use strict';
  if (window.TK_QUOTE_WORKSPACE) return;
  const $ = id => document.getElementById(id);
  const suggestion = '29a Selwyn Crescent, Forrest Hill, Auckland, New Zealand';
  const labels = ['Lead & address', 'Map & services', 'Costs & pricing', 'Preview & send'];
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valid = p => p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const locked = r => !r || isWon(r) || r.quoteStatus === 'accepted';
  let step = 0, panels, nav, next, back, leadId, saving = false;
  let quoteMargin = TK_COST.targetMargin(COST_INPUTS.targetMargin), automatic = false, pricingBusy = false, transferring = false, autoPrices = new WeakMap();
  let baseSelection = null, baseInput = null, mapsPromise, propertySelection = null, propertyBinding;
  function message(text) { $('qw-message').textContent = text; }
  function build() {
    if (panels) return;
    const overlay = $('quote-overlay'), body = overlay.querySelector('.modal-body');
    overlay.classList.add('qw-overlay');
    nav = document.createElement('nav'); nav.className = 'qw-steps'; nav.setAttribute('aria-label', 'Quote steps');
    nav.innerHTML = labels.map((label, i) => `<button type="button" data-step="${i}"><span>${i + 1}</span>${label}</button>`).join('');
    body.before(nav);
    panels = labels.map((label, i) => {
      const section = document.createElement('section'); section.className = 'qw-panel'; section.id = 'qw-step-' + i;
      section.setAttribute('aria-label', label); body.append(section); return section;
    });
    panels[0].innerHTML = '<h3>Start with the property</h3><p id="qw-client"></p><div class="field"><label for="qw-address">Property address</label><input id="qw-address" autocomplete="street-address"></div><div class="field"><label for="qw-suburb">Suburb</label><input id="qw-suburb" autocomplete="address-level2"></div><p class="qw-help">Confirm the address before measuring. Changes apply to this opportunity when you continue.</p>';
    ['quote-map-zone', 'req-services-zone', 'svc-builder'].forEach(id => panels[1].append($(id)));
    panels[1].append(body.querySelector('.add-svc'));
    const mapIntro = document.createElement('div'); mapIntro.className = 'qw-section-head';
    mapIntro.innerHTML = '<h3>Measure &amp; choose services</h3><p>Choose a service above the map, then tap its outline. You can also enter quantities below.</p>';
    panels[1].prepend(mapIntro);
    ['assumptions-zone', 'estimate-zone'].forEach(id => panels[2].append($(id)));
    // Move, rather than rebuild, the proven pricing and attachment controls.
    [...body.children].filter(el => !el.classList.contains('qw-panel')).forEach(el => panels[2].append(el));
    const pricing = document.createElement('section'); pricing.className = 'qw-pricing-controls';
    pricing.innerHTML = '<div><h3>Set a profitable price</h3><p>Recommendations include fuel, delivery costs and your target margin. Recommendations protect the target for easy access; difficult access and premium handling add to the price.</p></div><div class="qw-margin-row"><label for="qw-margin">Target profit margin (%)<input id="qw-margin" type="number" min="0" max="95" step="1" inputmode="decimal" aria-describedby="qw-margin-help"></label><button type="button" class="btn primary" id="qw-apply-pricing">Apply recommended prices</button></div><p id="qw-margin-help" class="qw-help">For this quote only. Margin uses ex-GST revenue when GST registered. Applying replaces draft prices and clears any total override.</p><label class="qw-auto"><input id="qw-auto" type="checkbox"> Keep unedited prices updated as measurements and travel change</label><p id="qw-pricing-status" class="qw-help" role="status"></p>';
    panels[2].prepend(pricing);
    $('qw-margin').addEventListener('change', () => {
      const value = Number($('qw-margin').value);
      if ($('qw-margin').value === '' || !Number.isFinite(value) || value < 0 || value > 95) { $('qw-margin').setCustomValidity('Enter a margin from 0 to 95%.'); $('qw-margin').reportValidity(); return; }
      $('qw-margin').setCustomValidity(''); quoteMargin = value / 100; updateQuoteTotal();
    });
    $('qw-auto').onchange = () => { automatic = $('qw-auto').checked; updateQuoteTotal(); };
    $('qw-apply-pricing').onclick = () => applyRecommendedPricing();
    panels[3].innerHTML = '<h3>Check the customer quote</h3><div id="qw-preview"></div><p class="qw-help">Preview in TurnKey, or save this quote and queue it in ServiceM8. Customer email is a separate action.</p>';
    const status = document.createElement('p'); status.id = 'qw-message'; status.className = 'qw-message'; status.setAttribute('role', 'status'); body.append(status);
    const footer = overlay.querySelector('.modal-foot');
    footer.innerHTML = '<button type="button" class="btn ghost" id="qw-back">Back</button><span id="qw-progress"></span><button type="button" class="btn ghost qw-transfer" id="qw-transfer" hidden>Save &amp; send to ServiceM8</button><button type="button" class="btn primary" id="qw-next">Continue</button>';
    next = $('qw-next'); back = $('qw-back');
    $('qw-transfer').onclick = transferQuote;
    back.onclick = () => go(step - 1);
    next.onclick = () => step === 3 ? preview() : go(step + 1);
    nav.addEventListener('click', e => { const b = e.target.closest('[data-step]'); if (b) go(Number(b.dataset.step)); });
  }
  function applyAddress() {
    const r = records.find(r => r.id === leadId);
    const address = $('qw-address').value.trim(), suburb = $('qw-suburb').value.trim();
    if (!address) { message('Enter a property address to continue.'); $('qw-address').focus(); return false; }
    const selectedCenter = propertySelection?.address === address && !(r.areaPolys || []).length;
    if (r.address !== address || (r.suburb || '') !== suburb || selectedCenter) {
      r.address = address; r.suburb = suburb;
      // Coordinates and polygons belong to the old property; never silently reuse them.
      r.mapCenter = propertySelection?.address === address ? {lat:propertySelection.lat,lng:propertySelection.lng,zoom:QE_ZOOM_DEFAULT} : null; r.areaPolys = [];
      renderQuoteMap(r); loadQuoteTravelInfo(r);
    }
    return true;
  }
  function go(target) {
    if (transferring || target < 0 || target > 3) return;
    const r = records.find(r => r.id === leadId);
    if (locked(r)) { toast('Approved quote is locked.'); return; }
    if (target > 0 && step === 0) {
      if ((r.areaPolys || []).length && ($('qw-address').value.trim() !== r.address || $('qw-suburb').value.trim() !== (r.suburb || ''))) {
        message('This property has measurements. Keep its address, or create a new opportunity for a different property.'); return;
      }
      if (!applyAddress()) return;
    }
    if (target > 1 && !draftLines.some(l => parseFloat(l.qty) > 0)) { message('Add a service and quantity before reviewing pricing.'); return; }
    if (target > 2 && !$('qw-margin').reportValidity()) return;
    step = target;
    panels.forEach((p, i) => { p.hidden = i !== step; });
    [...nav.children].forEach((b, i) => { b.setAttribute('aria-current', i === step ? 'step' : 'false'); });
    back.disabled = step === 0; back.textContent = step ? '← ' + labels[step - 1] : 'Back';
    next.textContent = ['Measure property →','Review pricing →','Review quote →','Open document preview →'][step];
    $('qw-transfer').hidden = step !== 3;
    $('qw-progress').textContent = `${step + 1} of 4`; message('');
    if (step === 2) renderEstimate();
    if (step === 3) {
      $('qw-preview').innerHTML = `<p><strong>${esc(r.name)}</strong><br>${esc(r.address)}${r.suburb ? ', ' + esc(r.suburb) : ''}</p><ul>${draftLines.filter(l => parseFloat(l.qty) > 0).map(l => `<li>${esc(SERVICES[l.svc]?.label || l.svc)} · ${esc(l.qty)} ${esc(SERVICES[l.svc]?.unit)} <strong>${money(lineSubtotal(l))}</strong></li>`).join('')}</ul><div class="qw-preview-total">Customer total <strong>${money(quoteTotal())}</strong></div><p>${COST_INPUTS.gstRegistered ? 'Includes GST.' : 'Business is not GST registered.'} Internal costs are excluded from the customer document.</p>`;
    }
    $('quote-overlay').querySelector('.modal-body').scrollTop = 0;
    nav.children[step].focus();
  }
  function preview() {
    const r = records.find(r => r.id === leadId);
    if (locked(r)) { toast('Approved quote is locked.'); return; }
    if (!$('qw-margin').reportValidity()) return;
    if (!draftLines.some(l => parseFloat(l.qty) > 0) || !(quoteTotal() > 0)) { message('Add a service and a positive quote total.'); return; }
    closeModal('quote-overlay');
    confirmQuoteSend(); // Captures travel/cost snapshots and preserves the sales-platform approval guard.
    return docPreview?.mode === 'quote' && docPreview.recordId === r.id && $('doc-preview-overlay').classList.contains('open');
  }
  async function transferQuote() {
    if (transferring) return;
    const id = leadId, businessId = currentBusinessId;
    const button = $('qw-transfer');
    if (typeof window.TK_SALES_PLATFORM?.transferQuote !== 'function') { message('ServiceM8 transfer is unavailable. Reload the app and try again.'); return; }
    transferring = true; button.disabled = true; next.disabled = true;
    const disabled = [];
    try {
      if (!preview()) return;
      const note = document.createElement('p'); note.id = 'qw-transfer-status'; note.className = 'qw-transfer-status'; note.setAttribute('role','status'); note.textContent = 'Saving quote and queuing it in ServiceM8… No customer email is being sent.';
      $('doc-preview-body').prepend(note);
      // Prevent another action on this document while the transfer is in flight.
      $('doc-preview-foot').querySelectorAll('button').forEach(b => { disabled.push([b,b.disabled]); b.disabled = true; });
      await window.TK_SALES_PLATFORM.transferQuote(id);
      if (businessId === currentBusinessId && docPreview?.mode === 'quote' && docPreview.recordId === id) closeDocPreview();
      toast('Quote queued for ServiceM8. Send it to the customer from there.');
    } catch (error) {
      const text = 'Could not queue quote in ServiceM8: ' + (error?.message || 'Please try again.');
      if (businessId === currentBusinessId && docPreview?.recordId === id) {
        const note = $('qw-transfer-status'); if (note) { note.setAttribute('role','alert'); note.textContent = text + ' Your document preview remains open.'; }
      }
      toast(text);
    } finally {
      disabled.forEach(([b,value]) => { if (b.isConnected) b.disabled = value; });
      transferring = false; button.disabled = false; next.disabled = false;
    }
  }
  const originalOpen = openQuoteModal;
  openQuoteModal = function (id) {
    const r = records.find(r => r.id === id);
    if (locked(r)) { toast('Approved pricing is locked. Create a new opportunity for additional work.'); return; }
    build(); leadId = id;
    quoteMargin = TK_COST.targetMargin(r.targetMargin,TK_COST.targetMargin(COST_INPUTS.targetMargin));
    automatic = !r.quoteSentAt && !r.quoteId && !(r.total > 0) && !r.selfPriced && !r.services?.length;
    autoPrices = new WeakMap();
    $('qw-margin').value = Math.round(quoteMargin * 100); $('qw-margin').setCustomValidity(''); $('qw-auto').checked = automatic;
    originalOpen(id);
    $('qw-client').textContent = [r.name, r.phone, r.email].filter(Boolean).join(' · ');
    $('qw-address').value = r.address || ''; $('qw-suburb').value = r.suburb || '';
    step = 0; go(0); enhanceProperty(r);
  };
  // Legacy views read COST_INPUTS synchronously. Scope that read while rendering
  // or capturing the quote snapshot, then restore the business default in finally.
  // The engine's options argument is used directly for all draft recommendations.
  function withMargin(fn) {
    const before = COST_INPUTS.targetMargin;
    try { COST_INPUTS.targetMargin = quoteMargin; return fn(); }
    finally { COST_INPUTS.targetMargin = before; }
  }
  // Shared pricing applies assumptions AFTER line totals. Compensate only
  // discounts when recommending so easy access cannot undo the target floor.
  // Manual rates and public pricing/measurement formulas remain unchanged.
  function recommendedRate(price,qty) {
    const discount = Math.min(1,TK_PRICING.accessPremiumMult(quoteAssumptions));
    return price / (Number(qty) * discount);
  }
  function recommend(force) {
    const r = records.find(r => r.id === leadId);
    if (locked(r) || (!force && (!automatic || quoteTotalOverride !== null))) return false;
    const breakdown = TK_COST.costBreakdown(draftLines, quoteTravelInfo, {targetMargin:quoteMargin});
    let changed = false;
    breakdown.lines.forEach(({line,recommendedPrice}) => {
      const previous = autoPrices.get(line);
      const untouched = previous ? line.fixedPrice == null && line.customRate === previous.rate : line.fixedPrice == null && line.customRate == null;
      if (!force && !untouched) return;
      const rate = recommendedRate(recommendedPrice,line.qty);
      if (line.customRate !== rate || line.fixedPrice != null) changed = true;
      // Use a rate so the existing map aggregation can keep updating quantities.
      line.fixedPrice = null; line.customRate = rate; autoPrices.set(line,{rate});
    });
    if (force) quoteTotalOverride = null;
    return changed;
  }
  function pricingStatus() {
    if (!$('qw-pricing-status')) return;
    $('qw-auto').checked = automatic;
    $('qw-pricing-status').textContent = quoteTotalOverride !== null ? 'Manual total retained. Apply recommended prices to replace it.'
      : automatic ? 'Automatic recommendations are on. Existing or manually edited prices are kept; use Apply to replace them.'
      : 'Automatic updates are off. Current prices are kept. Apply recommendations when you are ready.';
    document.querySelectorAll('#svc-builder .svc-line').forEach((row,i) => {
      const line = draftLines[i], price = row.querySelector('.price-input');
      if (line && autoPrices.has(line) && price && document.activeElement !== price && line.fixedPrice == null) price.value = Number(line.customRate).toFixed(2);
    });
  }
  const originalUpdate = updateQuoteTotal, originalLines = renderSvcLines;
  updateQuoteTotal = function () { if (!pricingBusy) recommend(false); return withMargin(() => originalUpdate()); };
  renderSvcLines = function () { if (!pricingBusy) recommend(false); const result = withMargin(() => originalLines()); pricingStatus(); return result; };
  applyRecommendedPricing = function () {
    if (!$('qw-margin').reportValidity()) return;
    if (locked(records.find(r => r.id === leadId))) { toast('Approved quote is locked.'); return; }
    if (!draftLines.some(l => Number(l.qty) > 0)) { toast('Add a service with a quantity first.'); return; }
    recommend(true); renderSvcLines(); toast('Recommended draft prices applied at ' + Math.round(quoteMargin * 100) + '% target margin');
  };
  // Per-line recommendation buttons must use the same travel and target as the job.
  resetLineToRecommended = function (i) {
    if (locked(records.find(r => r.id === leadId))) return;
    const entry = TK_COST.costBreakdown(draftLines,quoteTravelInfo,{targetMargin:quoteMargin}).lines.find(e => e.line === draftLines[i]);
    if (!entry) return;
    entry.line.fixedPrice = null; entry.line.customRate = recommendedRate(entry.recommendedPrice,entry.line.qty);
    autoPrices.set(entry.line,{rate:entry.line.customRate}); renderSvcLines();
  };
  const originalConfirm = confirmQuoteSend;
  confirmQuoteSend = function () { return withMargin(() => originalConfirm()); };
  let travelRequest = 0, travelPending = false;
  const originalEstimate = renderEstimate;
  renderEstimate = function () {
    if (!pricingBusy && recommend(false)) {
      pricingBusy = true;
      try { withMargin(() => originalUpdate()); } finally { pricingBusy = false; }
    }
    withMargin(() => originalEstimate()); pricingStatus();
    // The workspace exposes one consistent recommendation action above the estimate.
    $('estimate-zone')?.querySelector('[onclick="applyRecommendedPricing()"]')?.remove();
    const zone = $('estimate-zone');
    if (!zone || !draftLines.some(l => parseFloat(l.qty) > 0)) return;
    const note = document.createElement('p'); note.className = 'qw-help'; note.id = 'qw-travel-status'; note.setAttribute('role', 'status');
    note.textContent = travelPending ? 'Looking up travel. Configured default fuel distance is used until the lookup finishes.'
      : quoteTravelInfo?.source === 'google' ? 'Travel uses road distance and driving time from your business base; round trip is estimated as twice the one-way route.'
      : quoteTravelInfo ? 'Travel is estimated from straight-line distance with a road allowance, not a driving route.'
      : 'Travel uses the configured default distance. Set a business base in Settings, or check the property address and try again.';
    zone.prepend(note);
  };
  loadQuoteTravelInfo = async function (r) {
    const request = ++travelRequest;
    quoteTravelInfo = null; quoteTravelInfoForId = r.id; travelPending = true; renderEstimate();
    let info = null;
    try { info = await calcTravelDistance(r.address, r.suburb, r.mapCenter); } catch (_) { /* Default cost inputs remain usable. */ }
    if (request !== travelRequest || activeLeadId !== r.id) return;
    quoteTravelInfo = info; travelPending = false; renderEstimate();
  };
  // Bound both SDK loading and service calls, including an importLibrary that never settles.
  function deadline(promise, ms = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Maps lookup timed out')), ms);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  function maps() {
    if (window.google?.maps?.importLibrary) return Promise.resolve(google.maps);
    if (mapsPromise) return mapsPromise;
    const key = turnkeyMapsKey();
    if (!key) return Promise.reject(new Error('No Maps key'));
    mapsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('Maps timed out')); }, 10000);
      window.tkQuotePlacesReady = () => { clearTimeout(timer); resolve(google.maps); };
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&callback=tkQuotePlacesReady&v=weekly';
      script.async = true;
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Maps unavailable')); };
      document.head.append(script);
    }).catch(error => { mapsPromise = null; throw error; });
    return mapsPromise;
  }
  async function library(name) { return deadline(maps().then(api => api.importLibrary(name)), 12000); }
  function places() { return library('places'); }
  async function enhanceProperty(r) {
    propertyBinding?.abort(); propertyBinding = new AbortController();
    const {signal} = propertyBinding;
    const input = $('qw-address'); propertySelection = null;
    panels[0].querySelector('.qw-places')?.remove();
    $('qw-property-help')?.remove();
    const help = document.createElement('p'); help.id = 'qw-property-help'; help.className = 'qw-help'; help.setAttribute('role', 'status');
    help.textContent = 'Search for a property, then choose a Places result. You can also enter its full address manually.';
    input.after(help);
    let generation = 0;
    input.addEventListener('input', () => { generation++; propertySelection = null; }, {signal});
    try {
      const {PlaceAutocompleteElement} = await places();
      if (signal.aborted) return;
      const widget = new PlaceAutocompleteElement({}); widget.className = 'qw-places'; widget.setAttribute('aria-label', 'Search property address'); input.before(widget);
      widget.addEventListener('gmp-error', () => { help.textContent = 'Places unavailable. Enter the full property address manually; the map will attempt a lookup.'; }, {signal});
      widget.addEventListener('gmp-select', async event => {
        const token = ++generation;
        try {
          const place = event.placePrediction.toPlace(); await place.fetchFields({fields:['formattedAddress','location']});
          if (signal.aborted || token !== generation || activeLeadId !== r.id) return;
          const p = {lat:place.location?.lat(),lng:place.location?.lng()};
          if (!place.formattedAddress || !valid(p)) throw new Error('No coordinates');
          propertySelection = {address:place.formattedAddress,...p}; input.value = place.formattedAddress;
          $('qw-suburb').value = ''; // formattedAddress already contains the suburb; do not append an old one.
          help.textContent = 'Property selected. Continue to use its coordinates for the map and travel estimate.';
        } catch (_) { if (!signal.aborted) help.textContent = 'Could not resolve that property. Choose another result or enter the full address manually.'; }
      }, {signal});
    } catch (_) { if (!signal.aborted) help.textContent = 'Places unavailable. Enter the full property address manually; the map will attempt a lookup.'; }
  }
  // A Places-selected property already has coordinates. Keep the proven map
  // renderer/projection and imagery fallbacks, without re-geocoding that selection.
  const originalMapLoad = qeLoadMap;
  qeLoadMap = function () {
    const center = qe?.r?.mapCenter;
    if (valid(center)) {
      qe.provider = qe.mapsKey ? 'google' : 'osm';
      qeReloadAt(Number(center.lat), Number(center.lng), center.zoom || QE_ZOOM_DEFAULT);
    } else originalMapLoad();
  };
  const originalToolbar = qeRenderToolbar;
  qeRenderToolbar = function () {
    originalToolbar();
    const toolbar = $('qe-toolbar'); if (!toolbar || !qe) return;
    toolbar.querySelector('[onclick="qeToggleSatellite()"]')?.remove();
    const modes = document.createElement('div'); modes.className = 'qw-map-modes'; modes.setAttribute('role','group'); modes.setAttribute('aria-label','Map imagery');
    modes.innerHTML = ['satellite','roadmap'].map(mode => `<button type="button" class="btn ghost sm" data-qw-map="${mode}" aria-pressed="${qe.provider === 'google' && qe.mapType === mode}" ${qe.provider === 'google' ? '' : 'disabled'}>${mode === 'satellite' ? 'Satellite' : 'Street map'}</button>`).join('');
    modes.onclick = event => { const mode = event.target.closest('[data-qw-map]')?.dataset.qwMap; if (!mode || qe.provider !== 'google') return; qe.mapType = mode; qeReloadAt(qe.lat,qe.lng,qe.zoom); qeRenderToolbar(); };
    toolbar.prepend(modes);
    let status = $('qw-map-status');
    if (!status) { status = document.createElement('p'); status.id = 'qw-map-status'; status.className = 'qw-map-status'; status.setAttribute('role','status'); toolbar.after(status); }
    status.textContent = qe.provider === 'google' ? (qe.mapType === 'satellite' ? 'Satellite imagery' : 'Street map') + ' · zoom ' + qe.zoom + ' · outlines stay anchored when you change view.'
      : qe.provider === 'osm' ? 'Street map fallback. Satellite imagery is unavailable; existing measurements are retained.'
      : qe.provider === 'grid' ? 'Drawing grid only — not a satellite image or a scaled property measurement.' : 'Locating property and loading imagery…';
    toolbar.querySelectorAll('button').forEach(button => { if (!button.getAttribute('aria-label')) button.setAttribute('aria-label',button.title || button.textContent.trim()); });
  };
  async function enhanceBase() {
    const input = $('biz-home-address-input'); if (!input || input.dataset.qw) return;
    let generation = 0;
    input.dataset.qw = 'true'; baseInput = input; baseSelection = null;
    input.placeholder = suggestion;
    input.closest('.field').querySelector('label').textContent = 'Business base address';
    const help = document.createElement('p'); help.className = 'qw-help'; help.id = 'qw-base-help'; help.setAttribute('role', 'status');
    help.textContent = 'Choose a Places result for accurate coordinates. Or enter an address manually; travel will be labelled as estimated when road routing is unavailable.';
    input.after(help);
    const seed = document.createElement('button'); seed.type = 'button'; seed.className = 'btn ghost sm qw-base-suggestion'; seed.textContent = 'Use suggested address';
    seed.onclick = () => { input.value = suggestion; input.dispatchEvent(new Event('input')); input.focus(); };
    help.after(seed);
    input.addEventListener('input', () => { generation++; baseSelection = null; help.textContent = 'Address changed. Select a Places result or save to attempt a manual lookup.'; });
    try {
      const { PlaceAutocompleteElement } = await places();
      if (!input.isConnected) return;
      const widget = new PlaceAutocompleteElement({}); widget.className = 'qw-places'; widget.setAttribute('aria-label', 'Search business base address');
      input.before(widget);
      widget.addEventListener('gmp-error', () => { help.textContent = 'Places unavailable. Enter the full address below; saving will attempt a manual lookup.'; });
      widget.addEventListener('gmp-select', async event => {
        const token = ++generation;
        try {
          const place = event.placePrediction.toPlace(); await place.fetchFields({ fields: ['formattedAddress', 'location'] });
          const p = { lat: place.location?.lat(), lng: place.location?.lng() };
          if (token !== generation || !input.isConnected) return;
          if (!place.formattedAddress || !valid(p)) throw new Error('No coordinates');
          input.value = place.formattedAddress; baseSelection = { address: place.formattedAddress, ...p };
          help.textContent = 'Place selected. Save business profile to use this base for travel fuel and driving time.';
        } catch (_) { help.textContent = 'Could not resolve that place. Select another result or enter the address manually.'; }
      });
    } catch (_) { if (input.isConnected) help.textContent = 'Places unavailable. Enter the full address manually. Saving will attempt a lookup; if it fails, travel uses your configured default.'; }
  }
  const originalSettings = openSettings;
  openSettings = function () { const result = originalSettings.apply(this, arguments); enhanceBase(); return result; };
  saveBusinessProfile = async function () {
    if (saving || !sb || !currentBusinessId) return;
    if (!['owner', 'manager'].includes(currentUserRole)) { toast('Only an owner or manager can edit the business profile.'); return; }
    const input = $('biz-home-address-input'); if (!input) return;
    const businessId = currentBusinessId, profile = currentBusinessProfile || {};
    const value = id => $(id).value.trim();
    const address = input.value.trim(), region = value('biz-region-input');
    const payload = { id: businessId, name: value('biz-name-input'), phone: value('biz-phone-input'), email: value('biz-email-input'), region, home_address: address, home_lat: null, home_lng: null };
    saving = true;
    try {
      let loc = baseInput === input && baseSelection?.address === address ? baseSelection : null;
      if (!loc && address === profile.home_address && valid({lat:profile.home_lat,lng:profile.home_lng})) loc = {lat:profile.home_lat,lng:profile.home_lng};
      if (!loc && address) loc = await deadline(geocodeRegion(address)).catch(() => null);
      if (valid(loc)) { payload.home_lat = Number(loc.lat); payload.home_lng = Number(loc.lng); }
      if (region !== (profile.region || '')) {
        const geo = region ? await deadline(geocodeRegion(region)).catch(() => null) : null;
        payload.region_lat = valid(geo) ? Number(geo.lat) : null; payload.region_lng = valid(geo) ? Number(geo.lng) : null;
      }
      if (currentBusinessId !== businessId) return;
      const {data,error} = await sb.from('businesses').upsert(payload).select('*').maybeSingle();
      if (error || !data) throw error || new Error('No saved profile returned');
      if (currentBusinessId !== businessId) return;
      currentBusinessProfile = data; openSettings();
      toast(address && !valid(loc) ? 'Profile saved. Address could not be located; travel uses the configured default.' : 'Business profile saved');
    } catch (e) { toast('Could not save business profile — try again'); }
    finally { saving = false; }
  };
  // Browser-safe SDK routing only: never delegate to the legacy REST implementation.
  // https://developers.google.com/maps/documentation/javascript/reference/distance-matrix
  calcTravelDistance = async function (address, suburb, destinationLocation) {
    const biz = currentBusinessProfile;
    const destination = [address,suburb].filter(Boolean).join(', ');
    if (!biz?.home_address || !destination) return null;
    const base = {lat:biz.home_lat,lng:biz.home_lng};
    try {
      const {DistanceMatrixService} = await library('routes');
      const response = await deadline(new DistanceMatrixService().getDistanceMatrix({
        origins:[valid(base) ? {lat:Number(base.lat),lng:Number(base.lng)} : biz.home_address],
        destinations:[valid(destinationLocation) ? {lat:Number(destinationLocation.lat),lng:Number(destinationLocation.lng)} : destination],
        travelMode:'DRIVING'
      }));
      const element = response?.rows?.[0]?.elements?.[0];
      const metres = element?.distance?.value, seconds = element?.duration?.value;
      if (element?.status === 'OK' && Number.isFinite(metres) && metres >= 0 && Number.isFinite(seconds) && seconds >= 0) {
        // Preserve the existing engine contract: round trip = twice one-way.
        return {km:metres / 1000 * 2,mins:seconds / 60 * 2,source:'google'};
      }
    } catch (_) { /* Missing SDK, denied routing, timeout, or quota: labelled estimate below. */ }
    if (!valid(base)) return null;
    let location = destinationLocation;
    if (!valid(location)) {
      try { location = await deadline(geocodeRegion(destination)); } catch (_) { return null; }
    }
    if (!valid(location)) return null;
    // Same established 1.3 road allowance and 45 km/h assumption, never labelled a route.
    const roadKm = haversineKm(Number(base.lat),Number(base.lng),Number(location.lat),Number(location.lng)) * 1.3;
    return {km:roadKm * 2,mins:roadKm / 45 * 60 * 2,source:'estimate'};
  };
  window.TK_QUOTE_WORKSPACE = { version: 1 };
})();
