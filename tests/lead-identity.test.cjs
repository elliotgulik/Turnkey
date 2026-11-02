const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const identity = require('../lead-identity.js');

test('lead identity only coalesces tenant-scoped proven jobs or provider submissions', () => {
  const { sameIntake, selectRepresentatives, analyzeRecords } = identity;
  const contact = { name: 'Robin', email: 'robin@example.test', phone: '0210000000',
    customerId: 'customer-1', submittedAt: 123, _submittedAt: 123, id: 7 };
  const first = { ...contact, business_id: 'A', jobId: 'job-1' };
  const copy = { ...first, id: 99, name: 'Changed name' };
  const differentJob = { ...first, jobId: 'job-2' };
  assert.equal(sameIntake(first, copy), true);
  assert.equal(sameIntake(first, differentJob), false);
  assert.equal(sameIntake(contact, { ...contact }, 'A'), false);
  assert.equal(sameIntake({ id: 'job-1' }, { id: 'job-1' }, 'A'), false);
  assert.equal(sameIntake({ jobId: 'job-1' }, { job_id: 'job-1' }), false);
  assert.equal(sameIntake({ jobId: 'job-1' }, { job_id: 'job-1' }, 'A'), true);
  assert.equal(sameIntake(first, { ...copy, business_id: 'B' }), false);
  assert.equal(sameIntake(first, copy, 'B'), false);
  assert.equal(sameIntake(first, { ...copy, businessId: 'B' }), false);
  assert.equal(sameIntake(first, { ...copy, job_id: 'job-2' }), false);

  const payload = { ...contact, source: 'wix', external_id: 'submission-1', business_id: 'A' };
  const saved = { ...first, externalSource: 'Wix', externalId: 'submission-1',
    stage: 'quoted', total: 465, quoteId: 'quote-1' };
  assert.equal(sameIntake(saved, payload), true);
  assert.equal(sameIntake(saved, { ...payload, external_id: 'submission-2' }), false);
  assert.equal(sameIntake(saved, { ...payload, source: 'meta' }), false);
  assert.equal(sameIntake(saved, { ...payload, business_id: 'B' }, 'A'), false);
  assert.equal(sameIntake(saved, { ...payload, jobId: 'job-2' }), true);
  assert.equal(sameIntake(saved, { ...payload, external_id: ' submission-1' }), false);
  assert.equal(sameIntake(saved, { ...payload, externalId: 'contradiction' }), false);
  assert.equal(sameIntake({ externalId: 'x' }, { external_id: 'x' }, 'A'), false);
  for (const missing of [undefined, null, '', ' ', false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(sameIntake({ jobId: missing }, { jobId: missing }, 'A'), false);
    assert.equal(sameIntake({ source: 'wix', external_id: missing }, { source: 'wix', external_id: missing }, 'A'), false);
  }
  assert.equal(sameIntake({ source: 'meta', external_id: 0 }, { externalSource: 'meta', externalId: '0' }, 'A'), true);
  assert.equal(sameIntake(null, payload, 'A'), false);

  // Numeric UI ID collisions do not hide new records; independent quotes survive.
  const other = { ...differentJob, id: saved.id, externalSource: 'wix', externalId: 'submission-1',
    stage: 'quoted', total: 600, quoteId: 'quote-2' };
  const missing = { ...contact };
  const rows = [payload, saved, copy, other, missing, { ...missing }];
  rows.forEach(Object.freeze);
  Object.freeze(rows);
  const result = selectRepresentatives(rows, 'A');
  assert.deepEqual(result, [saved, other, rows[4], rows[5]]);
  assert.strictEqual(result[0], saved);
  assert.deepEqual(selectRepresentatives(result, 'A'), result);
  // Bridge order cannot collapse the two proven jobs.
  assert.deepEqual(selectRepresentatives([saved, payload, other], 'A'), [saved, other]);
  assert.deepEqual(selectRepresentatives([other, payload, saved], 'A'), [other, saved]);
  assert.deepEqual(selectRepresentatives([saved, { ...saved, business_id: 'B' }]),
    [saved, { ...saved, business_id: 'B' }]);
  assert.deepEqual(selectRepresentatives([missing, missing], 'A'), [missing, missing]);
  assert.deepEqual(selectRepresentatives([]), []);

  // Shapes reported by the read-only audit: quoted Wix + blank copy, and
  // two new/zero Meta copies with the same opaque synthetic submission ID.
  const wixBlank = Object.freeze({ business_id: 'A', jobId: 'blank-wix', source: 'wix',
    external_id: 'submission-1', stage: 'new', total: 0 });
  const metaBlank = Object.freeze({ business_id: 'A', jobId: 'blank-meta', externalSource: 'meta',
    externalId: 'synthetic:lead:123', stage: 'new', total: 0 });
  const metaFull = Object.freeze({ ...metaBlank, jobId: 'full-meta', customerId: 'customer-2',
    name: 'Robin', notes: 'Please quote the driveway', formAnswers: [{ label: 'Service', answer: 'Driveway' }] });
  const auditRows = Object.freeze([wixBlank, metaBlank, saved, metaFull]);
  const audit = analyzeRecords(auditRows, 'A');
  assert.deepEqual(audit.representatives, [saved, metaFull]);
  assert.deepEqual(audit.duplicates, [
    { representative: saved, duplicate: wixBlank, reason: 'same-provider-submission' },
    { representative: metaFull, duplicate: metaBlank, reason: 'same-provider-submission' },
  ]);
  assert.deepEqual(audit.conflicts, []);
  assert.deepEqual(selectRepresentatives([saved, wixBlank], 'A'), [saved]);
  assert.deepEqual(selectRepresentatives([metaFull, metaBlank], 'A'), [metaFull]);

  const quotedConflict = analyzeRecords([saved, wixBlank, other], 'A');
  assert.deepEqual(quotedConflict.representatives, [saved, other]);
  assert.deepEqual(quotedConflict.conflicts, [
    { records: [saved, other], reason: 'different-substantive-quotes' },
  ]);
  assert.equal(sameIntake(saved, other, 'A'), false);
  assert.equal(sameIntake({...saved,jobId:null},{...other,jobId:null},'A'),false,'different saved quotes survive incomplete legacy job links');
  const linked = { ...metaBlank, serviceM8JobUuid: 'sm8-1' };
  const foreignLink = { ...metaFull, serviceM8JobUuid: 'sm8-2' };
  assert.equal(sameIntake(linked, foreignLink, 'A'), false);
  const linkConflict = analyzeRecords([linked, metaBlank, foreignLink], 'A');
  assert.deepEqual(linkConflict.representatives, [linked, foreignLink]);
  assert.deepEqual(linkConflict.conflicts, [
    { records: [linked, foreignLink], reason: 'different-servicem8-jobs' },
  ]);
  assert.deepEqual(selectRepresentatives([metaBlank, linked], 'A'), [linked]);
  assert.equal(sameIntake(saved, { ...other, quoteId: 'quote-1' }, 'A'), true);
  assert.equal(sameIntake({ ...saved, quoteId: null }, { ...other, quoteId: null }, 'A'), false);
  assert.equal(sameIntake(metaBlank, { ...metaBlank, jobId: 'another-job', externalId: 'synthetic:lead:456' }, 'A'), false);

  const source = fs.readFileSync(require.resolve('../lead-identity.js'), 'utf8');
  const browser = { window: {} };
  vm.runInNewContext(source, browser);
  assert.equal(browser.window.TK_LEAD_IDENTITY.sameIntake(saved, payload), true);
  let amd;
  const define = (_, factory) => { amd = factory(); };
  define.amd = {};
  vm.runInNewContext(source, { define });
  assert.equal(amd.sameIntake(first, differentJob), false);
});
