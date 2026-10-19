/* Load after the host's settings wrappers, then call
 * TK_SETTINGS_EXPERIENCE.install(). Loading this file alone is inert.
 * Existing groups, forms, credentials and handlers are moved, never cloned. */
(function (root) {
  'use strict';
  if (root.TK_SETTINGS_EXPERIENCE) return;
  const states = new WeakMap();
  const bound = new WeakSet();
  const categories = [
    { id: 'business', label: 'Business & team', description: 'Your business details, branding and people.', groups: ['Business', 'Branding', 'Team'] },
    { id: 'sales', label: 'Sales & quotes', description: 'Rates, pipeline, templates and online enquiries.', groups: ['Pricing', 'Pipeline', 'Templates', 'Quote embeds'] },
    { id: 'operations', label: 'Daily operations', description: 'Job requirements and the alerts you receive.', groups: ['Workflows', 'Notifications'] },
    { id: 'connections', label: 'Connections & billing', description: 'Email, calendars, integrations and payments.', groups: ['Email', 'Calendar', 'Integrations', 'Billing'] },
    { id: 'data', label: 'Data & support', description: 'Imports, backups, permissions and help.', groups: ['Imports', 'Advanced', 'Support'] },
    { id: 'other', label: 'More settings', description: 'Additional settings available for your business.', groups: [] },
  ];
  const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const make = (tag, className) => { const el = root.document.createElement(tag); el.className = className; return el; };

  function enhance(body = root.document.getElementById('settings-body'), groupLabel) {
    if (!body) return false;
    let state = states.get(body);
    if (state && !body.contains(state.layout)) state = null; // Host rebuilt its settings.
    if (!state) {
      const groups = [...body.querySelectorAll('.settings-group')];
      if (!groups.length) return false;
      const searchBox = body.querySelector('.settings-search');
      const search = body.querySelector('#settings-search-input, #settings-query, input[type="search"]');
      if (!search || !searchBox) return false;
      const entries = groups.map((el, i) => {
        const label = el.querySelector('summary')?.textContent.trim() || 'More settings';
        const category = categories.find(c => c.groups.includes(label)) || categories[categories.length - 1];
        if (!el.id) el.id = 'tk-settings-section-' + i;
        return { el, label, category, summary: el.querySelector('summary') };
      });
      const available = categories.filter(c => entries.some(e => e.category === c));
      const intro = make('div', 'sx-intro');
      intro.innerHTML = '<p class="sx-eyebrow">Business settings</p><h3>Make TurnKey work for you</h3><p>All settings are listed below. Open a section or use search; each section keeps its own save button.</p>';
      const layout = make('div', 'sx-layout');
      const nav = make('nav', 'sx-nav'); nav.setAttribute('aria-label', 'Settings categories');
      const content = make('div', 'sx-content');
      const heading = make('div', 'sx-heading');
      const overview = make('div', 'sx-overview');
      const empty = make('div', 'sx-empty'); empty.hidden = true;
      empty.innerHTML = '<h4>No settings found</h4><p>Try a different word, such as pricing, email or team.</p><button type="button" data-sx-category="overview">Clear search</button>';
      const status = make('p', 'sx-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const sectionHost = make('div', 'sx-sections');
      const accountActions = make('div', 'sx-account-actions');
      // Move every existing node, including wrapper additions and account actions.
      [...body.childNodes].filter(n => n !== searchBox).forEach(n => {
        (groups.includes(n) ? sectionHost : accountActions).append(n);
      });
      content.append(heading, overview, empty, sectionHost, accountActions); layout.append(nav, content);
      body.prepend(intro); body.append(status, layout);
      body.classList.add('tk-settings-experience');
      body.closest('.modal')?.classList.add('tk-settings-modal');
      search.setAttribute('aria-describedby', 'sx-search-help');
      status.id = 'sx-search-help';
      search.placeholder = 'Search all settings…';
      state = { body, search, entries, available, layout, heading, overview, empty, status, nav, category: 'overview', query: '', savedOpen: null };
      states.set(body, state);
      renderIndex(state);
      if (!bound.has(body)) {
        bound.add(body);
        // Capture the pre-search disclosure state before the host's inline
        // filter opens matches; the bubbling listener applies category/search UI.
        body.addEventListener('input', event => {
          const current = states.get(body);
          if (event.target === current?.search && current.search.value.trim() && !current.savedOpen) {
            current.savedOpen = new Map(current.entries.map(e => [e.el, e.el.open]));
          }
        }, true);
        body.addEventListener('input', event => {
          const current = states.get(body);
          if (event.target === current?.search) apply(current);
        });
        body.addEventListener('keydown', event => {
          const current = states.get(body);
          if (event.target === current?.search && event.key === 'Escape' && current.search.value) {
            event.preventDefault(); event.stopPropagation(); current.search.value = ''; apply(current);
          }
        });
        body.addEventListener('click', event => {
          const current = states.get(body), button = event.target.closest('[data-sx-category], [data-sx-group]');
          if (!current || !button || !body.contains(button)) return;
          if (button.dataset.sxGroup) { expose(current, button.dataset.sxGroup); return; }
          current.category = button.dataset.sxCategory;
          current.search.value = ''; apply(current);
          // Category buttons remain mounted, so keyboard focus stays on the control.
          if (!current.nav.contains(button)) current.nav.querySelector(`[data-sx-category="${current.category}"]`)?.focus();
        });
      }
    }
    // Wrappers may append sections after the host has already enhanced its
    // settings. Register those additions rather than hiding them outside the index.
    let added = false;
    for (const el of body.querySelectorAll('.settings-group')) {
      if (state.entries.some(entry => entry.el === el)) continue;
      const label = el.querySelector('summary')?.textContent.trim() || 'More settings';
      const category = categories.find(c => c.groups.includes(label)) || categories[categories.length - 1];
      state.entries.push({el,label,category,summary:el.querySelector('summary')});
      body.querySelector('.sx-sections').append(el); added = true;
    }
    if (added) { state.available = categories.filter(c => state.entries.some(e => e.category === c)); renderIndex(state); }
    apply(state);
    if (groupLabel) expose(state, groupLabel);
    return true;
  }

  function renderIndex(state) {
    state.nav.innerHTML = [{ id: 'overview', label: 'All settings' }, ...state.available].map(c => `<button type="button" data-sx-category="${c.id}"><span>${esc(c.label)}</span>${c.id === 'overview' ? '' : `<span class="sx-count">${state.entries.filter(e => e.category.id === c.id).length}</span>`}</button>`).join('');
    const quick = ['Business', 'Quote embeds', 'Integrations', 'Pricing', 'Pipeline', 'Team'].filter(label => state.entries.some(e => e.label === label));
    state.overview.innerHTML = `<p class="sx-eyebrow">Quick access</p><div class="sx-quick">${quick.map(label => `<button type="button" data-sx-group="${esc(label)}">${esc(label === 'Quote embeds' ? 'Website HTML embeds' : label === 'Integrations' ? 'All connections' : label)}</button>`).join('')}</div><h4>Browse settings</h4><div class="sx-cards">${state.available.map(c => `<button type="button" data-sx-category="${c.id}"><strong>${esc(c.label)}</strong><span>${esc(c.description)}</span><small>${state.entries.filter(e => e.category.id === c.id).map(e => esc(e.label)).join(' · ')}</small></button>`).join('')}</div>`;
  }

  function apply(state) {
    const q = state.search.value.trim().toLowerCase();
    if (q && !state.savedOpen) state.savedOpen = new Map(state.entries.map(e => [e.el, e.el.open]));
    if (!q && state.savedOpen) { state.entries.forEach(e => { e.el.open = state.savedOpen.get(e.el); }); state.savedOpen = null; }
    state.query = q;
    let matches = 0;
    state.entries.forEach(entry => {
      // Search labels and guidance, never index credential/input values.
      const hints = [...entry.el.querySelectorAll('[placeholder]')].map(el => el.getAttribute('placeholder')).join(' ');
      const match = q ? (entry.label + ' ' + entry.el.textContent + ' ' + hints).toLowerCase().includes(q) : state.category === 'overview' || entry.category.id === state.category;
      entry.el.hidden = !match;
      if (q && match) entry.el.open = true;
      if (match) matches++;
    });
    const category = state.available.find(c => c.id === state.category);
    state.heading.innerHTML = `<h3>${esc(q ? 'Search all settings' : category?.label || 'All settings')}</h3><p>${esc(q ? 'Results include every category.' : category?.description || 'Every section is available below, including website embeds and all connections.')}</p>`;
    state.overview.hidden = !!q || state.category !== 'overview';
    state.empty.hidden = !q || matches !== 0;
    state.status.textContent = q ? `${matches} matching section${matches === 1 ? '' : 's'} across all settings` : `${state.entries.length} sections available · Your changes stay in place as you browse`;
    state.nav.querySelectorAll('[data-sx-category]').forEach(button => button.setAttribute('aria-current', !q && button.dataset.sxCategory === state.category ? 'page' : 'false'));
  }

  function expose(state, label) {
    const entry = state.entries.find(e => e.label.toLowerCase() === String(label).toLowerCase());
    if (!entry) return false;
    state.category = entry.category.id; state.search.value = ''; apply(state);
    entry.el.open = true; entry.summary?.focus(); entry.el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function install() {
    const previous = root.openSettings;
    if (typeof previous !== 'function') return false;
    if (previous.tkSettingsExperience) return true;
    function wrapped(...args) {
      const result = previous.apply(this, args);
      if (result && typeof result.then === 'function') return result.then(value => { enhance(); return value; });
      enhance(); return result;
    }
    wrapped.tkSettingsExperience = true;
    root.openSettings = wrapped;
    return true;
  }
  root.TK_SETTINGS_EXPERIENCE = {
    install, enhance,
    showGroup(label) { const body = root.document.getElementById('settings-body'); return !!body && enhance(body) && expose(states.get(body), label); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
