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
const nameKeys = new Set(['name','fullname','contactname','yourname']);
const identityKeys = new Set(['name','fullname','contactname','yourname','firstname','lastname','email','emailaddress','phone','phonenumber','mobilenumber']);
const addressKeys = new Set(['address','streetaddress','propertyaddress','selectanaddress','jobaddress']);
const timingLabels = ['urgency','timing','timeframe','How urgent is your request?',
  'How soon do you need this done?','How soon do you need it done?',
  'When do you need this done?','When do you need it done?',
  'When would you like this done?','When would you like the work done?'];
const windowLabels = ['Select Window Cleaning Type','Window Cleaning Type','windowType'];
for(const label of [...timingLabels,...windowLabels])flatAnswerKeys.add(labelKey(label));

function structuredAnswer(value, key) {
  if(nameKeys.has(key))return [text(value.first)||text(value.firstName)||text(value.first_name),
    text(value.last)||text(value.lastName)||text(value.last_name)].filter(Boolean).join(' ');
  if(!addressKeys.has(key))return '';
  const street=object(value.streetAddress);
  return text(value.formatted)||text(value.formattedAddress)||[
    text(value.addressLine)||text(value.addressLine1)||text(value.address_line)||text(value.streetAddress)||
      [text(value.streetNumber)||text(street.number),text(value.streetName)||text(street.name)].filter(Boolean).join(' '),
    text(value.addressLine2)||text(value.address_line_2),text(value.city),text(value.subdivision),
    text(value.postalCode)||text(value.postal_code),text(value.country)
  ].filter(Boolean).join(', ');
}

