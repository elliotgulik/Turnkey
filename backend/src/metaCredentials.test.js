import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMetaCredentials, decryptMetaCredentials, encodeMetaCredentials } from './metaCredentials.js';

test('versioned Meta credentials keep permanent lead retrieval and Page subscription tokens distinct', () => {
  const encoded = encodeMetaCredentials({ retrievalToken: 'system-user-token', pageToken: 'page-token' });
  assert.deepEqual(decodeMetaCredentials(encoded), { retrievalToken: 'system-user-token', pageToken: 'page-token' });
  assert.ok(!encoded.includes('version:'));
});

test('legacy encrypted single-token rows remain usable for both Meta operations', () => {
  assert.deepEqual(decodeMetaCredentials('legacy-page-token'), { retrievalToken: 'legacy-page-token', pageToken: 'legacy-page-token' });
});

test('webhook credential lookup selects the Page token, not the system-user token', () => {
  const encoded = encodeMetaCredentials({ retrievalToken: 'system-user-token', pageToken: 'page-token' });
  assert.equal(decryptMetaCredentials(`encrypted:${encoded}`, value => value.slice('encrypted:'.length)).pageToken, 'page-token');
});

test('rejects missing or malformed credentials without exposing token contents', () => {
  assert.throws(() => encodeMetaCredentials({ retrievalToken: '', pageToken: 'private' }), /Both Meta tokens/);
  assert.throws(() => decodeMetaCredentials(''), /Meta token is missing/);
});
