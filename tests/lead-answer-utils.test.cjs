const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const U = require('../lead-answer-utils.js');
const question = 'list_cleaning_services_below_(house,_roof,_windows_[outside_or_inside?],_driveway,_patio,_deck,_fence,_solar_panels';
const request = answer => ({ label:'Customer request', answer, kind:'service' });

test('actual Meta full question including commas yields the written answer, never choices', () => {
  const answer = 'House, outside windows, 2 level home';
  assert.deepEqual(U.answersFromNotes(`${question}: ${answer}`), [request(answer)]);
  assert.deepEqual(U.servicesFromNotes(`${question}: ${answer}`), [answer]);
  assert.deepEqual(U.answersFromNotes(`${question}:\nurgency: soon`), [
    {label:'Urgency',answer:'soon',kind:'context'},
  ]);
  assert.deepEqual(U.servicesFromNotes(`${question}:`), []);
});

test('actual Wix natural request stays whole and excludes the booking provenance suffix', () => {
  const answer = 'Just settled in our villa in Grey Lynn. Needs an exterior wash and your opinion on a roof clean, 2 level home.';
  assert.deepEqual(U.answersFromNotes(answer + ' · Submitted via online quote tool'), [request(answer)]);
  assert.deepEqual(U.servicesFromNotes('Please call me tomorrow · Submitted via online quote tool'), []);
});

test('service aliases handle full questions and keep each original value intact', () => {
  for (const key of ['services','service','requested_service','requestedServices','Services required',
    'Select services required','What services do you require?', 'What services do you need?',
    'what_would_you_like_cleaned',question]) {
    const answer = 'House wash, roof clean, please inspect the gutters';
    assert.deepEqual(U.servicesFromNotes(`${key}: ${answer}`), [answer], key);
    assert.deepEqual(U.servicesFromFields([{name:key,values:[answer,'outside_windows']}]), [answer,'outside_windows'], key);
  }
});

test('structured checkbox entries remain separate only when originally separate', () => {
  assert.deepEqual(U.servicesFromFields({ services:['House wash','Roof clean'] }), ['House wash','Roof clean']);
  assert.deepEqual(U.servicesFromFields({ services:'House wash, Roof clean' }), ['House wash, Roof clean']);
  assert.deepEqual(U.servicesFromFields({ services:['House wash, Roof clean'] }), ['House wash, Roof clean']);
  assert.deepEqual(U.servicesFromNotes('Services requested: House wash, Roof clean.'), ['House wash, Roof clean.']);
});

test('message aliases require service language in the answer rather than question text', () => {
  for (const key of ['message','job_details','additional_info','additional_information','comments','notes']) {
    assert.deepEqual(U.answersFromFields({[key]:'Please clean the driveway, then call me.'}), [request('Please clean the driveway, then call me.')]);
    assert.deepEqual(U.servicesFromFields({[key]:'Call after 5, 2 level home'}), []);
    assert.deepEqual(U.servicesFromFields({[key]:'Please check my clean credit record'}), []);
  }
  assert.deepEqual(U.servicesFromNotes('Would you like a roof wash, house wash or driveway clean?: Call me'), []);
});

test('multiline answers preserve punctuation, blanks, embedded colons and original underscores', () => {
  const answer = 'House wash, outside_windows\nPlease check the roof too.\n\n10:30 works for access.\nhttps://example.test/photo';
  const notes = `${question}: ${answer}\nbest_time_to_call: Afternoon`;
  assert.deepEqual(U.answersFromNotes(notes), [request(answer), {label:'Best time to call',answer:'Afternoon',kind:'context'}]);
  assert.deepEqual(U.servicesFromFields({requested_service:answer}), [answer]);
});

test('an answer on the next line and CRLF notes are supported', () => {
  assert.deepEqual(U.answersFromNotes('what_would_you_like_cleaned:\r\nHouse, roof\r\nnumber_of_storeys: 0'), [
    request('House, roof'), {label:'Number of storeys',answer:'0',kind:'context'},
  ]);
});

test('unknown custom answers remain context with humanized labels and zeros survive', () => {
  assert.deepEqual(U.answersFromFields([
    {name:'your_custom_question',values:['0',0,'Something unusual, leave it as written']},
    {name:'bestTimeToCall',values:['after_work']},
    {name:'residential_or_commercial',values:['residential']},
  ]), [
    {label:'Your custom question',answer:'0',kind:'context'},
    {label:'Your custom question',answer:'0',kind:'context'},
    {label:'Your custom question',answer:'Something unusual, leave it as written',kind:'context'},
    {label:'Best Time To Call',answer:'after_work',kind:'context'},
    {label:'Residential or commercial',answer:'residential',kind:'context'},
  ]);
  assert.deepEqual(U.servicesFromNotes('number_of_storeys: 0\nurgency: within_the_next_2_weeks'), []);
});

