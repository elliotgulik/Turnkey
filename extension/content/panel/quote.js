import { instantPricing } from './quote-pricing.js';
// Instant Quote panel (build brief §9-§12) — turns the measurements list
// into priced service lines using TurnKey's own shared pricing engine
// (vendor/pricing-engine.js, the exact same window.TK_PRICING loaded by
// index.html/booking.html/quote.html — not a second pricing implementation),
// then creates the quote in Supabase using the same table shape
// syncRecordToSupabase() writes in index.html.
function money(n) {
  return '$' + (Math.round(n * 100) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Every value interpolated into innerHTML/attribute strings below can come
// from the operator's own typed input or a customer's stored name/address
// — both are untrusted as far as HTML is concerned. Escaped at the point
// of interpolation rather than trusted upstream, since the CRM's own
// customer records can contain anything a past form submission put there.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Renders the quote builder into `container`. `ctx` = {measurements, address, TK_PRICING, business, customers}.
 * `actions` = {onCreateQuote(payload), onSearchCustomer(query), onCancel}.
 */
export function renderQuotePanel(container, ctx, actions) {
  const { SERVICES } = ctx.TK_PRICING;
  // Each measurement becomes one candidate line, defaulted ON. `m.service`
  // was already resolved once, when the measurement was finished (see
  // app.js's guessServiceForCategory()) — reused here rather than
  // re-guessing, so the service shown here always matches what's stored.
  const lineState = ctx.measurements.map((m) => ({
    measurementId: m.id,
    include: true,
    svc: m.service || Object.keys(SERVICES)[0],
    qty: m.size,
    unit: m.unit,
    categoryLabel: m.categoryLabel
  }));
  let customPrice=null, localMargin=ctx.TK_COST.targetMargin(ctx.TK_COST.COST_INPUTS.targetMargin), travelKm=ctx.TK_COST.COST_INPUTS.avgKm;
  const estimatedAt=new Date().toISOString();
  const priceModel=()=>instantPricing(ctx.TK_PRICING,ctx.TK_COST,computeLines(),{targetMargin:localMargin,price:customPrice,travelKm,estimatedAt});
  const extraLines = []; // ad-hoc services not tied to a drawn measurement
  // When this tab was opened from an existing customer's "Build quote"
  // button (see app.js's loadBoundCustomerContext()), the quote is for
  // THAT customer and nothing else — no re-picking, no "new customer" path.
  const customerLocked = !!ctx.boundCustomer;
  let selectedCustomer = ctx.boundCustomer ? { id: ctx.boundCustomer.id, name: ctx.boundCustomer.name } : null; // {id,name} | null = "new customer"
  let newCustomer = { name: '', phone: '', email: '' };

  function computeLines() {
    const included = lineState.filter((l) => l.include).map((l) => ({ svc: l.svc, qty: l.qty }));
    const extras = extraLines.filter((l) => l.include).map((l) => ({ svc: l.svc, qty: l.qty }));
    return included.concat(extras);
  }

  /**
   * `measurementType` is the measurement's `kind` ('area'|'perimeter'|
   * 'line') — filtered by BOTH the service's click-interaction shape
   * ('closed' for area/perimeter, 'open' for line) AND its unit. Shape
   * alone isn't enough: House ('perimeter', unit 'm') and Roof ('area',
   * unit 'm²') both trace a closed outline, but a perimeter measurement's
   * quantity is metres — assigning it to an m²-priced service would price
   * the wrong quantity, not just mislabel it.
   */
  function renderServiceOptions(selected, measurementType) {
    const wantShape = measurementType === 'line' ? 'open' : measurementType ? 'closed' : null;
    const wantUnit = measurementType === 'area' ? 'm²' : measurementType ? 'm' : null;
    return Object.entries(SERVICES)
      .filter(([, s]) => !wantShape || (s.shape === wantShape && s.unit === wantUnit))
      .map(([key, s]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${s.label}</option>`)
      .join('');
  }

  function paint() {
    const lines = computeLines();
    let model, pricingError='';
    try{model=priceModel();}catch(error){pricingError=error.message;model={total:0,exGst:0,gst:0,breakdown:null};}
    const {total,exGst=0,gst=0,breakdown:bd}=model;

    container.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-quote-modal">
          <div class="tk-modal-head">
            <div>
              <h3>Create Instant Quote</h3>
              <p class="tk-modal-sub">${escapeHtml(ctx.address) || 'No address set'}</p>
            </div>
            <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="tk-modal-body">
            <div class="tk-section-label">Measurements &amp; services</div>
            <div class="tk-lines" data-role="lines">
              ${lineState
                .map(
                  (l, i) => `
                <label class="tk-line-row">
                  <input type="checkbox" data-line="${i}" ${l.include ? 'checked' : ''}/>
                  <span class="tk-line-cat">${l.categoryLabel}</span>
                  <select class="tk-select" data-line-svc="${i}">${renderServiceOptions(l.svc, ctx.measurements[i].type)}</select>
                  <span class="tk-line-qty">${l.qty}${l.unit === 'm²' ? ' m²' : ' m'}</span>
                </label>`
                )
                .join('')}
              ${extraLines
                .map(
                  (l, i) => `
                <label class="tk-line-row">
                  <input type="checkbox" data-extra="${i}" ${l.include ? 'checked' : ''}/>
                  <select class="tk-select" data-extra-svc="${i}">${renderServiceOptions(l.svc, null)}</select>
                  <input type="number" min="0" step="1" class="tk-qty-input" data-extra-qty="${i}" value="${l.qty}"/>
                </label>`
                )
                .join('')}
            </div>
            <button type="button" class="tk-link-btn" data-add-extra">+ Add another service</button>

            <div class="tk-section-label">Customer</div>
            <div class="tk-customer-picker">
              ${
                customerLocked
                  ? `<div class="tk-customer-chip tk-customer-locked">${escapeHtml(selectedCustomer.name || 'Saved customer')}<span class="tk-modal-sub">Saved to this customer — opened from their TurnKey profile, so this draft goes straight back to them.</span></div>`
                  : selectedCustomer
                  ? `<div class="tk-customer-chip">${escapeHtml(selectedCustomer.name)} <button type="button" data-clear-customer>Change</button></div>`
                  : `
                <input type="text" class="tk-input" placeholder="Search TurnKey customers…" data-role="customer-search"/>
                <div class="tk-customer-results" data-role="customer-results"></div>
                <div class="tk-new-customer">
                  <input type="text" class="tk-input" placeholder="Name" data-new="name" value="${escapeHtml(newCustomer.name)}"/>
                  <input type="text" class="tk-input" placeholder="Phone" data-new="phone" value="${escapeHtml(newCustomer.phone)}"/>
                  <input type="text" class="tk-input" placeholder="Email" data-new="email" value="${escapeHtml(newCustomer.email)}"/>
                </div>`
              }
            </div>

            <div class="tk-price-block">
              <div class="tk-section-label">Internal delivery estimate</div>
              <p class="tk-modal-sub">Based on your business’s saved cost settings. Travel is an estimate, not a live route calculation.</p>
              ${bd ? [ ['Labour + setup ('+bd.labourHrs.toFixed(1)+' hours × '+ctx.TK_COST.COST_INPUTS.crew+' crew)',bd.wageCost],['Materials / chemicals',bd.chem],['Travel / fuel',bd.fuelCost],['Equipment',bd.equipmentCost],['Consumables',bd.consumablesCost],['Allocated overheads',bd.overheadCost],['Total estimated costs (ex GST)',bd.costUnrounded] ].map(([label,value])=>`<div class="tk-price-line"><span>${label}</span><strong>${money(value)}</strong></div>`).join('') : ''}
              <label class="tk-price-line">Round-trip travel estimate (km) <input class="tk-qty-input" aria-label="Round-trip travel estimate in km" data-travel type="number" min="0" step="0.1" value="${travelKm}"></label>
              <label class="tk-price-line">Target gross margin (%) <input class="tk-qty-input" aria-label="Target gross margin" data-margin type="number" min="0" max="99" step="1" value="${Math.round(localMargin*100)}"></label>
              <div class="tk-price-line"><span>Recommended customer price${ctx.TK_COST.COST_INPUTS.gstRegistered?' (incl GST)':''}</span><strong data-recommended>${money(bd?.recommended||0)}</strong></div>
              <label class="tk-price-line">Final customer price${ctx.TK_COST.COST_INPUTS.gstRegistered?' (incl GST)':''} <input class="tk-qty-input" style="width:120px" aria-label="Final customer price" data-price type="number" min="1" step="1" value="${total}"></label>
              <button type="button" class="tk-link-btn" data-use-recommended>Use recommended price</button>
              <div class="tk-price-line"><span>Expected gross profit</span><strong data-profit>${money(model.profit||0)}</strong></div>
              <div class="tk-price-line"><span>Expected gross margin</span><strong data-margin-result>${(model.marginPct||0).toFixed(1)}%</strong></div>
              ${bd&&model.marginPct+0.01<localMargin*100?'<p role="status" class="tk-error">This price is below your target gross margin.</p>':''}
              <div class="tk-price-line"><span>Subtotal${ctx.TK_COST.COST_INPUTS.gstRegistered?' (ex GST)':''}</span><span>${money(exGst)}</span></div>
              <div class="tk-price-line"><span>${ctx.TK_COST.COST_INPUTS.gstRegistered?'GST':'GST (not registered)'}</span><span>${money(gst)}</span></div>
              <div class="tk-price-total"><span>Final customer total</span><span>${money(total)}</span></div>
              ${pricingError?`<p class="tk-error" role="alert">${escapeHtml(pricingError)}</p>`:''}
              <p class="tk-modal-sub">Margin uses revenue excluding GST. These are estimated costs, not actual job expenses. Your internal costs stay off the customer quote.</p>
            </div>
          </div>
          <div class="tk-modal-foot">
            <button type="button" class="tk-btn" data-close>Cancel</button>
            <button type="button" class="tk-btn tk-btn-accent" data-create ${lines.length&&!pricingError ? '' : 'disabled'}>Create Quote</button>
          </div>
        </div>
      </div>`;

    container.querySelector('[data-price]').addEventListener('change',e=>{customPrice=e.target.value===''?NaN:Number(e.target.value);paint();});
    container.querySelector('[data-margin]').addEventListener('change',e=>{const value=Number(e.target.value)/100;if(Number.isFinite(value)&&value>=0&&value<1)localMargin=value;paint();});
    container.querySelector('[data-travel]').addEventListener('change',e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=0)travelKm=value;paint();});
    container.querySelector('[data-use-recommended]').addEventListener('click',()=>{customPrice=null;paint();});
    container.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => actions.onCancel()));
    container.querySelectorAll('[data-line]').forEach((cb) =>
      cb.addEventListener('change', () => {
        lineState[+cb.getAttribute('data-line')].include = cb.checked;
        paint();
      })
    );
    container.querySelectorAll('[data-line-svc]').forEach((sel) =>
      sel.addEventListener('change', () => {
        lineState[+sel.getAttribute('data-line-svc')].svc = sel.value;
        paint();
      })
    );
    container.querySelectorAll('[data-extra]').forEach((cb) =>
      cb.addEventListener('change', () => {
        extraLines[+cb.getAttribute('data-extra')].include = cb.checked;
        paint();
      })
    );
    container.querySelectorAll('[data-extra-svc]').forEach((sel) =>
      sel.addEventListener('change', () => {
        extraLines[+sel.getAttribute('data-extra-svc')].svc = sel.value;
        paint();
      })
    );
    container.querySelectorAll('[data-extra-qty]').forEach((inp) =>
      inp.addEventListener('change', () => {
        extraLines[+inp.getAttribute('data-extra-qty')].qty = parseFloat(inp.value) || 0;
        paint();
      })
    );
    const addExtraBtn = container.querySelector('[data-add-extra]');
    if (addExtraBtn)
      addExtraBtn.addEventListener('click', () => {
        extraLines.push({ include: true, svc: Object.keys(SERVICES)[0], qty: 1 });
        paint();
      });

    const searchInput = container.querySelector('[data-role="customer-search"]');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const results = await actions.onSearchCustomer(searchInput.value);
          const resultsEl = container.querySelector('[data-role="customer-results"]');
          if (!resultsEl) return;
          resultsEl.innerHTML = results
            .map((c) => `<button type="button" class="tk-customer-result" data-pick="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.address ? ' — ' + escapeHtml(c.address) : ''}</button>`)
            .join('');
          resultsEl.querySelectorAll('[data-pick]').forEach((b) =>
            b.addEventListener('click', () => {
              const id = b.getAttribute('data-pick');
              selectedCustomer = { id, name: results.find((r) => r.id === id).name };
              paint();
            })
          );
        }, 200);
      });
    }
    container.querySelectorAll('[data-new]').forEach((inp) =>
      inp.addEventListener('input', () => {
        newCustomer[inp.getAttribute('data-new')] = inp.value;
      })
    );
    const clearCustomerBtn = container.querySelector('[data-clear-customer]');
    if (clearCustomerBtn) clearCustomerBtn.addEventListener('click', () => { selectedCustomer = null; paint(); });

    container.querySelector('[data-create]').addEventListener('click', async () => {
      if (!selectedCustomer && !newCustomer.name.trim()) {
        container.querySelector('[data-new="name"]').focus();
        return;
      }
      const createBtn = container.querySelector('[data-create]');
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      const finalModel=priceModel();
      const finalLines=finalModel.lines, finalTotal=finalModel.total;
      try {
        await actions.onCreateQuote({
          customer: selectedCustomer || newCustomer,
          isNewCustomer: !selectedCustomer,
          address: ctx.address,
          lines: finalLines,
          total: finalTotal,
          areaPolys: ctx.measurements.filter(m=>lineState.some(l=>l.include&&l.measurementId===m.id)).map(m=>({...m,service:lineState.find(l=>l.measurementId===m.id).svc})),
          costSnapshot:finalModel.snapshot,
          estimatedCost:finalModel.breakdown.costUnrounded,
          estimatedMarginPct:finalModel.marginPct,
          gstRegistered:ctx.TK_COST.COST_INPUTS.gstRegistered,
          targetMargin:localMargin
        });
      } catch (err) {
        createBtn.disabled = false;
        createBtn.textContent = 'Create Quote';
        const foot = container.querySelector('.tk-modal-foot');
        const errEl = document.createElement('div');
        errEl.className = 'tk-error';
        errEl.textContent = err.message || 'Could not create the quote — check your connection and try again.';
        foot.prepend(errEl);
      }
    });
  }

  paint();
}

