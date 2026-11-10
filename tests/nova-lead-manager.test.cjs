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
  context.window.TK_LEAD_ANSWERS = require('../lead-answer-utils.js');
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
  context.window.TK_LEAD_ANSWERS = require('../lead-answer-utils.js');
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
  const store = new Map();
  const records = ['new', 'scheduled', 'won', 'completed', 'paid', 'cancelled', 'lost'].map((stage, id) => ({
    id, stage, name: `Customer ${id}`, source: 'ServiceM8', total: 100,
    nextFollowUpAt: new Date(Date.now() - 86400000).toISOString(),
  }));
  const context = {
    records, money: n => '$' + n, currentBusinessId: 'test',
    render() {}, switchView() {}, handleAuthedSession() {}, openMoreSheet() {}, requestAnimationFrame() {},
    document: { activeElement: null, addEventListener(k, fn) { handlers[k] = fn; }, querySelector() { return null; }, getElementById(id) { return id === 'view-leads' ? host : null; } },
    localStorage: { getItem(k) { return store.get(k) ?? null; }, setItem(k,v) { store.set(k,v); } },
    window: { TK_PIPELINE: require('../pipeline-model.js') },
  };
  context.window.TK_LEAD_ANSWERS = require('../lead-answer-utils.js');
  vm.runInNewContext(fs.readFileSync('nova-lead-manager.js', 'utf8'), context);
  const manager = context.window.TK_NOVA_LEAD_MANAGER;
  return { host, records, manager, context, handlers,
    scope(key) { handlers.click({ target: { closest(selector) { return selector === '[data-nlm-scope]' ? { dataset: { nlmScope: key } } : null; } } }); },
  };
}

test('lead manager is a new-enquiry inbox and stage changes move records out without deleting them',()=>{
 const f=statusFixture(),ids=()=>[...f.host.innerHTML.matchAll(/data-nlm-record="(\d+)"/g)].map(m=>Number(m[1]));
 f.manager.render();assert.deepEqual(ids(),[0]);
 f.scope('all');assert.deepEqual(ids(),[0]);
 f.records[0].stage='contacted';f.manager.render();assert.deepEqual(ids(),[]);
 assert.equal(f.records.length,7);assert.equal(f.records[0].stage,'contacted');
 assert.doesNotMatch(f.host.innerHTML,/data-nlm-scope="won"/);
 f.records[0].stage='new';f.manager.render();assert.deepEqual(ids(),[0]);
});

test('lead cards show received date and exact Auckland time from the original submission', () => {
  const f = statusFixture();
  f.records[0].requestSubmittedAt = '2026-10-31T23:04:05Z';
  f.records[0].createdAt = '2026-11-01T01:00:00Z';
  f.manager.render();
  f.scope('all');
  assert.match(f.host.innerHTML, /1 Nov 2026, 12:04:05 pm NZDT/);
  f.records[0].requestSubmittedAt = 'invalid';
  f.manager.render();
  assert.match(f.host.innerHTML, /1 Nov 2026, 2:00:00 pm NZDT/);
  delete f.records[0].createdAt;
  f.manager.render();
  assert.match(f.host.innerHTML, /Date not recorded/);
});

test('Meta poll answers stay separate from services and encoded questions are not split at commas', () => {
  const leadManager = manager();
  const record = {source:'Meta',notes:'residential_or_commercial: residential\nurgency: within_the_next_2_weeks\nlist_cleaning_services_below_(house,_roof,_windows_[outside_or_inside?]): house_wash, roof_treatment, windows_outside · Submitted via online quote tool'};
  assert.deepEqual(Array.from(leadManager.services(record)), ['house wash, roof treatment, windows outside']);
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
  const end=source.indexOf('// Saved structured selections',start);
  const context={labelToServiceId:()=>null,window:{TK_LEAD_ANSWERS:require('../lead-answer-utils.js')}};
  vm.runInNewContext(source.slice(start,end),context);
  const notes='residential_or_commercial: residential\nlist_cleaning_services_below_(house,_roof,_windows_[outside_or_inside?],_driveway,_patio,_deck,_fence,_solar_panels: House,windows · Submitted via online quote tool';
  assert.deepEqual(Array.from(context.extractServicesFromNotes(notes),x=>x.name),['House,windows']);
  assert.deepEqual(Array.from(manager().services({notes:'Follow up: tomorrow',jobNotes:notes})),['House,windows']);
  assert.deepEqual(Array.from(manager().services({source:'Wix',notes:'Please call me tomorrow'})),[]);
});


