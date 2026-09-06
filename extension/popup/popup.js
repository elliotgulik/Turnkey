import { Storage } from '../api/storage.js';
import { fetchSiteConfig, TurnKeyClient } from '../api/turnkey-api.js';

const app = document.getElementById('app');
let view = 'loading';
let error = '';
let busy = false;
let data = { config: null, session: null, profile: null, business: null, settings: null };

async function boot() {
  data = await Storage.loadAll();
  view = !data.config ? 'site-url' : !data.session ? 'sign-in' : 'connected';
  render();
}

function originOf(url) {
  try {
    return new URL(url).origin + '/*';
  } catch {
    return null;
  }
}

async function requestOrigins(urls) {
  const origins = urls.map(originOf).filter(Boolean);
  const granted = await chrome.permissions.request({ origins });
  return granted;
}

function render() {
  if (view === 'loading') {
    app.innerHTML = `<div class="tk-popup-logo">TURNKEY</div>`;
    return;
  }
  if (view === 'site-url') return renderSiteUrl();
  if (view === 'sign-in') return renderSignIn();
  if (view === 'connected') return renderConnected();
}

function renderSiteUrl() {
  app.innerHTML = `
    <div class="tk-popup-logo">TURNKEY</div>
    <p class="tk-hint">Connect this extension to your TurnKey CRM. Enter the web address of your TurnKey site (the same one you log into every day).</p>
    <div class="tk-field">
      <label>TurnKey site URL</label>
      <input type="text" id="site-url" placeholder="https://yourbusiness.netlify.app" />
    </div>
    ${error ? `<div class="tk-error">${error}</div>` : ''}
    <button class="tk-btn tk-btn-accent" id="continue" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Continue'}</button>
  `;
  document.getElementById('continue').addEventListener('click', async () => {
    const url = document.getElementById('site-url').value.trim();
    if (!url) return;
    const siteOrigin = originOf(url);
    if (!siteOrigin) {
      error = 'That doesn\'t look like a valid URL.';
      render();
      return;
    }
    // Requested as the very first thing in this click handler, before any
    // network calls — Chrome only honors chrome.permissions.request while
    // the click's "transient user activation" is still live, which a slow
    // fetch could otherwise burn through. Supabase's own domain is
    // requested up front too (rather than after learning the project's
    // exact URL from config.js, a second gesture-gated request later)
    // since virtually every TurnKey deployment's database lives on
    // *.supabase.co; a self-hosted Supabase instance outside that pattern
    // is the one case this won't cover.
    let granted;
    try {
      granted = await chrome.permissions.request({ origins: [siteOrigin, 'https://*.supabase.co/*'] });
    } catch (e) {
      error = e.message;
      render();
      return;
    }
    if (!granted) {
      error = 'TurnKey needs permission to talk to your site and its Supabase project to connect.';
      render();
      return;
    }
    busy = true;
    error = '';
    render();
    try {
      const cfg = await fetchSiteConfig(url);
      if (!cfg.supabaseUrl.includes('supabase.co')) {
        await requestOrigins([cfg.supabaseUrl]);
      }
      await Storage.setConfig(cfg);
      data.config = cfg;
      view = 'sign-in';
    } catch (e) {
      error = e.message;
    }
    busy = false;
    render();
  });
}

function renderSignIn() {
  app.innerHTML = `
    <div class="tk-popup-logo">TURNKEY</div>
    <button class="tk-back-link" id="back">← Change site</button>
    <p class="tk-hint">Sign in with the same email and password you use for the TurnKey CRM.</p>
    <div class="tk-field"><label>Email</label><input type="email" id="email" /></div>
    <div class="tk-field"><label>Password</label><input type="password" id="password" /></div>
    ${error ? `<div class="tk-error">${error}</div>` : ''}
    <button class="tk-btn tk-btn-accent" id="signin" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Sign in with TurnKey'}</button>
  `;
  document.getElementById('back').addEventListener('click', async () => {
    await Storage.setConfig(null).catch(() => {});
    data.config = null;
    view = 'site-url';
    error = '';
    render();
  });
  const submit = async () => {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    if (!email || !password) return;
    busy = true;
    error = '';
    render();
    try {
      const client = new TurnKeyClient(data.config, null, (s) => Storage.setSession(s));
      const session = await client.signIn(email, password);
      const profile = await client.getProfile();
      const business = await client.getBusiness(profile.business_id);
      await Storage.setSession(session);
      await Storage.setProfile(profile);
      await Storage.setBusiness(business);
      data = { ...data, session, profile, business };
      view = 'connected';
    } catch (e) {
      error = e.message;
    }
    busy = false;
    render();
  };
  document.getElementById('signin').addEventListener('click', submit);
  document.getElementById('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

function renderConnected() {
  const bizName = (data.business && data.business.name) || 'Your business';
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
    <button class="tk-btn tk-btn-danger" id="disconnect">Disconnect</button>
  `;
  document.getElementById('unit').addEventListener('change', async (e) => {
    data.settings = { ...data.settings, defaultUnit: e.target.value };
    await Storage.setSettings(data.settings);
  });
  document.getElementById('open').addEventListener('click', () => {
    chrome.tabs.create({ url: data.config.siteUrl + '/index.html' });
  });
  document.getElementById('disconnect').addEventListener('click', async () => {
    await Storage.disconnect();
    data.session = null;
    data.profile = null;
    data.business = null;
    view = 'sign-in';
    render();
  });
}

boot();
