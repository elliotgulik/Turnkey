const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function model(){const c={window:{addEventListener(){}},document:{addEventListener(){}},URL,console};vm.runInNewContext(fs.readFileSync('post-job-checklist.js','utf8'),c);return c.window.TK_POST_JOB;}
const checks={injectorFlushed:true,fuelSwitchOff:true,objectsReturned:true,propertyLap:true};
test('completion requires four site checks and an explicit customer presence answer',()=>{
 const m=model();assert.deepEqual([...m.missing({})],['customerHome','injectorFlushed','fuelSwitchOff','objectsReturned','propertyLap']);
 assert.deepEqual([...m.missing({...checks,customerHome:false})],[]);
 for(const field of Object.keys(checks))assert.ok(m.missing({...checks,customerHome:false,[field]:false}).includes(field));
});
test('home handover requires quality check but never requires review, extra work or repeat booking',()=>{
 const m=model();assert.deepEqual([...m.missing({...checks,customerHome:true})],['qualityCheck']);
 assert.deepEqual([...m.missing({...checks,customerHome:true,qualityCheck:true,reviewScanned:false,askedUpcomingWork:false,askedFrequency:false})],[]);
});
test('customer absent normalizes stale handover answers without checking essential boxes',()=>{
 const m=model(),r=m.normalize({customerHome:false,qualityCheck:true,reviewScanned:true,askedUpcomingWork:true,upcomingWorkNotes:'old',askedFrequency:true,frequencyAnswer:'Monthly'});
 assert.equal(r.qualityCheck,false);assert.equal(r.reviewScanned,false);assert.equal(r.upcomingWorkNotes,'');assert.equal(r.frequencyAnswer,'');assert.equal(r.injectorFlushed,false);
});
test('all root job completion controls enter the employee checklist and assets ship locally',()=>{
 const html=fs.readFileSync('index.html','utf8'),build=fs.readFileSync('scripts/build-static.js','utf8');
 assert.match(html,/TK_POST_JOB\.open\(id,\{whenDisabled:completeWithoutPostJobChecklist\}\)/);
 assert.match(html,/if\(key==='completed'\)\{await completeJob\(id\);return;\}/);
 for(const file of ['post-job-checklist.js','post-job-checklist.css']){assert.ok(html.includes(file));assert.ok(build.includes(file));}
 assert.ok(html.includes('assets/vendor/qrcode-generator-2.0.4.js'));
});
test('vendored review QR renders the exact configured link without a QR web service',()=>{
 const c={};vm.runInNewContext(fs.readFileSync('assets/vendor/qrcode-generator-2.0.4.js','utf8'),c);
 const q=c.qrcode(0,'M');q.addData('https://g.page/r/CbDFAxFaaWMUEBM/review');q.make();assert.ok(q.getModuleCount()>20);assert.match(q.createSvgTag({scalable:true}),/<svg/);
});

test('job picker searches real jobs, excludes cancelled/enquiries, deduplicates jobs and respects staff scope',()=>{
 const m=model(),rows=[{id:1,jobId:'one',name:'Alice',address:'1 Test Road',stage:'scheduled',assignedStaffId:'worker'},{id:2,jobId:'two',name:'Bob',stage:'won',assignedStaffId:'other'},{id:3,jobId:'three',name:'Cancelled',stage:'cancelled'},{id:4,jobId:'four',name:'New enquiry',stage:'new'},{id:5,jobId:'one',name:'Duplicate',stage:'scheduled'}];
 const context={biz:'business',user:'worker',role:'owner'};m.configure({context:()=>context,records:()=>rows});
 assert.equal(m.pickerJobs().length,2);assert.equal(m.pickerJobs('TEST ROAD')[0].name,'Alice');assert.equal(m.pickerJobs('Bob')[0].jobId,'two');
 context.role='technician';assert.equal(m.pickerJobs().length,1);assert.equal(m.pickerJobs()[0].name,'Alice');
 m.configure({context:()=>context,records:()=>rows.slice(1,2),assignedRecordsOnly:true});assert.equal(m.pickerJobs()[0].name,'Bob');
 for(const file of ['index.html','employee.html'])assert.match(fs.readFileSync(file,'utf8'),/data-post-job-picker/);
});