test('escaped strings stay raw data; no HTML decoding, escape decoding or execution', () => {
  const answer = 'Roof clean, "outside" & <script>globalThis.pwned=1</script> \\n \\path';
  assert.deepEqual(U.servicesFromFields({message:answer}), [answer]);
  assert.deepEqual(U.servicesFromNotes(`message: ${answer}`), [answer]);
  assert.equal(globalThis.pwned, undefined);
});

test('invalid values never become invented answers or object coercions', () => {
  assert.deepEqual(U.answersFromFields(null), []);
  assert.deepEqual(U.answersFromNotes({notes:'services: House wash'}), []);
  assert.deepEqual(U.answersFromFields([{name:'services',values:[null,undefined,{},[],false,NaN,Infinity,'','  ']}]), []);
  assert.deepEqual(U.answersFromFields([{name:'service',values:[0]}]), [request('0')]);
  for (const value of [null,undefined,'','   ']) assert.deepEqual(U.answersFromNotes(value), []);
});

test('helper is pure and does not mutate frozen Meta inputs', () => {
  const values = Object.freeze(['House wash, 2 level home']);
  const fields = Object.freeze([Object.freeze({name:question,values})]);
  assert.deepEqual(U.answersFromFields(fields), [request(values[0])]);
  assert.deepEqual(values, ['House wash, 2 level home']);
});

test('same API loads as browser UMD and backend ESM default import', async () => {
  const context = {window:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../lead-answer-utils.js'),'utf8'),context);
  assert.deepEqual(Array.from(context.window.TK_LEAD_ANSWERS.servicesFromNotes('service: House, roof')), ['House, roof']);
  const backend = await import(pathToFileURL(require.resolve('../lead-answer-utils.js')).href);
  assert.deepEqual(backend.default.servicesFromNotes('service: House, roof'), ['House, roof']);
});


test('standalone exact booking provenance is hidden without rewriting written answers', () => {
  const provenance = 'Submitted via online quote tool';
  assert.deepEqual(U.answersFromNotes(provenance), []);
  assert.deepEqual(U.answersFromNotes(`  ${provenance}  `), []);
  const answer = 'Exterior wash, roof clean, 2 level home.';
  assert.deepEqual(U.answersFromNotes(`${answer}\n${provenance}`), [request(answer)]);
  assert.deepEqual(U.answersFromNotes(`${provenance}\r\nmessage: ${answer}`), [request(answer)]);
  const quoted = 'Please roof clean, keep the note "Submitted via online quote tool" as written.';
  assert.deepEqual(U.answersFromNotes(quoted), [request(quoted)]);
  assert.deepEqual(U.answersFromNotes(`message: ${provenance}`), [
    {label:'Message',answer:provenance,kind:'context'},
  ]);
  assert.deepEqual(U.servicesFromFields({service:answer}), [answer]);
});


test('written Wix requests for window quotes or moss removal remain readable whole answers',()=>{
  const reader=require('../lead-answer-utils.js');
  for(const answer of ['Hi, house would be lower floor only. interested in quote on both window options, would like glass balustrade included.', 'Moss removal on roof please']){
    assert.deepEqual(reader.servicesFromNotes(answer+' · Submitted via online quote tool'),[answer]);
  }
});

test('complete Wix submission keeps context, checkboxes and exact labels separate from service choices',()=>{
  const rows=U.answersFromSubmission([
    {label:'Select Services',answer:'House Clean, Roof Treatment'},
    {label:'Message',answer:'Please wash the house and inspect the roof.'},
    {label:"How’d you find us",answer:'Instagram'},
    {label:'Cleaning Frequency',answer:'Every 4 Months'},
    {label:'I agree to the terms & conditions',answer:true},
    {label:'Other consent',answer:false}
  ]);
  assert.equal(rows.length,6);
  assert.equal(rows[0].kind,'service');assert.equal(rows[1].kind,'context');
  assert.equal(rows[4].answer,'Checked');assert.equal(rows[5].answer,'Unchecked');
  assert.equal(rows[3].answer,'Every 4 Months');
});
