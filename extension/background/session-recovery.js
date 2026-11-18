import { TurnKeyClient, TURNKEY_CRM_ORIGINS } from '../api/turnkey-api.js';

// A previously connected account can silently recover from its own open CRM
// tab. Never select a different signed-in operator or trust page-supplied IDs.
export async function recoverFromCRM(browser, config, previous) {
  if (!previous?.userId) return null;
  const origin = new URL(config.siteUrl).origin;
  if (!TURNKEY_CRM_ORIGINS.has(origin)) return null;
  const project = new URL(config.supabaseUrl).hostname.split('.')[0];
  const tabs = await browser.tabs.query({ url: origin + '/*' });
  for (const tab of tabs) {
    try {
      if (new URL(tab.url).origin !== origin) continue;
      const result = await browser.tabs.sendMessage(tab.id, {
        type: 'TK_READ_CRM_AUTH_SESSION', storageKey: 'sb-' + project + '-auth-token'
      });
      if (!result?.ok || !result.session) continue;
      // Avoid rotating an expired foreign token just to identify its owner.
      const verify = await fetch(config.supabaseUrl + '/auth/v1/user', {
        headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + result.session.access_token }
      });
      if (!verify.ok || (await verify.json()).id !== previous.userId) continue;
      const candidate = new TurnKeyClient(config, null);
      await candidate.adoptSession(result.session);
      if (candidate.session.userId === previous.userId) return candidate.session;
    } catch { /* Another tab may still hold this account's current session. */ }
  }
  return null;
}
