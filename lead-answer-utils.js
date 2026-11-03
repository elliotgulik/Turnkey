/* Shared, pure intake-answer reader. Answers are data: callers must escape for HTML.
 * Browser: window.TK_LEAD_ANSWERS. Backend ESM: import answers from '../../lead-answer-utils.js'.
 * answersFromNotes/answersFromFields -> [{label, answer, kind:'service'|'context'}].
 * servicesFromNotes/servicesFromFields -> exact answer strings, NEVER split at commas.
 * Fields accepts Meta field_data arrays or a map of field names to scalar/array values.
 * One original array value stays one answer. No pricing IDs, selection inference or writes.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TK_LEAD_ANSWERS = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const serviceKeys = new Set([
    'services', 'service', 'requestedservices', 'requestedservice', 'servicesrequested',
    'servicesrequired', 'servicerequired', 'selectservice', 'selectservices',
    'selectservicesrequired', 'whatservicesdoyourequire', 'whatservicesdoyouneed',
    'whatwouldyoulikecleaned',
  ]);
  const messageKeys = new Set([
    'message', 'messages', 'jobdetails', 'additionalinfo', 'additionalinformation',
    'comment', 'comments', 'notes', 'customernotes', 'customerrequest', 'request',
  ]);
  const compact = value => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  function scalar(value) {
    return typeof value === 'string' ? value.trim() :
      typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  }
  function humanizeLabel(key) {
    const label = scalar(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return label ? label[0].toUpperCase() + label.slice(1) : 'Notes';
  }
  function isServiceField(key) {
    const normalized = compact(scalar(key));
    return serviceKeys.has(normalized) || /^listcleaningservices/.test(normalized);
  }
  function hasServiceWords(answer) {
    // Inspect the ANSWER only. A question may enumerate every possible service.
    const text = answer.replace(/_/g, ' ');
    const action = /\b(?:wash(?:ing)?|clean(?:ing|ed)?|treat(?:ment|ing)?|clear(?:ing)?|quote|quoting|blast(?:ing)?|remov(?:e|al|ing)|water\s*blast(?:ing)?|pressure\s*wash(?:ing)?)\b/i;
    const property = /\b(?:house|home|exterior|roof|windows?|gutters?|driveways?|patios?|decks?|fences?|pavers?|concrete|solar\s+panels?|spiders?|moss|mould|mold|balustrades?)\b/i;
    return (action.test(text) && property.test(text)) || /\b(?:pressure\s*wash(?:ing)?|water\s*blast(?:ing)?)\b/i.test(text);
  }
  function answerRow(key, value) {
    const answer = scalar(value);
    if (!answer) return null;
    const service = isServiceField(key) || (messageKeys.has(compact(key)) && hasServiceWords(answer));
    return { label: service ? 'Customer request' : humanizeLabel(key), answer, kind: service ? 'service' : 'context' };
  }
  function answersFromFields(fields) {
    const entries = Array.isArray(fields) ? fields.map(item => [item?.name, item?.values]) :
      fields && typeof fields === 'object' ? Object.entries(fields) : [];
    const rows = [];
    for (const [key, values] of entries) {
      if (typeof key !== 'string' || !key.trim()) continue;
      for (const value of Array.isArray(values) ? values : [values]) {
        const row = answerRow(key, value);
        if (row) rows.push(row);
      }
    }
    return rows;
  }
  function answersFromNotes(notes) {
    if (typeof notes !== 'string') return [];
    // Booking adds this provenance suffix; it is not part of a written answer.
    const text = notes.split(/\s*·\s*Submitted via online quote tool\b/)[0].trim();
    if (!text) return [];
    const entries = [];
    let key = 'Notes', lines = [];
    const flush = () => {
      const row = answerRow(key, lines.join('\n'));
      if (row) entries.push(row);
    };
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === 'Submitted via online quote tool') continue;
      // Commas, question marks and parentheses belong to the FULL field key.
      // Numeric time lines (10:30) and URLs are continuation text, not keys.
      const field = /^([A-Za-z][^:\n]*):[ \t]*(.*)$/.exec(line);
      if (field && !/^https?$/i.test(field[1])) {
        flush(); key = field[1].trim(); lines = [field[2]];
      } else lines.push(line);
    }
    flush();
    return entries;
  }
  // Already-normalized submission answers retain their original labels. Unlike
  // legacy notes, a Message is context, not a replacement for Select Services.
  function answersFromSubmission(fields) {
    if (!Array.isArray(fields)) return [];
    return fields.slice(0,100).flatMap(field => {
      if (!field || typeof field.label !== 'string') return [];
      const label=field.label.trim().slice(0,300);
      const value=typeof field.answer==='boolean' ? (field.answer?'Checked':'Unchecked') : field.answer;
      const answer=scalar(value).slice(0,4000);
      return label && answer ? [{label,answer,kind:isServiceField(label)?'service':'context'}] : [];
    });
  }
  // Presentation only: raw intake answers remain unchanged for ingestion/audits.
  function presentRecord(record) {
    const groups = [], seen = new Set();
    const pretty = (value, contact=false) => {
      const text = String(value || '').trim();
      if (contact || /https?:\/\//i.test(text)) return text;
      const clean = text.replace(/_/g, ' ').replace(/[ \t]+/g, ' ').trim();
      return clean ? clean[0].toUpperCase() + clean.slice(1) : '';
    };
    const add = row => {
      const key = compact(row.label), answer = row.answer;
      let group='Additional information', label=humanizeLabel(row.label), contact=false;
      if (row.kind==='service' || isServiceField(row.label) || key==='customerrequest') { group='Services & property'; label='Requested services'; }
      else if (/residentialorcommercial|propertytype|customertype/.test(key)) { group='Services & property'; label='Property type'; }
      else if (/storeys|stories|houselevels|numberoflevels/.test(key)) { group='Services & property'; label='House levels'; }
      else if (/accessdifficulty|propertyaccess/.test(key)) { group='Services & property'; label='Access'; }
      else if (/urgency|howsoon|preferredtiming/.test(key)) { group='Timing'; label='Urgency'; }
      else if (/preferred.*date|preferred.*time|besttimetocall|bookingdate|cleaningfrequency/.test(key)) { group='Timing'; }
      else if (/^(firstname|lastname|fullname|name|email|phone|phonenumber|mobile|address|jobaddress|selectanaddress)$/.test(key)) { group='Contact details'; contact=true; }
      else if (/how.*find|referralsource/.test(key)) label='How they found us';
      else if (/agree|consent|terms/.test(key)) { group='Consent'; }
      else if (messageKeys.has(key)) label='Customer message';
      const display=pretty(answer,contact), dedupe=group+'|'+label.toLowerCase()+'|'+display.toLowerCase();
      if (!display || seen.has(dedupe) || /^(submitted via online quote tool)[.!]?$/i.test(display)) return;
      seen.add(dedupe);
      groups.push({group,label,answer:display,needsClarification:label==='Requested services' && /^(outside|inside|both|yes|no)$/i.test(display)});
    };
    answersFromSubmission(record?.formAnswers).forEach(add);
    for (const key of ['notes','jobNotes','salesNotes']) {
      const text=String(record?.[key]||'').replace(/[ \t]+(?=(?:urgency|residential_or_commercial|property_type|best_time_to_call):)/gi,'\n');
      answersFromNotes(text).forEach(row=>add(key==='salesNotes'&&row.label==='Notes'?{...row,label:'Sales notes'}:row));
    }
    if (!groups.some(row=>row.label==='Requested services')) {
      for (const value of Array.isArray(record?.requestedServices)?record.requestedServices:[]) {
        const answer=typeof value==='string'?value:value?.name||value?.label;
        if(answer)add({label:'Requested services',answer,kind:'service'});
      }
    }
    if(record?.urgency&&!groups.some(row=>row.label==='Urgency'))add({label:'Urgency',answer:record.urgency});
    return groups;
  }
  const servicesFromNotes = notes => answersFromNotes(notes).filter(row => row.kind === 'service').map(row => row.answer);
  const servicesFromFields = fields => answersFromFields(fields).filter(row => row.kind === 'service').map(row => row.answer);
  return { presentRecord, answersFromNotes, answersFromFields, answersFromSubmission, servicesFromNotes, servicesFromFields, humanizeLabel, isServiceField };
});
