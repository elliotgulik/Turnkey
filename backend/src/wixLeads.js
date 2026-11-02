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

// Decode known Wix answer envelopes; missing or malformed names stay empty
// so validation rejects them rather than creating fake leads.
const object = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};
const text = value => typeof value==='string' ? value.trim() : '';
const labelKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g,'');
function answerValues(value, depth=0) {
  if(depth>5)return [];
  if(Array.isArray(value))return value.slice(0,100).flatMap(item=>Array.isArray(item)?[]:answerValues(item,depth+1)).slice(0,100);
  if(typeof value==='string')return text(value)?[text(value)]:[];
  const answer=object(value);
  if(answer.selected===false||answer.checked===false)return [];
  // Only known answer envelopes/options are decoded, never arbitrary object values.
  if('values' in answer)return answerValues(answer.values,depth+1);
  if('value' in answer){
    if(typeof answer.value==='boolean')return answer.value&&text(answer.label)?[text(answer.label)]:[];
    if(text(answer.label))return [text(answer.label)];
    return answerValues(answer.value,depth+1);
  }
  return text(answer.label)?[text(answer.label)]:[];
}
const serviceKeys = new Set(['requestedservices','requestedservice','servicesrequested','services','service','servicesrequired','servicerequired','selectservice','selectservices','selectservicesrequired','whatservicesdoyourequire','whatservicesdoyouneed','whatwouldyoulikecleaned']);
// Flat Automation payloads mix answers with routing/transport metadata. Only
// recognized questions are answers there; labelled containers can carry custom questions.
const flatAnswerKeys = new Set([...serviceKeys, ...[
  'name','fullName','contactName','Your name','firstName','lastName','email','emailAddress',
  'phone','phoneNumber','Mobile number','address','streetAddress','Property address',
  'Select an Address','Job Address','message','notes','comment','comments','Enquiry message',
  'How can we help','Tell us about your job','Leave us a message...', 'urgency','timing',
  'How soon do you need this done?','When do you need this done?','When would you like this done?',
  "How'd you find us",'How did you find us','Select Window Cleaning Type','Cleaning Frequency',
  'consent','Marketing consent','Email consent','SMS consent','Privacy consent','Terms and conditions',
].map(labelKey)]);
const internalAnswerKey = key => /token|secret|authorization|apikey/.test(key) ||
  /^(id|internalid|businessid|contactid|submissionid|externalid|metadata|options|choices|offeredchoices|formid|formname|createdat|updatedat)$/.test(key);
