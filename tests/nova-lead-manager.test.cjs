const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function manager() {
  const context = {
    records: [],
    currentBusinessId: 'test-business',
    render() {}, switchView() {}, handleAuthedSession() {}, openMoreSheet() {},
    document: { addEventListener() {}, querySelector() { return null; }, getElementById(id) { return id === 'view-leads' ? { classList: { contains() { return false; } }, innerHTML: '' } : null; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    window: { TK_LEADS: { value() { return null; } }, TK_PIPELINE: { key(r) { return r.stage; } } },
  };
  vm.runInNewContext(fs.readFileSync('nova-lead-manager.js', 'utf8'), context);
  return context.window.TK_NOVA_LEAD_MANAGER;
}

test('lead manager uses the export grading priorities with safe review for missing data', () => {
  const leadManager = manager();
  assert.equal(leadManager.grade({ urgency: 'ASAP' }).grade, 'A');
  assert.equal(leadManager.grade({ propertyType: 'commercial' }).grade, 'A');
  assert.equal(leadManager.grade({ address: '7 Beach Road, Forrest Hill, Auckland', services: [{ label: 'House wash' }, { label: 'Windows' }] }).grade, 'A');
  assert.equal(leadManager.grade({ address: '7 Beach Road, Forrest Hill, Auckland', services: [{ label: 'House wash' }] }).grade, 'B');
  assert.equal(leadManager.grade({ address: '1 Example Street, South Auckland', suburb: 'Manurewa', services: [{ label: 'Driveway' }] }).grade, 'C');
  assert.equal(leadManager.grade({}).grade, 'Review');
});

test('service area preferences are isolated by TurnKey business ID', () => {
  const store = new Map();
  const context = {
    records: [], currentBusinessId: 'biz-a', render() {}, switchView() {}, handleAuthedSession() {}, openMoreSheet() {},
    document: { addEventListener() {}, querySelector() { return null; }, getElementById(id) { return id === 'view-leads' ? { classList: { contains() { return false; } }, innerHTML: '' } : null; } },
    localStorage: { getItem(k) { return store.get(k) ?? null; }, setItem(k,v) { store.set(k,v); } },
    window: { TK_LEADS: { value() { return null; } }, TK_PIPELINE: { key(r) { return r.stage; } } },
  };
  vm.runInNewContext(fs.readFileSync('nova-lead-manager.js', 'utf8'), context);
  context.window.TK_NOVA_LEAD_MANAGER.setConfig({ suburbs: ['Whangaparaoa'], postcodes: ['0932'] });
  assert.equal(context.window.TK_NOVA_LEAD_MANAGER.grade({ address: '2 Test Road, Whangaparaoa, Auckland', services: ['House wash'] }).grade, 'B');
  context.currentBusinessId = 'biz-b';
  context.window.TK_NOVA_LEAD_MANAGER.render();
  assert.equal(context.window.TK_NOVA_LEAD_MANAGER.grade({ address: '2 Test Road, Whangaparaoa, Auckland', suburb:'Whangaparaoa', services: ['House wash'] }).grade, 'C');
});

function statusFixture() {
  const host = { innerHTML: '', classList: { contains() { return true; } } };
  const handlers = {};
  const records = ['new', 'scheduled', 'won', 'completed', 'paid', 'cancelled', 'lost'].map((stage, id) => ({
    id, stage, name: `Customer ${id}`, source: 'ServiceM8', total: 100,
    nextFollowUpAt: new Date(Date.now() - 86400000).toISOString(),
  }));
  const context = {
    records, money: n => '$' + n, currentBusinessId: 'test',
    render() {}, switchView() {}, handleAuthedSession() {}, openMoreSheet() {},
    document: { activeElement: null, addEventListener(k, fn) { handlers[k] = fn; }, querySelector() { return null; }, getElementById() { return host; } },
    localStorage: { getItem() { return null; }, setItem() {} },
    window: { TK_PIPELINE: require('../pipeline-model.js') },
  };
  vm.runInNewContext(fs.readFileSync('nova-lead-manager.js', 'utf8'), context);
  const manager = context.window.TK_NOVA_LEAD_MANAGER;
  return { host, records, manager,
    scope(key) { handlers.click({ target: { closest(selector) { return selector === '[data-nlm-scope]' ? { dataset: { nlmScope: key } } : null; } } }); },
  };
}

test('production lead manager separates completed and paid from confirmed and open', () => {
  const f = statusFixture();
  const ids = () => [...f.host.innerHTML.matchAll(/data-nlm-record="(\d+)"/g)].map(m => Number(m[1]));
  f.manager.render();
  assert.deepEqual(ids(), [0]);
  f.scope('won');
  assert.deepEqual(ids(), [1,2]);
  assert.match(f.host.innerHTML, /class="nlm-tag stage">Confirmed</);
  f.scope('completed');
  assert.deepEqual(ids(), [3,4]);
  assert.equal((f.host.innerHTML.match(/class="nlm-tag stage">Completed</g) || []).length, 2);
  assert.doesNotMatch(f.host.innerHTML, /class="nlm-tag stage">Confirmed</);
  assert.match(f.host.innerHTML, /data-nlm-stage="3" disabled/);
  assert.doesNotMatch(f.host.innerHTML, /nlm-follow overdue/);
  f.scope('lost');
  assert.deepEqual(ids(), [5,6]);
  f.scope('all');
  assert.deepEqual(ids(), [0,1,2,3,4,5,6]);
  assert.deepEqual(f.records.map(r => r.stage), ['new','scheduled','won','completed','paid','cancelled','lost']);
  assert.deepEqual(f.records.slice(3,5).map(r => require('../sales-metrics.js').won(r)), [true,true]);
  f.manager.reset(); f.manager.render();
  assert.deepEqual(ids(), [0]);
});

test('lead cards show received date and exact Auckland time from the original submission', () => {
  const f = statusFixture();
  f.records[0].requestSubmittedAt = '2026-10-31T23:04:05Z';
  f.records[0].createdAt = '2026-11-01T01:00:00Z';
  f.manager.render();
  assert.match(f.host.innerHTML, /Received 1 Nov 2026, 12:04:05 pm NZDT/);
  f.records[0].requestSubmittedAt = 'invalid';
  f.manager.render();
  assert.match(f.host.innerHTML, /Received 1 Nov 2026, 2:00:00 pm NZDT/);
  delete f.records[0].createdAt;
  f.manager.render();
  assert.match(f.host.innerHTML, /Received Date not recorded/);
});

test('Meta poll answers stay separate from services and encoded questions are not split at commas', () => {
  const leadManager = manager();
  const record = {source:'Meta',notes:'residential_or_commercial: residential\nurgency: within_the_next_2_weeks\nlist_cleaning_services_below_(house,_roof,_windows_[outside_or_inside?]): house_wash, roof_treatment, windows_outside · Submitted via online quote tool'};
  assert.deepEqual(Array.from(leadManager.services(record)), ['house wash','roof treatment','windows outside']);
  const answers = Array.from(leadManager.formAnswers(record), x=>({kind:x.kind,label:x.label,answer:x.answer}));
  assert.deepEqual(answers.slice(0,2), [
    {kind:'property',label:'Property type',answer:'residential'},
    {kind:'timing',label:'Preferred timing',answer:'within the next 2 weeks'},
  ]);
  assert.deepEqual(Array.from(leadManager.services({source:'Meta',notes:'urgency: within_the_next_2_weeks'})), []);
  assert.deepEqual(Array.from(leadManager.services({requestedServices:[{name:'House wash',service_id:'housewash'}]})), ['House wash']);
});

test('saved Meta services are available to Pipeline and quote details through the shared accessor', () => {
  const source=fs.readFileSync('index.html','utf8');
  const start=source.indexOf('function extractServicesFromNotes(notes){');
  const end=source.indexOf('// The one accessor',start);
  const context={labelToServiceId:()=>null};
  vm.runInNewContext(source.slice(start,end),context);
  const notes='residential_or_commercial: residential\nlist_cleaning_services_below_(house,_roof,_windows_[outside_or_inside?],_driveway,_patio,_deck,_fence,_solar_panels: House,windows · Submitted via online quote tool';
  assert.deepEqual(Array.from(context.extractServicesFromNotes(notes),x=>x.name),['House','windows']);
  assert.deepEqual(Array.from(manager().services({notes:'Follow up: tomorrow',jobNotes:notes})),['House','windows']);
  assert.deepEqual(Array.from(manager().services({source:'Wix',notes:'Please call me tomorrow'})),[]);
});
