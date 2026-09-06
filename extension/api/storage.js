// Thin chrome.storage.local wrapper, shared by the popup (settings + sign-in)
// and the in-page panel (content/panel/*) so both read/write the exact same
// keys. Content scripts have direct access to chrome.storage (granted by the
// "storage" permission in manifest.json) so no background-page proxying is
// needed here.
const KEYS = {
  config: 'tk_config', // {siteUrl, backendUrl, supabaseUrl, supabaseAnonKey, mapsKey}
  session: 'tk_session', // {accessToken, refreshToken, userId, expiresAt}
  profile: 'tk_profile', // {business_id, role, name, email}
  business: 'tk_business', // full businesses row (name, branding, pricing_config, ...)
  settings: 'tk_settings' // {defaultUnit}
};

async function get(key) {
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
async function remove(keys) {
  await chrome.storage.local.remove(keys);
}

export const Storage = {
  getConfig: () => get(KEYS.config),
  setConfig: (v) => set(KEYS.config, v),
  getSession: () => get(KEYS.session),
  setSession: (v) => set(KEYS.session, v),
  getProfile: () => get(KEYS.profile),
  setProfile: (v) => set(KEYS.profile, v),
  getBusiness: () => get(KEYS.business),
  setBusiness: (v) => set(KEYS.business, v),
  getSettings: async () => (await get(KEYS.settings)) || { defaultUnit: 'm2' },
  setSettings: (v) => set(KEYS.settings, v),
  disconnect: () => remove([KEYS.session, KEYS.profile, KEYS.business]),
  /** Loads everything the panel/popup need in one call. */
  async loadAll() {
    const [config, session, profile, business, settings] = await Promise.all([
      get(KEYS.config), get(KEYS.session), get(KEYS.profile), get(KEYS.business), this.getSettings()
    ]);
    return { config, session, profile, business, settings };
  }
};