// A field envelope's label describes the question; an option's label describes
// the selected choice. Keep that distinction through nested value/answer wrappers.
function decodeAnswer(value, question, submitted=false, depth=0) {
  if(depth>5)return [];
  if(Array.isArray(value))return value.slice(0,100).flatMap(item=>Array.isArray(item)?[]:decodeAnswer(item,question,submitted,depth+1)).slice(0,100);
  if(typeof value==='string')return text(value)?[text(value)]:[];
  if(submitted&&typeof value==='boolean')return [value?'Checked':'Unchecked'];
  if(submitted&&typeof value==='number'&&Number.isFinite(value))return [String(value)];
  const answer=object(value),key=labelKey(question),label=text(answer.label);
  if(answer.selected===false||answer.checked===false)return [];
  const questionLabel=labelKey(label)===key||flatAnswerKeys.has(labelKey(label));
  const choiceLabel=label&&!questionLabel;
  if('values' in answer)return decodeAnswer(answer.values,question,submitted,depth+1);
  if('value' in answer){
    if(typeof answer.value==='boolean')return choiceLabel&&!identityKeys.has(key)&&!addressKeys.has(key)?(answer.value?[label]:[]):decodeAnswer(answer.value,question,submitted,depth+1);
    // Identity/address labels can never replace their actual submitted values.
    if(choiceLabel&&!identityKeys.has(key)&&!addressKeys.has(key))return [label];
    return decodeAnswer(answer.value,question,submitted,depth+1);
  }
  if('answer' in answer)return decodeAnswer(answer.answer,question,submitted,depth+1);
  const structured=structuredAnswer(answer,key);
  if(structured)return [structured];
  return choiceLabel&&!identityKeys.has(key)&&!addressKeys.has(key)?[label]:[];
}
const answerValues = (value, question) => decodeAnswer(value, question);
const submittedValues = (value, question) => decodeAnswer(value, question, true);
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
        const fieldLabel=text(field.label)||text(field.name);
        return fieldLabel&&(!flatAnswerKeys.has(labelKey(key))||flatAnswerKeys.has(labelKey(fieldLabel)))?field:{label:key,value};
      });
      for(const field of entries){
        remaining--;
        const label=text(field?.label||field?.name||field?.key);
        const key=labelKey(field?.label||field?.name||field?.key);
        const raw=field?.value??field?.values??field?.answer;
        const values=answerValues(raw,label);
        if(key&&key.length<=120&&values.length)labels[key]=[...(labels[key]||[]),...values].slice(0,100);
        const answers=submittedValues(raw,label);
        if(key&&key.length<=120&&!internalAnswerKey(key)&&answers.length)formAnswers.push({label,answer:answers.join(', ').slice(0,4000)});
      }
    }
  }
  for(const wrapper of new Set([...wrappers,contact])){
    for(const [label,value] of Object.entries(wrapper).slice(0,100)){
      if(remaining<=0)break;
      const key=labelKey(label);
      // Preserve the existing canonical full-name answer for Wix contact.name.
      if(wrapper===contact&&key==='name'&&structuredAnswer(object(value),key))continue;
      if((!flatAnswerKeys.has(key)&&!/^(iagree|consent|subscribe|acceptterms)/.test(key))||internalAnswerKey(key))continue;
      const answers=submittedValues(value,label);
      if(!answers.length)continue;
      remaining--;
      formAnswers.push({label,answer:answers.join(', ').slice(0,4000)});
    }
  }
  const person=object(contact.name);
  if(!formAnswers.some(({label})=>['name','fullname','contactname','firstname','lastname'].includes(labelKey(label)))){
    const fullName=structuredAnswer(person,'name');
    if(fullName&&remaining>0)formAnswers.push({label:'Full name',answer:fullName});
  }
  return {b,data,submission,contact,labels,wrappers,formAnswers};
}
export function mapWixPayload(body) {
  const {contact,labels,wrappers}=wixEvent(body);
  const fieldFrom=(includeContact,...names)=>{
    for(const n of names){
      for(const wrapper of wrappers){
        const value=wrapper[n]??Object.entries(wrapper).find(([key])=>labelKey(key)===labelKey(n))?.[1];
        // Bare arrays are selections, not scalar customer identity fields.
        const answer=Array.isArray(value)?'':answerValues(value,n).join(', ');
        if(answer)return answer;
      }
      const answer=labels[labelKey(n)]?.join(', ');
      if(answer)return answer;
    }
    // Submitted form fields take precedence over the mapped contact snapshot.
    for(const n of includeContact?names:[]){
      const value=contact[n]??Object.entries(contact).find(([key])=>labelKey(key)===labelKey(n))?.[1];
      const answer=Array.isArray(value)?'':answerValues(value,n).join(', ');
      if(answer)return answer;
    }
    return '';
  };
  const field=(...names)=>fieldFrom(true,...names);
  const fullNames=['name','fullName','full_name','contactName','Full name','Your name'];
  const firstNames=['firstName','first_name','First name'],lastNames=['lastName','last_name','Last name'];
  const name=fieldFrom(false,...fullNames)||
    [fieldFrom(false,...firstNames),fieldFrom(false,...lastNames)].filter(Boolean).join(' ')||
    field(...fullNames)||[field(...firstNames),field(...lastNames)].filter(Boolean).join(' ');
  const timing=field(...timingLabels);
  return {
    name,
    email:field('email','emailAddress','email_address','Email address')||undefined,
    phone:field('phone','phoneNumber','phone_number','Phone number','Mobile number')||undefined,
    address:field('address','streetAddress','street_address','Property address','Select an Address','Job Address')||undefined,
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
      for(const answer of answerValues(value,key)){
        services.push(...answer.split(/[,;\n]+/).map(value=>value.trim().slice(0,500)).filter(Boolean).slice(0,100-services.length));
        if(services.length>=100)return services;
      }
    }
  }
  if(!services.length){
    const {formAnswers}=wixEvent(body);
    const windowType=formAnswers.find(({label})=>windowLabels.some(name=>labelKey(label)===labelKey(name)))?.answer;
    const windowServices={both:'Window Clean (Inside & Outside)',insideoutside:'Window Clean (Inside & Outside)',
      insideandoutside:'Window Clean (Inside & Outside)',outsideonly:'Window Clean (Outside Only)',insideonly:'Window Clean (Inside Only)'};
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
  const {b,submission,contact,wrappers} = wixEvent(body)
  const topContact = object(b.contact)
  const validId = value => (typeof value==='string'||typeof value==='number')&&String(value).trim();
  const id = wrappers.flatMap(wrapper=>[wrapper.submissionId,wrapper.submission_id]).find(validId) ??
    [submission.id,submission._id].find(validId) ??
    [contact.submissionId,contact.submission_id,topContact.submissionId,topContact.submission_id].find(validId) ??
    wrappers.flatMap(wrapper=>[wrapper.id,wrapper._id]).find(validId)
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
