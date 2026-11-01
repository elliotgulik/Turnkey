const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const window={TK_LEAD_ANSWERS:require('../lead-answer-utils.js')};
vm.runInNewContext(fs.readFileSync('lead-request-view.js','utf8'),{window});
const view=window.TK_LEAD_REQUEST;
test('original written requests remain visible separately from upstream pricing and supplier selections',()=>{
  const record={source:'Meta',notes:'list_cleaning_services_below_(house,_roof,_windows): House windows and garage outside, 2 levels',requestedServices:['Supplier roof treatment'],serviceM8Pricing:{items:[],total:null},total:500};
  const before=JSON.stringify(record);
  assert.deepEqual(Array.from(view.requests(record)),['House windows and garage outside, 2 levels']);
  assert.match(view.render(record),/Customer requested/);
  assert.doesNotMatch(view.render(record),/Supplier roof/);
  assert.equal(JSON.stringify(record),before);
});
test('Wix prose, structured selections and missing answers are displayed honestly',()=>{
  assert.deepEqual(Array.from(view.requests({source:'Wix',notes:'Please wash my house and clean the windows · Submitted via online quote tool'})),['Please wash my house and clean the windows']);
  assert.deepEqual(Array.from(view.requests({requestedServices:[{name:'Windows'},'House wash']})),['Windows','House wash']);
  assert.equal(view.render({source:'Meta',notes:'urgency: next_week'}),'');
  assert.equal(view.render({source:'ServiceM8',requestedServices:['Imported item']}),'');
});
test('customer text is escaped without changing its meaning or quote amounts',()=>{
  const html=view.render({notes:'services: <img src=x onerror=alert(1)> & windows'});
  assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.match(html,/&amp;/);
});
