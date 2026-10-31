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
