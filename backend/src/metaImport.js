import { normalizeMetaLead } from './metaLeads.js';
import { metaConnectionIssue } from './metaConnectionHealth.js';

const problem = (message, status = 503) => Object.assign(new Error(message), { publicMessage: message, status });
const numericId = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const cursorText = value => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 2000);

// One bounded batch per request. The encrypted continuation is authenticated,
// tenant/Page-bound and expires; clients cannot substitute an arbitrary form.
export async function importMetaBatch({ businessId, pageId, token, cursor, encrypt, decrypt, fetchEdge, addLead, now = Date.now }) {
  let state = { kind: 'meta-lead-import-v1', businessId, pageId, issuedAt: now(), forms: [], formsAfter: null, leadsAfter: null, listed: false };
  if (cursor != null) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 16000) throw Error();
      state = JSON.parse(decrypt(cursor));
      if (state.kind !== 'meta-lead-import-v1' || state.businessId !== businessId || state.pageId !== pageId ||
        !Number.isFinite(state.issuedAt) || now() - state.issuedAt > 86400000 || state.issuedAt > now() ||
        !Array.isArray(state.forms) || state.forms.length > 25 || !state.forms.every(numericId) ||
        !cursorText(state.formsAfter) || !cursorText(state.leadsAfter) || typeof state.listed !== 'boolean') throw Error();
    } catch { throw problem('Import session changed or expired. Start the import again; saved leads will not be duplicated.', 400); }
  }
  const read = async (id, edge, fields, after, limit) => {
    const response = await fetchEdge(id, edge, { token, fields, after, limit });
    const body = await response.json();
    if (!response.ok) throw problem(metaConnectionIssue(body.error).message, [10, 200].includes(Number(body.error?.code)) ? 403 : 503);
    if (!Array.isArray(body.data) || body.data.length > limit) throw problem('Meta returned an invalid lead batch. Retry the import.');
    const next = body.paging?.next ? body.paging?.cursors?.after : null;
    // Never follow a provider-supplied URL containing access tokens. Rebuild
    // every next-page request against the fixed Graph origin using its cursor.
    if (!cursorText(next) || (next && next === after)) throw problem('Meta returned an invalid paging cursor. Retry the import.');
    return { data: body.data, next };
  };
  let formsFound = 0, imported = 0, duplicates = 0;
  if (!state.forms.length && (!state.listed || state.formsAfter)) {
    const result = await read(pageId, 'leadgen_forms', 'id', state.formsAfter, 25);
    if (!result.data.every(form => numericId(form.id))) throw problem('Meta returned an invalid form identity.');
    state.forms = result.data.map(form => form.id);
    state.formsAfter = result.next;
    state.listed = true;
    formsFound = state.forms.length;
  }
  if (state.forms.length) {
    const formId = state.forms[0];
    const result = await read(formId, 'leads', 'id,created_time,field_data,form_id,ad_id', state.leadsAfter, 25);
    for (const lead of result.data) {
      if (!numericId(lead.id) || (lead.form_id && String(lead.form_id) !== formId)) throw problem('Meta returned a lead for an unexpected form.');
      const payload = normalizeMetaLead({ ...lead, form_id: formId }, businessId, { historical: true, now });
      const saved = await addLead(payload);
      if (!saved?.id) throw problem('Lead storage did not confirm the import. Retry; existing leads will be skipped.');
      if (saved.deduped) duplicates++; else imported++;
    }
    state.leadsAfter = result.next;
    if (!state.leadsAfter) state.forms.shift();
  }
  const done = !state.forms.length && !state.formsAfter;
  return { imported, duplicates, formsFound, done, cursor: done ? null : encrypt(JSON.stringify(state)) };
}
