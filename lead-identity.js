/* Pure lead identity. Browser: TK_LEAD_IDENTITY; Node: require('./lead-identity').
 * sameIntake(a, b, businessId?) compares CRM records or intake payloads.
 * selectRepresentatives(records, businessId?) returns original objects in stable
 * group order, preferring substantive quotes, links and populated records.
 * analyzeRecords(records, businessId?) -> {representatives, duplicates, conflicts}.
 * duplicates: [{representative, duplicate, reason}]; conflicts: [{records, reason}].
 * All result records are original references; ties keep the first input record.
 * businessId is a TRUSTED scope for rows without business_id/businessId (the
 * app keeps ownership in recordBusinesses). Explicit foreign scopes never match.
 * Only jobId/job_id denote jobs. Generic id is a UI/queue/customer ID: ignored.
 * Adapt raw jobs explicitly with jobId: row.id; never pass queue IDs as job IDs.
 * Provider keys are externalSource/provider/source + externalId/external_id.
 * ServiceM8 links: serviceM8JobUuid/serviceM8JobId/sm8_job_uuid. Parent must
 * attach mapping-only links as serviceM8JobUuid before selection; these links
 * protect different jobs but are not themselves a fallback intake identity.
 * No contact, timestamp, customer ID, quote ID, or fuzzy identity fallbacks.
 * Selection is a view operation: no merging fields, mutation, persistence or deletes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.TK_LEAD_IDENTITY = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  // Opaque IDs are case/whitespace sensitive; reject empty and unsafe numbers.
  function id(value) {
    if (typeof value === 'string') return value.trim() ? value : '';
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : '';
  }
  function aliases(row, keys) {
    const values = keys.map(key => id(row[key])).filter(Boolean);
    return new Set(values).size > 1 ? false : values[0] || '';
  }
  function identity(row, businessId) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const explicit = aliases(row, ['businessId', 'business_id']);
    const scope = id(businessId);
    if (explicit === false || (explicit && scope && explicit !== scope)) return null;
    const business = explicit || scope;
    const job = aliases(row, ['jobId', 'job_id']);
    const external = aliases(row, ['externalId', 'external_id']);
    if (!business || job === false || external === false) return null;
    const provider = row.externalSource || row.provider || row.source;
    const sm8 = aliases(row, ['serviceM8JobUuid', 'serviceM8JobId', 'sm8_job_uuid']);
    if (sm8 === false) return null;
    const quote = aliases(row, ['quoteId', 'quote_id']);
    if (quote === false) return null;
    return { business, job, external, sm8, quote, substantive: substantive(row),
      provider: typeof provider === 'string' ? provider.trim().toLowerCase() : '' };
  }
  function substantive(row) {
    return Number(row.total) > 0 || (Array.isArray(row.services) && row.services.length > 0) ||
      !!row.quoteSentAt || !!row.acceptedAt ||
      !!(row.stage && !['new', 'lead'].includes(String(row.stage).toLowerCase()));
  }
  function relation(a, b) {
    if (!a || !b || a.business !== b.business) return null;
    const sameJob = !!(a.job && a.job === b.job);
    const sameSubmission = !!(a.provider && a.external && a.provider === b.provider && a.external === b.external);
    if (!sameJob && !sameSubmission) return null;
    if (a.sm8 && b.sm8 && a.sm8 !== b.sm8) return { conflict: 'different-servicem8-jobs' };
    // Two independently developed jobs are never inferred to be duplicates.
    // A zero-value blank copy can still be a duplicate of a quoted job.
    if (!sameJob && a.substantive && b.substantive &&
        ((a.quote && b.quote && a.quote !== b.quote) ||
        (a.job && b.job && !(a.quote && a.quote === b.quote)))) return { conflict: 'different-substantive-quotes' };
    return { reason: sameJob ? 'same-job' : 'same-provider-submission' };
  }
  function sameIntake(a, b, businessId) {
    return !!relation(identity(a, businessId), identity(b, businessId))?.reason;
  }
  function quality(record, key) {
    if (!key) return [0];
    const populated = ['name', 'email', 'phone', 'address', 'suburb', 'notes', 'jobNotes',
      'requestedServices', 'formAnswers', 'services', 'areaPolys'].filter(field => {
      const value = record[field];
      return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && !!value.trim();
    }).length;
    return [Number(key.substantive), Number(!!key.quote), Number(!!key.sm8),
      ['customerId', 'invoiceId'].filter(field => id(record[field])).length, populated, Number(!!key.job)];
  }
  function better(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  function analyzeRecords(records, businessId) {
    const entries = records.map(record => ({ record, key: identity(record, businessId) }));
    const conflicts = [], groups = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < i; j++) {
        const match = relation(entries[j].key, entries[i].key);
        if (match?.conflict) conflicts.push({ records: [entries[j].record, entries[i].record], reason: match.conflict });
      }
    }
    for (const entry of entries) {
      const { record, key } = entry;
      // Check every member for conflicts so a blank copy cannot bridge two
      // developed jobs. A proven edge is required to join the group.
      const compatible = candidate => {
        const links = candidate.members.map(member => relation(member.key, key));
        return links.some(link => link?.reason) && !links.some(link => link?.conflict);
      };
      const group = (key?.job && groups.find(candidate => candidate.members.some(member =>
        member.key?.business === key.business && member.key?.job === key.job) && compatible(candidate))) ||
        groups.find(compatible);
      const rank = quality(record, key);
      if (!group) groups.push({ representative: entry, rank, members: [entry] });
      else {
        group.members.push(entry);
        if (better(rank, group.rank)) { group.representative = entry; group.rank = rank; }
      }
    }
    const duplicates = groups.flatMap(group => group.members.filter(member => member !== group.representative)
      .map(member => ({ representative: group.representative.record, duplicate: member.record,
        reason: relation(group.representative.key, member.key)?.reason || 'proven-identity-chain' })));
    return { representatives: groups.map(group => group.representative.record), duplicates, conflicts };
  }
  function selectRepresentatives(records, businessId) {
    return analyzeRecords(records, businessId).representatives;
  }
  return Object.freeze({ sameIntake, selectRepresentatives, analyzeRecords });
});
