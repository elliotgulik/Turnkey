import { DEFAULT_META_GRAPH_VERSION } from './metaGraph.js';

const REQUIRED_SCOPES = ['leads_retrieval', 'pages_manage_metadata', 'ads_read'];

/** Validate the durable Meta credential before saving it. A user ID is not a
 * credential; normal user tokens expire and must not be presented as permanent.
 * Only a never-expiring System User token created for this app is accepted. */
export async function inspectMetaSystemUserToken({ token, appId, appSecret, fetchImpl = fetch, env = process.env }) {
  if (!appId || !appSecret) {
    throw Object.assign(new Error('Meta app verification is not configured.'), {
      status: 503,
      publicMessage: 'The backend needs META_APP_ID and META_APP_SECRET before it can verify a durable Meta token.',
    });
  }
  const version = env.META_GRAPH_VERSION || DEFAULT_META_GRAPH_VERSION;
  if (!/^v[1-9]\d*\.0$/.test(version)) throw new Error('Invalid Meta Graph API version');
  const url = new URL(`https://graph.facebook.com/${version}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);
  let response, body;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    body = await response.json();
  } catch {
    throw Object.assign(new Error('Meta token verification failed.'), {
      status: 502,
      publicMessage: 'TurnKey could not verify this token with Meta. Retry the connection check.',
    });
  }
  const data = body?.data;
  if (!response.ok || body?.error || !data?.is_valid) {
    throw Object.assign(new Error('Meta rejected the supplied access token.'), {
      status: 400,
      publicMessage: 'Meta rejected this token. Generate a System User token for the TurnKey app, then try again.',
    });
  }
  if (String(data.app_id) !== String(appId)) {
    throw Object.assign(new Error('Meta token belongs to a different app.'), {
      status: 400,
      publicMessage: 'This token was created for a different Meta app. Select the TurnKey CRM app when generating the System User token.',
    });
  }
  if (String(data.type).toUpperCase() !== 'SYSTEM_USER' || Number(data.expires_at) !== 0) {
    throw Object.assign(new Error('Meta token is not a non-expiring System User token.'), {
      status: 400,
      publicMessage: 'This token will expire or is a personal user token. Use Business Settings → System Users → Generate token, select TurnKey CRM, and set expiration to Never.',
    });
  }
  const scopes = new Set(Array.isArray(data.scopes) ? data.scopes : []);
  const missing = REQUIRED_SCOPES.filter(scope => !scopes.has(scope));
  if (missing.length) {
    throw Object.assign(new Error('Meta token lacks required permissions.'), {
      status: 403,
      publicMessage: `This System User token is missing: ${missing.join(', ')}. Regenerate it with those permissions.`,
    });
  }
  return { appId: String(data.app_id), type: String(data.type), expiresAt: 0, scopes: [...scopes] };
}
