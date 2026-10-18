const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleSource = fs.readFileSync(path.join(__dirname,'../operations-workspace.js'),'utf8');
const crm = fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
function functionSource(name) {
  const start = crm.indexOf('function '+name+'(');
  assert.ok(start >= 0,name+' exists in CRM');
  // All selected CRM helpers end at an unindented closing brace.
  const end = crm.indexOf('\n}',start)+2;
  return crm.slice(start,end);
}
function harness() {
  const noop = ()=>{};
  const win = {addEventListener:noop,removeEventListener:noop};
  vm.runInNewContext(moduleSource,{window:win});
  return win.TK_OPERATIONS;
}
test('module is inert until explicitly installed; isolated configurable instances',()=>{
  const api = harness();
  const a = api.create({}), b = api.create({});
  assert.notEqual(a,b);
  assert.equal(typeof a.install,'function');
  assert.doesNotThrow(()=>{a.reset();a.destroy();api.reset();api.destroy();});
});
test('canonical payment helpers retain real ledger semantics',()=>{
  const ctx = {todayISO:()=> '2026-10-18'};
  vm.createContext(ctx);
  // paymentsTotal is a single-line function.
  vm.runInContext(crm.match(/function paymentsTotal\(r\)\{[^\n]+/)[0]+'\n'+crm.match(/function paymentBalance\(r\)\{[^\n]+/)[0]+'\n'+functionSource('invoiceDisplayStatus'),ctx);
  const r = {stage:'completed',total:400,payments:[{amount:150}],paymentStatus:'sent',dueDate:'2026-10-01'};
  assert.equal(ctx.paymentBalance(r),250);
  assert.equal(ctx.invoiceDisplayStatus(r),'partial');
  r.payments=[];assert.equal(ctx.invoiceDisplayStatus(r),'overdue');
  r.stage='paid';assert.equal(ctx.invoiceDisplayStatus(r),'paid');
});
module.exports = {functionSource};