test('new leads older than 72 hours stay under All while contacted leads belong only in pipeline',()=>{
 const f=statusFixture(),now=Date.now();
 f.records.splice(0,f.records.length,
  {id:1,name:'Recent new',stage:'new',createdAt:now-2*86400000},
  {id:2,name:'Older new',stage:'new',requestSubmittedAt:now-4*86400000,createdAt:now},
  {id:3,name:'Older contacted',stage:'contacted',createdAt:now-10*86400000},
  {id:4,name:'Unknown date',stage:'new'});
 const ids=()=>[...f.host.innerHTML.matchAll(/data-nlm-record="(\d+)"/g)].map(m=>Number(m[1])).sort();
 f.manager.render();assert.deepEqual(ids(),[1,4]);
 f.scope('new');assert.deepEqual(ids(),[1,4]);
 f.scope('all');assert.deepEqual(ids(),[1,2,4]);
 assert.equal(f.records[1].stage,'new');
});

test('lead alerts include only unresponded new enquiries younger than three days',()=>{
 const f=statusFixture(),now=Date.now();f.records.splice(0,f.records.length,
 {id:1,stage:'new',createdAt:now-1000},
 {id:2,stage:'new',createdAt:now-3*86400000},
 {id:3,stage:'new',createdAt:now-1000,firstResponseAt:now},
 {id:4,stage:'contacted',createdAt:now-1000},
 {id:5,stage:'new'},
 {id:6,stage:'new',createdAt:now,requestSubmittedAt:now-5*86400000},
 {id:7,stage:'new',createdAt:now-1000,quoteSentAt:now});
 assert.deepEqual(Array.from(f.manager.pendingLeads(now),r=>r.id),[1]);
 assert.equal(f.manager.pendingLeads(now+3*86400000).length,0);
 assert.equal(f.records.length,7);
});

test('full Wix answers remain visible and explicit services do not collapse into message text',()=>{
 const m=manager(),r={source:'Wix',requestedServices:['House Clean','Roof Treatment'],formAnswers:[{label:'Select Services',answer:'House Clean, Roof Treatment'},{label:'Message',answer:'Please clean the roof and house.'},{label:'Select Window Cleaning Type',answer:'Both'},{label:'Cleaning Frequency',answer:'Every 4 Months'},{label:'I agree to the',answer:'Checked'}]};
 assert.deepEqual(Array.from(m.services(r)),['House Clean','Roof Treatment']);
 assert.deepEqual(Array.from(m.formAnswers(r),row=>row.label),r.formAnswers.map(row=>row.label));
 assert.equal(m.formAnswers(r)[3].answer,'Every 4 Months');
});

function alertFixture() {
  const now = Date.now(), store = new Map(), handlers = {}, counts = {};
  const list = { innerHTML: '' }, overlay = { open: false, classList: { contains() { return overlay.open; } } };
  const records = [
    { id: 1, stage: 'new', createdAt: now - 1000 },
    { id: 2, stage: 'new', createdAt: now - 2000 },
    { id: 3, stage: 'new', createdAt: now - 3 * 86400000 },
    { id: 4, stage: 'new', createdAt: now - 1000, firstResponseAt: now },
    { id: 5, stage: 'contacted', createdAt: now - 1000 },
  ];
  for (const id of ['cnt-leads', 'lead-alert-count', '.nlm-alert-count', '.nlm-nav-count']) counts[id] = {};
  const context = {
    records, currentBusinessId: 'biz-a', currentUserId: 'user-a',
    render() {}, switchView() {}, handleAuthedSession() {}, openMoreSheet() {},
    openModal() { overlay.open = true; }, closeModal() { overlay.open = false; },
    document: {
      addEventListener(key, fn) { handlers[key] = fn; },
      querySelector(selector) { return counts[selector] || null; },
      getElementById(id) { return id === 'lead-alert-list' ? list : id === 'lead-alert-overlay' ? overlay : counts[id] || null; },
    },
    localStorage: { getItem(key) { return store.get(key) ?? null; }, setItem(key, value) { store.set(key, value); } },
    window: { TK_PIPELINE: require('../pipeline-model.js') },
  };
  vm.runInNewContext(fs.readFileSync('nova-lead-manager.js', 'utf8'), context);
  return {
    context, records, store, counts, list, overlay, manager: context.window.TK_NOVA_LEAD_MANAGER,
    ids() { return [...list.innerHTML.matchAll(/data-nlm="alert" data-id="(\d+)"/g)].map(m => Number(m[1])); },
    click(action, id) {
      handlers.click({ target: { closest(selector) { return selector === '[data-nlm]' ? { dataset: { nlm: action, id } } : null; } } });
    },
  };
}

