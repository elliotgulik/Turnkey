import test from "node:test";
import assert from "node:assert/strict";
import { metaGraphUrl, fetchMetaObject, fetchMetaEdge } from "./metaGraph.js";
test("both Meta read shapes use current default and explicit requested fields", () => {
  for (const [id, fields] of [
    ["123", "id,field_data"],
    ["456", "id,name"],
  ]) {
    const url = metaGraphUrl(id, fields, {});
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.equal(url.pathname, "/v26.0/" + id);
    assert.equal(url.searchParams.get("fields"), fields);
  }
});
test("version override is configurable and cannot inject a URL", () => {
  assert.equal(
    metaGraphUrl("123", null, { META_GRAPH_VERSION: "v25.0" }).pathname,
    "/v25.0/123",
  );
  for (const version of [
    "https://evil.example",
    "v26.0/../v19.0",
    "26",
    "v26.0?token=secret",
  ])
    assert.throws(() =>
      metaGraphUrl("123", null, { META_GRAPH_VERSION: version }),
    );
  assert.match(
    metaGraphUrl("../123?access_token=oops", "id", {}).pathname,
    /%2F/,
  );
});
test("tokens are in authorization headers, with bounded fetch and redirects disabled", async () => {
  let request;
  const expected = { ok: true };
  const result = await fetchMetaObject("123", {
    token: "fake-test-token",
    fields: "id,name",
    env: {},
    fetchImpl: async (url, options) => {
      request = { url, options };
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.equal(request.options.headers.Authorization, "Bearer fake-test-token");
  assert.equal(request.options.redirect, "error");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.equal(request.url.href.includes("fake-test-token"), false);
});

test('Page subscription uses a real Graph edge and an encoded POST body, keeping token out of URL', async () => {
  let request;
  await fetchMetaEdge('123', 'subscribed_apps', { token: 'test-secret', method: 'POST', body: { subscribed_fields: 'leadgen' }, env: {}, fetchImpl: async (url, options) => {request={url,options};return {ok:true};} });
  assert.equal(request.url.pathname, '/v26.0/123/subscribed_apps');
  assert.equal(request.options.body, 'subscribed_fields=leadgen');
  assert.equal(request.options.headers.Authorization,'Bearer test-secret');
  assert.equal(request.url.href.includes('test-secret'),false);
});
