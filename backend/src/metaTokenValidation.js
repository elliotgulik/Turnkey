import { DEFAULT_META_GRAPH_VERSION } from './metaGraph.js';

// Lead capture needs these scopes. ads_read is deliberately optional so a
// reporting permission problem can never prevent lead delivery/import.
const REQUIRED_LEAD_SCOPES = ['leads_retrieval', 'pages_manage_metadata'];

async function graphJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  return { response, body };
}

/** Inspect a Facebook user or system-user access token without exposing Meta's
 * raw error text. Page access is checked separately against the requested Page. */
export async function inspectMetaAccessToken({ token, appId, appSecret, fetchImpl = fetch, env = process.env }) {
  if (!appId || !appSecret) {
    throw Object.assign(new Error('Meta app verification is not configured.'), {
      status: 503,
      publicMessage: 'The backend needs META_APP_ID and META_APP_SECRET before it can verify a Meta token.',
    });
  }
  const version = env.META_GRAPH_VERSION || DEFAULT_META_GRAPH_VERSION;
  if (!/^v[1-9]\d*\.0$/.test(version)) throw new Error('Invalid Meta Graph API version');
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);
  let result;
  try { result = await graphJson(url, fetchImpl); }
  catch {
    throw Object.assign(new Error('Meta token verification failed.'), {
      status: 502,
      publicMessage: 'TurnKey could not verify this token with Meta. Retry the connection check.',
    });
  }
  const { response, body } = result, data = body?.data;
  if (!response.ok || body?.error || !data?.is_valid) {
    throw Object.assign(new Error('Meta rejected the supplied access token.'), {
      status: 400,
      publicMessage: 'Meta rejected this token. Generate a user access token for the TurnKey CRM app, then try again.',
    });
  }
  if (String(data.app_id) !== String(appId)) {
    throw Object.assign(new Error('Meta token belongs to a different app.'), {
      status: 400,
      publicMessage: 'This token was created for a different Meta app. In Graph API Explorer, select TurnKey CRM before generating the token.',
    });
  }
  const type = String(data.type || '').toUpperCase();
  if (!['USER', 'SYSTEM_USER'].includes(type)) {
    throw Object.assign(new Error('Unsupported Meta token type.'), {
      status: 400,
      publicMessage: 'Use a Facebook user access token or a System User token generated for TurnKey CRM.',
    });
  }
  const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes.map(x => x?.scope) : [];
  const scopes = new Set([...(Array.isArray(data.scopes) ? data.scopes : []), ...granular].filter(Boolean));
  const missing = REQUIRED_LEAD_SCOPES.filter(scope => !scopes.has(scope));
  if (missing.length) {
    throw Object.assign(new Error('Meta token lacks required lead permissions.'), {
      status: 403,
      publicMessage: `This token is missing ${missing.join(' and ')}. Grant these permissions to TurnKey CRM when generating the token. ads_read is optional and only needed for ad reporting.`,
    });
  }
  return {
    appId: String(data.app_id), type,
    expiresAt: Number(data.expires_at) || 0,
    dataAccessExpiresAt: Number(data.data_access_expiration_time || data.data_access_expires_at) || 0,
    scopes: [...scopes],
  };
}

/** Meta permits exchanging short-lived user tokens for longer-lived tokens.
 * This is best-effort: callers retain an otherwise valid user token if Meta
 * says it is already long-lived or cannot be exchanged. Never log token data. */
export async function exchangeMetaUserToken({ token, appId, appSecret, fetchImpl = fetch, env = process.env }) {
  if (!appId || !appSecret) return null;
  const version = env.META_GRAPH_VERSION || DEFAULT_META_GRAPH_VERSION;
  if (!/^v[1-9]\d*\.0$/.test(version)) throw new Error('Invalid Meta Graph API version');
  const url = new URL(`https://graph.facebook.com/${version}/oauth/access_token`);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'fb_exchange_token', client_id: String(appId),
        client_secret: String(appSecret), fb_exchange_token: token,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    return response.ok && !body?.error && typeof body?.access_token === 'string' && body.access_token
      ? { accessToken: body.access_token, expiresIn: Number(body.expires_in) || null }
      : null;
  } catch { return null; }
}

// Backward-compatible export name for any older tests or imports.
export const inspectMetaSystemUserToken = inspectMetaAccessToken;
