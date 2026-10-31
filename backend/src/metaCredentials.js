// Keep Meta's durable lead-reading token separate from the Page token used
// to subscribe/check leadgen webhooks. The existing encrypted text column can
// hold this versioned envelope, so legacy single-token rows need no migration.
const META_CREDENTIALS_VERSION = 1;

export function encodeMetaCredentials({ retrievalToken, pageToken }) {
  if (typeof retrievalToken !== 'string' || !retrievalToken ||
      typeof pageToken !== 'string' || !pageToken) {
    throw new TypeError('Both Meta tokens are required');
  }
  return JSON.stringify({ version: META_CREDENTIALS_VERSION, retrievalToken, pageToken });
}

export function decodeMetaCredentials(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('Meta token is missing');
  try {
    const parsed = JSON.parse(value);
    if (parsed?.version === META_CREDENTIALS_VERSION &&
        typeof parsed.retrievalToken === 'string' && parsed.retrievalToken &&
        typeof parsed.pageToken === 'string' && parsed.pageToken) {
      return { retrievalToken: parsed.retrievalToken, pageToken: parsed.pageToken };
    }
  } catch { /* Legacy rows encrypted a single raw Page token. */ }
  return { retrievalToken: value, pageToken: value };
}

export function decryptMetaCredentials(value, decrypt) {
  return decodeMetaCredentials(decrypt(value));
}