test('opening the bell keeps unread alerts; opening one removes only that alert and updates all badges', () => {
  const f = alertFixture(), original = JSON.stringify(f.records);
  f.click('notifications');
  assert.deepEqual(f.ids(), [1, 2]);
  assert.equal(f.store.size, 0);
  assert.match(f.list.innerHTML, /data-nlm="clear-alerts">Clear all/);
  f.click('alert', '1');
  assert.equal(f.overlay.open, false);
  assert.deepEqual(f.ids(), [2]);
  for (const badge of Object.values(f.counts)) assert.equal(badge.textContent, '1');
  f.click('notifications');
  assert.deepEqual(f.ids(), [2]);
  assert.equal(JSON.stringify(f.records), original);
  f.manager.setRead(f.records[0], false);
  assert.deepEqual(f.ids(), [1, 2]);
});

test('clear all marks only current recent unread alerts, preserves records and read markers, and allows new arrivals', () => {
  const f = alertFixture(), original = JSON.stringify(f.records);
  f.manager.setRead(f.records[2], true);
  const key = [...f.store.keys()][0], previous = JSON.parse(f.store.get(key));
  f.click('notifications');
  f.click('clear-alerts');
  assert.deepEqual(f.ids(), []);
  assert.match(f.list.innerHTML, /No new leads/);
  assert.doesNotMatch(f.list.innerHTML, /data-nlm="clear-alerts"/);
  for (const badge of Object.values(f.counts)) assert.equal(badge.textContent, '0');
  assert.equal(f.counts['lead-alert-count'].hidden, true);
  const saved = JSON.parse(f.store.get(key));
  assert.equal(Object.keys(saved).length, 3);
  for (const [id, at] of Object.entries(previous)) assert.equal(saved[id], at);
  assert.equal(f.manager.isRead(f.records[3]), false);
  assert.equal(f.manager.isRead(f.records[4]), false);
  assert.equal(JSON.stringify(f.records), original);
  f.records.push({ id: 6, stage: 'new', createdAt: Date.now() - 1 });
  f.click('notifications');
  assert.deepEqual(f.ids(), [6]);
  assert.equal(f.manager.pendingLeads(Date.now() + 3 * 86400000).length, 0);
});

test('cleared alerts stay isolated by user and business and mark unread restores an alert', () => {
  const f = alertFixture();
  f.click('notifications');
  f.click('clear-alerts');
  f.context.currentUserId = 'user-b';
  f.click('notifications');
  assert.deepEqual(f.ids(), [1, 2]);
  f.context.currentUserId = 'user-a';
  f.context.currentBusinessId = 'biz-b';
  f.click('notifications');
  assert.deepEqual(f.ids(), [1, 2]);
  f.context.currentBusinessId = 'biz-a';
  f.click('notifications');
  assert.deepEqual(f.ids(), []);
  f.manager.setRead(f.records[0], false);
  assert.deepEqual(f.ids(), [1]);
  f.click('clear-alerts');
  assert.deepEqual(f.ids(), []);
});


test('switching companies clears lead filters and company-specific dialogs before filtering', () => {
  const f = statusFixture();
  const click = (action, id) => f.handlers.click({ target: { closest(selector) {
    return selector === '[data-nlm]' ? { dataset: { nlm: action, id } } : null;
  } } });
  f.manager.render();
  f.handlers.change({ target: { matches: s => s === '[data-nlm-filter]', dataset: { nlmFilter: 'source' }, value: 'ServiceM8' } });
  click('detail', '0');
  click('area');
  assert.match(f.host.innerHTML, /nlm-record-panel/);
  assert.match(f.host.innerHTML, /nlm-area-dialog/);
  f.context.currentBusinessId = 'another-company';
  // Reused local IDs must not reopen a different company's customer drawer.
  f.records.splice(0, f.records.length, { id: 0, stage: 'new', source: 'Wix', name: 'Company B enquiry' });
  f.manager.render();
  assert.match(f.host.innerHTML, /data-nlm-record="0"/);
  assert.doesNotMatch(f.host.innerHTML, /nlm-record-panel|nlm-area-dialog/);
  assert.match(f.host.innerHTML, /data-nlm-scope="open" aria-pressed="true"/);
  // Ordinary rerenders in the same company must still preserve filters.
  f.handlers.change({ target: { matches: s => s === '[data-nlm-filter]', dataset: { nlmFilter: 'source' }, value: 'ServiceM8' } });
  f.manager.render();
  assert.doesNotMatch(f.host.innerHTML, /data-nlm-record="0"/);
});

