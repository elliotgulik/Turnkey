// Instant Quote panel (build brief §9-§12) — turns the measurements list
// into priced service lines using TurnKey's own shared pricing engine
// (vendor/pricing-engine.js, the exact same window.TK_PRICING loaded by
// index.html/booking.html/quote.html — not a second pricing implementation),
// then creates the quote in Supabase using the same table shape
// syncRecordToSupabase() writes in index.html.
function money(n) {
  return '$' + (Math.round(n * 100) / 100).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  const extraLines = []; // ad-hoc services not tied to a drawn measurement
  let selectedCustomer = null; // {id,name} | null = "new customer"
  let newCustomer = { name: '', phone: '', email: '' };

  function computeLines() {
    const included = lineState.filter((l) => l.include).map((l) => ({ svc: l.svc, qty: l.qty }));
    const extras = extraLines.filter((l) => l.include).map((l) => ({ svc: l.svc, qty: l.qty }));
    return included.concat(extras);
  }

  function renderServiceOptions(selected, shapeType) {
    const wantShape = shapeType === 'area' ? 'closed' : shapeType === 'line' ? 'open' : null;
    return Object.entries(SERVICES)
      .filter(([, s]) => !wantShape || s.shape === wantShape || s.shape === 'none')
      .map(([key, s]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${s.label}</option>`)
      .join('');
  }

  function paint() {
    const lines = computeLines();
    const total = ctx.TK_PRICING.quoteTotal(lines, {});
    const { exGst, gst } = ctx.TK_PRICING.gstFromInclusive(total);

    container.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-quote-modal">
          <div class="tk-modal-head">
            <div>
              <h3>Create Instant Quote</h3>
              <p class="tk-modal-sub">${ctx.address || 'No address set'}</p>
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
                selectedCustomer
                  ? `<div class="tk-customer-chip">${selectedCustomer.name} <button type="button" data-clear-customer>Change</button></div>`
                  : `
                <input type="text" class="tk-input" placeholder="Search TurnKey customers…" data-role="customer-search"/>
                <div class="tk-customer-results" data-role="customer-results"></div>
                <div class="tk-new-customer">
                  <input type="text" class="tk-input" placeholder="Name" data-new="name" value="${newCustomer.name}"/>
                  <input type="text" class="tk-input" placeholder="Phone" data-new="phone" value="${newCustomer.phone}"/>
                  <input type="text" class="tk-input" placeholder="Email" data-new="email" value="${newCustomer.email}"/>
                </div>`
              }
            </div>

            <div class="tk-price-block">
              <div class="tk-price-line"><span>Subtotal (ex GST)</span><span>${money(exGst)}</span></div>
              <div class="tk-price-line"><span>GST</span><span>${money(gst)}</span></div>
              <div class="tk-price-total"><span>Estimated Price</span><span>${money(total)}</span></div>
            </div>
          </div>
          <div class="tk-modal-foot">
            <button type="button" class="tk-btn" data-close>Cancel</button>
            <button type="button" class="tk-btn tk-btn-accent" data-create ${lines.length ? '' : 'disabled'}>Create Quote</button>
          </div>
        </div>
      </div>`;

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
            .map((c) => `<button type="button" class="tk-customer-result" data-pick="${c.id}">${c.name}${c.address ? ' — ' + c.address : ''}</button>`)
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
      const finalLines = computeLines();
      const finalTotal = ctx.TK_PRICING.quoteTotal(finalLines, {});
      try {
        await actions.onCreateQuote({
          customer: selectedCustomer || newCustomer,
          isNewCustomer: !selectedCustomer,
          address: ctx.address,
          lines: finalLines,
          total: finalTotal,
          areaPolys: ctx.measurements
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
export function renderQuoteCreated(container, { address, total, lines, SERVICES, openUrl, publicUrl }, actions) {
  container.innerHTML = `
    <div class="tk-modal-backdrop">
      <div class="tk-modal tk-quote-created">
        <div class="tk-created-badge">✓</div>
        <h3>Quote Created</h3>
        <p class="tk-modal-sub">${address || ''}</p>
        <div class="tk-created-total">${money(total)}</div>
        <div class="tk-created-lines">
          ${lines.map((l) => `<div class="tk-kv"><span>${SERVICES[l.svc] ? SERVICES[l.svc].label : l.svc}</span><span>${l.qty}${SERVICES[l.svc] && SERVICES[l.svc].unit === 'm²' ? ' m²' : ''}</span></div>`).join('')}
        </div>
        <div class="tk-modal-foot tk-created-foot">
          <button type="button" class="tk-btn" data-copy>Copy Quote Link</button>
          <button type="button" class="tk-btn tk-btn-accent" data-open>Open in TurnKey</button>
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
  container.querySelector('[data-done]').addEventListener('click', () => actions.onDone());
}
