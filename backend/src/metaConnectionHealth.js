import { fetchMetaObject, fetchMetaEdge } from './metaGraph.js';

// Do not return Meta's raw error messages: providers can echo credentials or
// request details. Codes are enough to give a safe, actionable recovery step.
export function metaConnectionIssue(error) {
  const code = Number(error?.code);
  if (code === 190) return { health: 'reconnect', message: 'Meta access has expired or was revoked. Reconnect with a current Page Access Token.' };
  if (code === 10 || code === 200) return { health: 'permissions', message: 'Meta denied access. Authorize this Page with leads_retrieval and pages_manage_metadata, and allow TurnKey in Meta Leads Access settings.' };
  return { health: 'error', message: 'Meta could not verify this connection. Check the Page ID, Page token and app permissions, then retry.' };
}
export async function checkMetaConnection({ pageId, token, repair = false, appId, fetchPage = fetchMetaObject, fetchEdge = fetchMetaEdge }) {
  const response = await fetchPage(pageId, { token, fields: 'id,name' });
  const page = await response.json();
  if (!response.ok || String(page.id) !== pageId) return metaConnectionIssue(page.error);
  const edgeResponse = await fetchEdge(pageId, 'subscribed_apps', { token, method: repair ? 'POST' : 'GET', ...(repair ? { body: { subscribed_fields: 'leadgen' } } : { fields: 'id,subscribed_fields' }) });
  const subscriptions = await edgeResponse.json();
  if (!edgeResponse.ok) return { ...metaConnectionIssue(subscriptions.error), pageName: page.name || null, tokenValid: true };
  // A successful POST subscribes the token's own app. With GET, only claim
  // success for a configured app ID; an unrelated installed app is not proof.
  const subscribed = repair ? subscriptions.success === true : appId ? Array.isArray(subscriptions.data) && subscriptions.data.some(app => String(app.id) === String(appId) && app.subscribed_fields?.includes('leadgen')) : null;
  return {
    pageName: page.name || null, tokenValid: true, subscribed,
    health: subscribed ? 'ready' : subscribed === false ? 'subscription_missing' : 'subscription_unverified',
    message: subscribed ? 'Page token verified and lead notifications enabled. Use Meta’s Lead Ads Testing Tool to verify a form reaches TurnKey.' : subscribed === false ? 'This app is not subscribed to Page lead notifications. Click Enable lead delivery.' : 'Page token verified. Click Enable lead delivery to confirm the token’s app is subscribed.',
  };
}
