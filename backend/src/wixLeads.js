// Wix Automations webhook lead intake — kept separate from backend/src/index.js
// so the actual decision logic (token hashing, field mapping, validation,
// business lookup, dedupe) is a plain, dependency-injected function with no
// Express/Supabase coupling, and can be unit-tested directly (see
// wixLeads.test.js) without a running server or a real database.
import crypto from 'node:crypto'
import { validateLeadPayload } from './leadValidation.js'

// No OAuth for Wix — a per-business random token is generated in
// Connections and pasted into a Wix Automation. Only the SHA-256 hash is
// ever stored (lead_sources.external_id for provider='wix'); the raw token
// is shown once, at generation time, and is never persisted in reversible
// form — the same way most API-key UIs work, and it means there is nothing
// to decrypt or leak later even if the database is compromised.
export function generateWixToken() {
  return crypto.randomBytes(24).toString('base64url')
}

export function hashWixToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

// Preserve flat, data and contact wrappers; missing or non-scalar names
// stay empty so validation rejects them rather than creating fake leads.
const object = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};
const text = value => typeof value==='string' ? value.trim() : '';
const labelKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g,'');
const answerValues = value => (Array.isArray(value) ? value.slice(0,100) : [value]).map(text).filter(Boolean);
const serviceKeys = ['requestedServices','requested_services','requestedService','requested_service','services','service','Services required','Service required','Select Services Required','What services do you require?','What services do you need?'];
function wixEvent(body) {
  const b=object(body),data=Object.keys(object(b.data)).length?object(b.data):b;
  const submission=object(data.submission),contact=object(data.contact||submission.contact),labels=Object.create(null);
  // Native Old Wix Forms sends an array of label/value answers, not name/email keys.
  let remaining=100;
  for(const wrapper of new Set([data,submission,b])){
    for(const field of (Array.isArray(wrapper.submissions)?wrapper.submissions:[]).slice(0,remaining)){
      remaining--;
      const key=labelKey(field?.label);
      const values=answerValues(field?.value);
      if(key&&key.length<=120&&!labels[key]&&values.length)labels[key]=values;
    }
  }
  return {b,data,submission,contact,labels};
}
export function mapWixPayload(body) {
  const {b,data,submission,contact,labels}=wixEvent(body);
  const field=(...names)=>{for(const n of names){const v=text(data[n])||text(submission[n])||text(b[n])||text(contact[n])||labels[labelKey(n)]?.join(', ');if(v)return v;}return '';};
  const person=object(contact.name),address=object(contact.address);
  const name=field('name','fullName','full_name','contactName','Full name','Your name')||
    [field('firstName','first_name','First name')||text(person.first),field('lastName','last_name','Last name')||text(person.last)].filter(Boolean).join(' ');
  return {
    name,
    email:field('email','emailAddress','email_address','Email address')||undefined,
    phone:field('phone','phoneNumber','phone_number','Phone number','Mobile number')||undefined,
    address:field('address','streetAddress','street_address','Property address','Select an Address')||text(address.formatted)||text(address.formattedAddress)||[text(address.addressLine1),text(address.city),text(address.subdivision),text(address.postalCode)].filter(Boolean).join(', ')||undefined,
    notes:field('message','notes','comment','comments','Enquiry message','How can we help','Tell us about your job','Leave us a message...')||undefined,
    source:'Wix'
  };
}
function wixRequestedServices(body){
  const {b,data,submission,contact,labels}=wixEvent(body);
  // Prefer explicit fields, then native form labels. Keep each selected
  // service separate; arbitrary objects are never coerced into strings.
  for(const wrapper of new Set([data,submission,b,contact,labels])){
    for(const key of serviceKeys){
      const values=answerValues(wrapper===labels?wrapper[labelKey(key)]:wrapper[key]);
      if(values.length)return values.map(value=>value.slice(0,500));
    }
  }
  return [];
}

// A Wix submission's own id, if present, used as the idempotency key so a
// redelivered webhook event (Wix Automations retries on failure, same as
// most webhook senders) doesn't create a second, duplicate lead. Without
// one, there's nothing safe to dedupe on, so the lead is still accepted —
// just without redelivery protection for that one submission.
function extractExternalId(body) {
  const {b,data,submission,contact} = wixEvent(body)
  const topContact = object(b.contact)
  const id = b.submissionId ?? b.submission_id ?? b.id ?? b._id ?? data.submissionId ?? data.submission_id ?? data.id ?? data._id ?? submission.submissionId ?? submission.submission_id ?? submission.id ?? submission._id ?? contact.submissionId ?? contact.submission_id ?? topContact.submissionId ?? topContact.submission_id
  return (typeof id === 'string' || typeof id === 'number') && String(id).trim() ? String(id).trim().slice(0, 200) : null
}

// The actual decision logic, as a plain async function: given the raw
// request (token + body) and two injected dependencies —
//   lookupSource(hash) -> { business_id } | null   (throws on DB failure)
//   addLead(payload)   -> { id, deduped? }          (throws on DB failure)
// — it returns a plain { status, body, ...meta } result the Express route
// turns into an HTTP response. No req/res, no Express, no real Supabase
// client — every branch is reachable with hand-written fakes, which is what
// wixLeads.test.js exercises.
//
// Security property that's worth calling out explicitly (and is covered by
// a test): the resulting payload's business_id ALWAYS comes from whatever
// lookupSource(hash) returns for the hashed token, never from anything in
// the request body — unlike the public POST /api/leads route (which trusts
// a client-supplied business_id, acceptable there because booking.html
// controls that value), a webhook token's hash is the only thing that may
// ever determine which business a Wix lead lands in.
export async function handleWixLead({ token, body, lookupSource, addLead }) {
  if (!token || typeof token !== 'string') {
    return { status: 400, body: { error: 'Missing token' } }
  }

  const hash = hashWixToken(token)
  let source
  try {
    source = await lookupSource(hash)
  } catch (err) {
    return { status: 500, body: { error: 'Failed to save lead' }, cause: err }
  }
  if (!source || !source.business_id) {
    return { status: 404, body: { error: 'Unknown or revoked webhook URL' } }
  }

  const customer = mapWixPayload(body)
  const payload = {
    business_id: source.business_id,
    customer,
    source: 'wix',
    requestedServices: wixRequestedServices(body),
    external_id: extractExternalId(body),
    submittedAt: Date.now()
  }

  const validationError = validateLeadPayload(payload)
  if (validationError) {
    return { status: 400, body: { error: validationError } }
  }

  let lead
  try {
    lead = await addLead(payload)
  } catch (err) {
    return { status: 500, body: { error: 'Failed to save lead' }, cause: err }
  }
  if (!lead || (typeof lead.id !== 'string' && typeof lead.id !== 'number') || !String(lead.id).trim()) {
    return { status: 500, body: { error: 'Failed to save lead' } }
  }

  return {
    status: 200,
    body: { ok: true, id: lead.id },
    businessId: source.business_id,
    customerName: customer.name,
    deduped: !!lead.deduped
  }
}
