const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function portal(){const c={window:{},document:{readyState:'loading',addEventListener(){}},Date,console};vm.runInNewContext(fs.readFileSync('employee-portal.js','utf8'),c);return c.window.TK_EMPLOYEE_PORTAL;}
test('portal job model keeps work details and drops commercial, wage and company data',()=>{
 const m=portal(),r=m.normaliseJob({id:'job',status:'paid',amount:9999,cost:220,quote_id:'private-quote',customer:{name:'Client',phone:'021123456',email:'client@example.test',address:'Road',notes:'Private customer notes'},details:{jobStatus:'completed',salesNotes:'Confidential',costSnapshot:{wages:90},workerInstructions:'Use the side gate',calendarStartAt:'2026-11-14T20:00:00Z',pricing_config:{secret:1}},services:[{name:'House wash',price:600,cost:90}],crew:['Staff Name','owner@example.test']});
 assert.equal(r.stage,'completed');assert.equal(r.workerInstructions,'Use the side gate');assert.equal(r.services[0].label,'House wash');assert.deepEqual([...r.crew],['Staff Name']);
 const json=JSON.stringify(r);for(const field of ['9999','220','private-quote','Private customer notes','Confidential','costSnapshot','pricing_config','wages','600','owner@example.test'])assert.ok(!json.includes(field),field);
});
test('employee entrypoint has no CRM financial engines, mailboxes, analytics or connection interfaces',()=>{
 const html=fs.readFileSync('employee.html','utf8');
 for(const file of ['cost-engine.js','pricing-engine.js','sales-platform.js','conversations.js','marketing-analytics.js'])assert.ok(!html.includes(file),file);
 for(const file of ['employee-portal.js','post-job-checklist.js','job-workspace.js'])assert.ok(html.includes(file));
});
test('technician sign-in redirect happens before the CRM hydrates its company state',()=>{
 const source=fs.readFileSync('index.html','utf8'),start=source.indexOf('async function handleAuthedSession(session)'),end=source.indexOf('function applyRoleVisibility',start),auth=source.slice(start,end);
 const redirect=auth.indexOf("location.replace(profile.businessId==='83c8112c-ad39-468d-b384-de593767e291'?'post-office.html':'employee.html')");
 assert.ok(redirect>0);assert.ok(redirect<auth.indexOf('loadState();'));assert.ok(redirect<auth.indexOf('await loadFromSupabase()'));
 assert.match(auth,/if\(profile.role==='technician'\)/);
});