/** The post-creation "QUOTE CREATED" screen (build brief §12). */
export function renderQuoteCreated(container, { address, total, lines, SERVICES, openUrl, publicUrl, warning }, actions) {
  container.innerHTML = `
    <div class="tk-modal-backdrop">
      <div class="tk-modal tk-quote-created">
        <div class="tk-created-badge">✓</div>
        <h3>Quote Created</h3>
        ${warning ? `<p role="status" class="tk-modal-sub">${escapeHtml(warning)}</p>` : ''}
        <p class="tk-modal-sub">${escapeHtml(address)}</p>
        <div class="tk-created-total">${money(total)}</div>
        <div class="tk-created-lines">
          ${lines.map((l) => `<div class="tk-kv"><span>${SERVICES[l.svc] ? SERVICES[l.svc].label : l.svc}</span><span>${l.qty}${SERVICES[l.svc] && SERVICES[l.svc].unit === 'm²' ? ' m²' : ''}</span></div>`).join('')}
        </div>
        <div class="tk-modal-foot tk-created-foot">
          <button type="button" class="tk-btn" data-copy>Copy Quote Link</button>
          <button type="button" class="tk-btn tk-btn-accent" data-open>Open in TurnKey</button>
        </div>
        <div class="tk-created-transfer">
          <button type="button" class="tk-btn tk-btn-accent" data-servicem8>Send to ServiceM8</button>
          <button type="button" class="tk-btn" data-check-transfer hidden>Check transfer</button>
          <p class="tk-modal-sub" role="status" aria-live="polite" data-transfer-status></p>
          <p><a data-open-servicem8 target="_blank" rel="noopener" hidden>Open in ServiceM8</a></p>
        </div>
        <button type="button" class="tk-link-btn" data-done>Done</button>
      </div>
    </div>`;
  container.querySelector('[data-open]').addEventListener('click', () => window.open(openUrl, '_blank', 'noopener'));
  container.querySelector('[data-copy]').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(publicUrl);
    e.target.textContent = 'Copied!';
    setTimeout(() => (e.target.textContent = 'Copy Quote Link'), 1500);
  });
  const send=container.querySelector('[data-servicem8]'),check=container.querySelector('[data-check-transfer]'),status=container.querySelector('[data-transfer-status]'),link=container.querySelector('[data-open-servicem8]');
  send.addEventListener('click',async()=>{
    if(send.disabled)return;
    send.disabled=true;status.textContent='Queueing your saved quote…';
    try{
      const result=await actions.onSendServiceM8();
      if(!result||result.queued!==true)throw new Error('The transfer was not confirmed. Your TurnKey quote is still saved.');
      send.textContent='Queued for ServiceM8';check.hidden=false;
      status.textContent='Queued. You can leave this screen; TurnKey will process the transfer in the background.';
    }catch(error){status.textContent=(error.message||'Could not transfer.')+' Your TurnKey quote remains saved.';send.textContent='Retry ServiceM8 transfer';send.disabled=false;}
  });
  check.addEventListener('click',async()=>{
    if(check.disabled)return;
    check.disabled=true;
    try{
      const result=await actions.onCheckServiceM8();
      status.textContent=result.message||'Check TurnKey Connections for transfer progress.';
      if(result.state==='transferred'&&/^https:\/\/go\.servicem8\.com\/OpenJob\/[0-9a-f-]{36}$/i.test(result.openUrl||'')){
        link.href=result.openUrl;link.hidden=false;check.hidden=true;send.textContent='Transferred to ServiceM8';
      }
      if(result.state==='not_connected'||result.state==='not_queued'){send.disabled=false;send.textContent='Retry ServiceM8 transfer';}
    }catch(error){status.textContent=error.message||'Could not check transfer. Your quote is saved.';}
    finally{check.disabled=false;}
  });
  container.querySelector('[data-done]').addEventListener('click', () => actions.onDone());
}
