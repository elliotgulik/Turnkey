// The floating TurnKey toolbar overlaid on Google Earth (build brief §4).
// Mounted once; `update()` patches the dynamic bits in place afterwards so
// drag position, scroll, and any open sub-panel survive a state change.
export function mountToolbar(root, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'tk-toolbar';
  wrap.innerHTML = `
    <div class="tk-toolbar-head" data-drag-handle>
      <span class="tk-logo">TURNKEY</span>
      <div class="tk-head-actions">
        <button type="button" class="tk-icon-btn" data-action="minimize" title="Minimize" aria-label="Minimize">−</button>
      </div>
    </div>
    <div class="tk-toolbar-body">
      <div class="tk-status" data-role="status"></div>
      <div class="tk-actions">
        <button type="button" class="tk-btn" data-action="measure-area">
          <span class="tk-btn-ico">▣</span> Area
        </button>
        <button type="button" class="tk-btn" data-action="measure-distance">
          <span class="tk-btn-ico">📏</span> Distance
        </button>
        <button type="button" class="tk-btn" data-action="screenshot">
          <span class="tk-btn-ico">📸</span> Screenshot
        </button>
        <button type="button" class="tk-btn tk-btn-accent" data-action="instant-quote">
          <span class="tk-btn-ico">💰</span> Instant Quote
        </button>
      </div>
      <div class="tk-divider"></div>
      <div class="tk-property">
        <label>Property</label>
        <input type="text" class="tk-input" data-role="address" placeholder="42 Example Street, Auckland" />
      </div>
      <div class="tk-measurements" data-role="measurements"></div>
    </div>`;
  const minimized = document.createElement('button');
  minimized.type = 'button';
  minimized.className = 'tk-minimized-fab';
  minimized.title = 'Open TurnKey';
  minimized.innerHTML = '<span>TK</span>';
  minimized.hidden = true;

  root.appendChild(wrap);
  root.appendChild(minimized);

  // ── Drag (header only) ──────────────────────────────────────────────────
  let pos = { top: 96, right: 20 };
  wrap.style.top = pos.top + 'px';
  wrap.style.right = pos.right + 'px';
  const handle = wrap.querySelector('[data-drag-handle]');
  let dragging = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-action]')) return;
    dragging = { startX: e.clientX, startY: e.clientY, top: pos.top, right: pos.right };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    pos = { top: Math.max(8, dragging.top + dy), right: Math.max(8, dragging.right - dx) };
    wrap.style.top = pos.top + 'px';
    wrap.style.right = pos.right + 'px';
  });
  handle.addEventListener('pointerup', () => { dragging = null; });

  // ── Minimize / restore ──────────────────────────────────────────────────
  wrap.querySelector('[data-action="minimize"]').addEventListener('click', () => {
    wrap.hidden = true;
    minimized.hidden = false;
  });
  minimized.addEventListener('click', () => {
    wrap.hidden = false;
    minimized.hidden = true;
  });

  // ── Action buttons — delegated to the host app ──────────────────────────
  wrap.querySelector('.tk-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    actions.onAction(btn.getAttribute('data-action'));
  });

  const addressInput = wrap.querySelector('[data-role="address"]');
  addressInput.addEventListener('change', () => actions.onAddressChange(addressInput.value));

  function renderMeasurements(list) {
    const el = wrap.querySelector('[data-role="measurements"]');
    if (!list || !list.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = list
      .map(
        (m) =>
          `<div class="tk-meas-row" data-id="${m.id}">
            <span class="tk-meas-label">${m.categoryLabel}</span>
            <span class="tk-meas-value">${m.size}${m.unit === 'm²' ? ' m²' : ' m'}</span>
            <button type="button" class="tk-meas-remove" data-remove="${m.id}" aria-label="Remove">×</button>
          </div>`
      )
      .join('');
    el.querySelectorAll('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => actions.onRemoveMeasurement(b.getAttribute('data-remove')))
    );
  }

  function renderStatus(state) {
    const el = wrap.querySelector('[data-role="status"]');
    // Scoped to just the four measure/screenshot/quote buttons — the
    // header's minimize control shares the same [data-action] delegation
    // pattern but must stay usable even while disconnected.
    const actionButtons = wrap.querySelectorAll('.tk-actions [data-action]');
    if (!state.session) {
      el.innerHTML = `<span class="tk-status-dot off"></span> Not connected — open the TurnKey extension icon to sign in`;
      actionButtons.forEach((b) => (b.disabled = true));
    } else {
      const biz = state.business ? state.business.name || 'Your business' : 'Connected';
      el.innerHTML = `<span class="tk-status-dot on"></span> ${biz}`;
      actionButtons.forEach((b) => (b.disabled = false));
    }
  }

  return {
    el: wrap,
    update(state) {
      renderStatus(state);
      addressInput.value = state.address || '';
      renderMeasurements(state.measurements);
    }
  };
}
