const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Run the complete production modules; expose private rendering state only in
// this offline harness so no browser, credentials or backend is needed.
function calendar() {
  let source = fs.readFileSync('job-calendar.js', 'utf8');
  source = source.replace('  root.TK_JOB_CALENDAR = {', `
    root.audit = {setState(value) { state = value; }, renderFallbackAgenda,
      setLoader(fn) { load = fn; }, setBookingModal(fn) { openBookingModal = fn; }};
    root.TK_JOB_CALENDAR = {`);
  const window = {};
  vm.runInNewContext(source, {window, document:{readyState:'loading',addEventListener(){}}, console, clearTimeout});
  return window;
}

test('opening an existing booking keeps its scheduled date unless a date is explicitly supplied', async () => {
  const win = calendar();
  win.TK_JOB_CALENDAR.configure({getBusinessId:()=> 'a',getUserId:()=> 'owner'});
  const state = {bizKey:'a:owner',canManage:true,jobs:[{id:'job'}]};
  win.audit.setState(state);
  win.audit.setLoader(async()=>{});
  let opened;
  win.audit.setBookingModal(value=>{opened=value;});
  await win.TK_JOB_CALENDAR.book('job');
  assert.equal(opened.dateISO, undefined, 'let the modal derive the date from the existing booking');
  await win.TK_JOB_CALENDAR.book('job','2026-11-20');
  assert.equal(opened.dateISO,'2026-11-20', 'an explicit reschedule date still takes precedence');
});

test('fallback agenda shows overnight work on every overlapping day, respecting midnight and staff filters', () => {
  const win = calendar();
  const state = {
    range:{fromISO:'2026-11-03',toISO:'2026-11-05'},search:'',staff:[],staffFilter:new Set(['crew']),
    jobs:[{id:'overnight',status:'scheduled',customer:{name:'Night wash'},details:{assignedStaffIds:['crew'],calendarStartAt:'2026-11-02T23:00:00',calendarEndAt:'2026-11-04T00:00:00'}}],
    blocks:[],events:[]
  };
  win.audit.setState(state);
  const zone = {innerHTML:'',querySelectorAll:()=>[]};
  win.audit.renderFallbackAgenda(zone);
  const days = zone.innerHTML.split('<div class="tkjc-agenda-day">');
  assert.match(days[1],/Night wash/, 'a job starting before the visible range is still shown');
  assert.doesNotMatch(days[2],/Night wash/, 'exclusive midnight end does not occupy the next day');
  state.jobs[0].details.calendarEndAt='2026-11-04T01:00:00';
  win.audit.renderFallbackAgenda(zone);
  assert.equal((zone.innerHTML.match(/Night wash/g)||[]).length,2);
  state.staffFilter=new Set(['other-crew']);
  win.audit.renderFallbackAgenda(zone);
  assert.doesNotMatch(zone.innerHTML,/Night wash/);
});

function operations(ready) {
  let calls=0;
  const context={businessId:'a',userId:'owner',version:1,role:'owner',ready};
  const window={addEventListener(){},removeEventListener(){},TK_SALES_PLATFORM:{async listServiceM8Jobs(){calls++;return {jobs:[]};}}};
  vm.runInNewContext(fs.readFileSync('operations-workspace.js','utf8'),{window});
  const api=window.TK_OPERATIONS.create({getContext:()=>context});
  return {api,context,calls:()=>calls};
}

test('completed jobs are not requested before business hydration or while signed out', async () => {
  const h=operations(false);
  h.api.open('completed');
  await Promise.resolve();
  assert.equal(h.calls(),0);
  h.context.ready=true;
  h.api.open('completed');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls(),1, 'business-ready context can load completed jobs');
  h.context.version++;
  h.context.userId=null;
  h.api.open('completed');
  await Promise.resolve();
  assert.equal(h.calls(),1, 'signed-out context must not initiate a read');
});