function submittedValues(value, depth=0) {
  if(depth>5)return [];
  if(typeof value==='boolean')return [value?'Checked':'Unchecked'];
  if(typeof value==='number'&&Number.isFinite(value))return [String(value)];
  if(Array.isArray(value))return value.slice(0,100).flatMap(item=>Array.isArray(item)?[]:submittedValues(item,depth+1)).slice(0,100);
  if(typeof value==='string')return text(value)?[text(value)]:[];
  const answer=object(value);
  if(answer.selected===false||answer.checked===false)return [];
  if('values' in answer)return submittedValues(answer.values,depth+1);
  if('value' in answer){
    if(typeof answer.value==='boolean')return text(answer.label)?(answer.value?[text(answer.label)]:[]):submittedValues(answer.value,depth+1);
    return text(answer.label)?[text(answer.label)]:submittedValues(answer.value,depth+1);
  }
  if('answer' in answer)return submittedValues(answer.answer,depth+1);
  return text(answer.label)?[text(answer.label)]:[];
}
function wixEvent(body) {
  const b=object(body),data=Object.keys(object(b.data)).length?object(b.data):b;
  const wrappers=[],seen=new Set();
  function visit(value,depth=0){
    if(!value||typeof value!=='object'||Array.isArray(value)||seen.has(value)||depth>6||wrappers.length>=30)return;
    seen.add(value);wrappers.push(value);
    for(const key of ['data','payload','submission'])visit(value[key],depth+1);
  }
  visit(data);visit(b);
  const submission=wrappers.find(wrapper=>Object.keys(object(wrapper.submission)).length)?.submission||{};
  const contact=wrappers.map(wrapper=>object(wrapper.contact)).find(value=>Object.keys(value).length)||{};
  const labels=Object.create(null),formAnswers=[];
  // Native Forms/Automations use labelled arrays or maps under these containers.
  let remaining=100;
  for(const wrapper of wrappers){
    for(const container of Object.keys(wrapper).filter(key=>['submissions','fields','answers'].includes(key))){
      if(remaining<=0)break;
      const fields=wrapper[container];
      const entries=Array.isArray(fields)?fields.slice(0,remaining):Object.entries(object(fields)).slice(0,remaining).map(([key,value])=>{
        const field=object(value);
        return text(field.label)||text(field.name)?field:{label:key,value};
      });
      for(const field of entries){
        remaining--;
        const label=text(field?.label||field?.name||field?.key);
        const key=labelKey(field?.label||field?.name||field?.key);
        const raw=field?.value??field?.values??field?.answer;
        const values=answerValues(raw);
        if(key&&key.length<=120&&values.length)labels[key]=[...(labels[key]||[]),...values].slice(0,100);
        const answers=submittedValues(raw);
        if(key&&key.length<=120&&!internalAnswerKey(key)&&answers.length)formAnswers.push({label,answer:answers.join(', ').slice(0,4000)});
      }
    }
  }
  for(const wrapper of new Set([...wrappers,contact])){
    for(const [label,value] of Object.entries(wrapper).slice(0,100)){
      if(remaining<=0)break;
      const key=labelKey(label);
      if((!flatAnswerKeys.has(key)&&!/^(iagree|consent|subscribe|acceptterms)/.test(key))||internalAnswerKey(key))continue;
      const answers=submittedValues(value);
      if(!answers.length)continue;
      remaining--;
      formAnswers.push({label,answer:answers.join(', ').slice(0,4000)});
    }
  }
  const person=object(contact.name);
  if(!formAnswers.some(({label})=>['name','fullname','contactname','firstname','lastname'].includes(labelKey(label)))){
    const fullName=[text(person.first),text(person.last)].filter(Boolean).join(' ');
    if(fullName&&remaining>0)formAnswers.push({label:'Full name',answer:fullName});
  }
  return {b,data,submission,contact,labels,wrappers,formAnswers};
}
export function mapWixPayload(body) {
  const {contact,labels,wrappers}=wixEvent(body);
  const field=(...names)=>{
    for(const n of names){
      for(const wrapper of [...wrappers,contact]){
        const value=wrapper[n]??Object.entries(wrapper).find(([key])=>labelKey(key)===labelKey(n))?.[1];
        // Bare arrays are selections, not scalar customer identity fields.
        const answer=Array.isArray(value)?'':answerValues(value).join(', ');
        if(answer)return answer;
      }
      const answer=labels[labelKey(n)]?.join(', ');
      if(answer)return answer;
    }
    return '';
  };
  const person=object(contact.name),address=object(contact.address);
  const name=field('name','fullName','full_name','contactName','Full name','Your name')||
    [field('firstName','first_name','First name')||text(person.first),field('lastName','last_name','Last name')||text(person.last)].filter(Boolean).join(' ');
  const timing=field('urgency','timing','How soon do you need this done?','When do you need this done?','When would you like this done?');
  return {
    name,
    email:field('email','emailAddress','email_address','Email address')||undefined,
    phone:field('phone','phoneNumber','phone_number','Phone number','Mobile number')||undefined,
    address:field('address','streetAddress','street_address','Property address','Select an Address','Job Address')||text(address.formatted)||text(address.formattedAddress)||[text(address.addressLine1),text(address.city),text(address.subdivision),text(address.postalCode)].filter(Boolean).join(', ')||undefined,
    notes:field('message','notes','comment','comments','Enquiry message','How can we help','Tell us about your job','Leave us a message...')||undefined,
    // ingestQuoteRequest reads c.timing when composing the saved lead notes.
    ...(timing?{timing}:{}),
    source:'Wix'
  };
}
function wixRequestedServices(body){
  const {contact,labels,wrappers}=wixEvent(body),services=[];
  // Accumulate every recognized service answer, including repeated checkbox labels.
  // Never inspect unknown questions, metadata, or the question's offered choices.
  for(const wrapper of new Set([...wrappers,contact,labels])){
    for(const [key,value] of Object.entries(wrapper)){
      if(!serviceKeys.has(labelKey(key)))continue;
      for(const answer of answerValues(value)){
        services.push(...answer.split(/[,;\n]+/).map(value=>value.trim().slice(0,500)).filter(Boolean).slice(0,100-services.length));
        if(services.length>=100)return services;
      }
    }
  }
  if(!services.length){
    const {formAnswers}=wixEvent(body);
    const windowType=formAnswers.find(({label})=>labelKey(label)==='selectwindowcleaningtype')?.answer;
    const windowServices={both:'Window Clean (Inside & Outside)',outsideonly:'Window Clean (Outside Only)',insideonly:'Window Clean (Inside Only)'};
    const service=windowServices[labelKey(windowType)];
    if(service)services.push(service);
  }
  return services;
}

// A Wix submission's own id, if present, used as the idempotency key so a
// redelivered webhook event (Wix Automations retries on failure, same as
// most webhook senders) doesn't create a second, duplicate lead. Without
// one, there's nothing safe to dedupe on, so the lead is still accepted —
// just without redelivery protection for that one submission.
function extractExternalId(body) {
  const {b,data,submission,contact,wrappers} = wixEvent(body)
  const topContact = object(b.contact)
  const id = b.submissionId ?? b.submission_id ?? b.id ?? b._id ?? data.submissionId ?? data.submission_id ?? data.id ?? data._id ?? submission.submissionId ?? submission.submission_id ?? submission.id ?? submission._id ?? wrappers.map(wrapper=>wrapper.submissionId??wrapper.submission_id??wrapper.id??wrapper._id).find(value=>value!=null) ?? contact.submissionId ?? contact.submission_id ?? topContact.submissionId ?? topContact.submission_id
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
    urgency: customer.timing || '',
    requestedServices: wixRequestedServices(body),
    formAnswers: wixEvent(body).formAnswers,
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
