// Meta's maintained Business SDK currently selects v26.0:
// https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py
export const DEFAULT_META_GRAPH_VERSION = "v26.0";
export function metaGraphUrl(objectId, fields, env = process.env) {
  const version = env.META_GRAPH_VERSION || DEFAULT_META_GRAPH_VERSION;
  if (!/^v[1-9]\d*\.0$/.test(version))
    throw new Error("META_GRAPH_VERSION must use the form v26.0");
  const url = new URL(
    `https://graph.facebook.com/${version}/${encodeURIComponent(objectId)}`,
  );
  if (fields) url.searchParams.set("fields", fields);
  return url;
}
export function fetchMetaObject(
  objectId,
  { token, fields, env = process.env, fetchImpl = fetch },
) {
  return fetchImpl(metaGraphUrl(objectId, fields, env), {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
}
