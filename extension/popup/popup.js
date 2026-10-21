import { Storage } from '../api/storage.js';
import { TurnKeyApi } from '../api/client-bridge.js';
import { TURNKEY_SUPABASE_ORIGIN } from '../api/turnkey-api.js';

const app = document.getElementById('app');
let view = 'loading';
let error = '';
let busy = false;
let data = { config: null, session: null, profile: null, business: null, settings: null };

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

async function boot() {
  data = await Storage.loadAll();
  view = data.session && data.config ? 'connected' : 'connect';
  render();
}

function originPattern(url) {
  try { return new URL(url).origin + '/*'; } catch { return null; }
}

function render() {
  if (view === 'loading') {
    app.innerHTML = `<div class="tk-popup-logo">TURNKEY</div>`;
    return;
  }
  if (view === 'connect') return renderConnect();
  if (view === 'connected') return renderConnected();
}

function renderConnect() {
  app.innerHTML = `
    <div class="tk-popup-logo">TURNKEY</div>
    <p class="tk-hint">Open TurnKey in this window and sign in. The extension will securely connect to that account; no URL or password is needed.</p>
    ${error ? `<div class="tk-error" role="alert">${escapeHtml(error)}</div>` : ''}
    <button class="tk-btn tk-btn-accent" id="connect" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Connect to signed-in TurnKey'}</button>
  `;
  document.getElementById('connect').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    error = '';
    // Request the one production database origin directly in the click
    // gesture. Access to other sites and database projects is not requested.
    const permissionPromise = chrome.permissions.request({ origins: [TURNKEY_SUPABASE_ORIGIN + '/*'] });
    render();
    try {
      if (!await permissionPromise) throw new Error('Allow the TurnKey database connection in Chrome, then try again.');
      await TurnKeyApi.connectFromActiveCRM();
      data = await Storage.loadAll();
      view = 'connected';
    } catch (e) {
      error = e && e.message ? e.message : 'Could not connect to TurnKey. Refresh the signed-in tab and retry.';
    }
    busy = false;
    render();
  });
}

function renderConnected() {
  const bizName = escapeHtml((data.business && data.business.name) || 'Your business');
  const backendPermission = data.config && data.config.backendUrl ? originPattern(data.config.backendUrl) : null;
  app.innerHTML = `
    <div class="tk-popup-logo">TURNKEY</div>
    <div class="tk-connected-card">
      <div class="tk-connected-label">Connected</div>
      <div class="tk-connected-name">${bizName}</div>
    </div>
    <div class="tk-row"><span>Google Earth</span><span class="tk-row-ok">✓ Extension enabled</span></div>
    <div class="tk-row"><span>Pricing</span><span class="tk-row-ok">✓ Connected to TurnKey</span></div>
    <div class="tk-field" style="margin-top:10px">
      <label>Default measurement unit</label>
      <select id="unit">
        <option value="m2" ${data.settings.defaultUnit === 'm2' ? 'selected' : ''}>m²</option>
        <option value="ft2" ${data.settings.defaultUnit === 'ft2' ? 'selected' : ''}>ft²</option>
      </select>
    </div>
    <div class="tk-divider"></div>
    <button class="tk-btn tk-btn-accent" id="open">Open TurnKey</button>
    ${backendPermission ? '<button class="tk-btn" id="enable-transfers">Enable ServiceM8 transfers</button><p class="tk-hint" id="transfer-permission-status" role="status"></p>' : ''}
    <button class="tk-btn" id="refresh-account" ${busy ? 'disabled' : ''}>${busy ? 'Refreshing…' : 'Refresh from open TurnKey tab'}</button>
    ${error ? `<div class="tk-error" role="alert">${escapeHtml(error)}</div>` : ''}
    <button class="tk-btn tk-btn-danger" id="disconnect">Disconnect</button>
  `;
  document.getElementById('unit').addEventListener('change', async (e) => {
    data.settings = { ...data.settings, defaultUnit: e.target.value };
    await Storage.setSettings(data.settings);
  });
  document.getElementById('open').addEventListener('click', async () => {
    try { await TurnKeyApi.openTurnKey(); } catch(e) { error=e.message; render(); }
  });
  document.getElementById('enable-transfers')?.addEventListener('click', async () => {
    const status = document.getElementById('transfer-permission-status');
    try {
      const pattern = originPattern(data.config.backendUrl);
      if (!pattern) throw new Error('The TurnKey backend address is invalid.');
      const granted = await chrome.permissions.request({ origins: [pattern] });
      status.textContent = granted ? 'Backend connection enabled. Use Send to ServiceM8 after creating a quote.' : 'Permission was not granted; your TurnKey quotes remain saved.';
    } catch {
      status.textContent = 'Could not enable the backend connection. Try again.';
    }
  });
  document.getElementById('refresh-account').addEventListener('click', async () => {
    busy = true;
    error = '';
    render();
    try {
      await TurnKeyApi.connectFromActiveCRM();
      data = await Storage.loadAll();
    } catch (e) {
      error = e && e.message ? e.message : 'Could not refresh the TurnKey account.';
    }
    busy = false;
    render();
  });
  document.getElementById('disconnect').addEventListener('click', async () => {
    await Storage.disconnect();
    data = await Storage.loadAll();
    view = 'connect';
    error = '';
    render();
  });
}

boot();
