import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMetaConnection } from './metaConnectionHealth.js';

test('Meta lead-form access and Page subscription use the derived Page token', async () => {
  const calls = [];
  const result = await checkMetaConnection({
    pageId: '973487265846279',
    retrievalToken: 'system-user-token',
    pageToken: 'derived-page-token',
    repair: true,
    fetchPage: async (_id, options) => {
      calls.push({ type: 'page', options });
      return { ok: true, json: async () => ({ id: '973487265846279', name: 'NZ Nova Exterior' }) };
    },
    fetchEdge: async (_id, edge, options) => {
      calls.push({ type: edge, options });
      return { ok: true, json: async () => edge === 'leadgen_forms' ? { data: [] } : { success: true } };
    },
  });

  assert.equal(result.health, 'ready');
  assert.equal(calls.find(call => call.type === 'leadgen_forms').options.token, 'derived-page-token');
  assert.equal(calls.find(call => call.type === 'subscribed_apps').options.token, 'derived-page-token');
  assert.equal(calls.some(call => call.options.token === 'system-user-token'), false);
});