test('commercial intake answers receive the commercial grade and match its filter', () => {
  const m = manager();
  for (const record of [
    { notes: 'residential_or_commercial: commercial' },
    { formAnswers: [{ label: 'Property Type', answer: 'body_corporate' }] },
    { formAnswers: [{ label: 'Residential or Commercial', answer: 'Commercial' }] },
  ]) assert.equal(m.grade(record).grade, 'A');
  assert.equal(m.grade({ formAnswers: [{ label: 'Message', answer: 'Call after business hours' }] }).grade, 'Review');
  assert.equal(m.grade({ formAnswers: [{ label: 'Property Type', answer: 'Residential' }] }).grade, 'Review');
  const f = statusFixture();
  f.records.splice(0, f.records.length, { id: 1, stage: 'new', formAnswers: [{ label: 'Property Type', answer: 'Commercial' }] });
  f.handlers.change({ target: { matches: s => s === '[data-nlm-filter]', dataset: { nlmFilter: 'grade' }, value: 'A' } });
  assert.match(f.host.innerHTML, /data-nlm-record="1"/);
});

test('personal dashboard defaults to own assignments and resets on another company member signing in',()=>{
 const f=statusFixture();
 f.context.currentUserId='elliot';
 f.context.window.TK_CURRENT_SESSION={user:{id:'elliot',email:'elliot@example.test',user_metadata:{full_name:'Elliot Gulik'}}};
 f.context.window.TK_SALES_PLATFORM={salespeople:()=>[
  {id:'elliot',name:'Elliot Gulik',aliases:['elliot','servicem8:elliot']},
  {id:'luca',name:'Luca Anderson',aliases:['luca','servicem8:luca']}
 ]};
 f.records.splice(0,f.records.length,
  {id:11,stage:'new',name:'Elliot customer',assignedSalespersonId:'servicem8:elliot'},
  {id:12,stage:'new',name:'Luca customer',assignedSalespersonId:'luca'},
  {id:13,stage:'new',name:'Unassigned customer'},
  {id:14,stage:'new',name:'Different person',assignedSalespersonId:'different-elliot',salespersonName:'Elliot Gulik'});
 const ids=()=>[...f.host.innerHTML.matchAll(/data-nlm-record="(\d+)"/g)].map(m=>Number(m[1]));
 const owner=key=>f.handlers.click({target:{closest:selector=>selector==='[data-nlm-owner]'?{dataset:{nlmOwner:key}}:null}});
 f.manager.render();assert.match(f.host.innerHTML,/Elliot’s Leads Dashboard/);assert.deepEqual(ids(),[11]);
 owner('unassigned');assert.deepEqual(ids(),[13]);
 owner('');assert.equal(ids().length,4);
 f.context.currentUserId='luca';
 f.context.window.TK_CURRENT_SESSION={user:{id:'luca',email:'luca@example.test',user_metadata:{full_name:'Luca Anderson'}}};
 f.manager.render();assert.match(f.host.innerHTML,/Luca’s Leads Dashboard/);assert.deepEqual(ids(),[12]);
});

test('recent unread leads are NEW; older unread leads are UNREAD; opened leads hide their badge',()=>{
 const f=statusFixture();f.records[0].createdAt=Date.now();f.manager.render();
 assert.match(f.host.innerHTML,/class="nlm-new" >NEW</);
 f.records[0].createdAt=Date.now()-5*86400000;f.scope('all');
 assert.match(f.host.innerHTML,/class="nlm-new" >UNREAD</);
 f.manager.setRead(f.records[0],true);f.manager.render();
 assert.match(f.host.innerHTML,/class="nlm-new" hidden>UNREAD</);
 assert.match(require('node:fs').readFileSync('reference-leads.css','utf8'),/\.nlm-new\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});
