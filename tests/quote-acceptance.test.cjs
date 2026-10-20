const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const metrics=require('../sales-metrics.js');
const source=fs.readFileSync('index.html','utf8');
const code=source.slice(source.indexOf('const acceptanceSaves='),source.indexOf('\nfunction markPaid',source.indexOf('const acceptanceSaves=')));
function fixture(fail=false){
 const r={id:1,customerId:'customer',jobId:'job',quoteId:'quote',stage:'quoted',quoteSentAt:Date.now()-1000,requestSubmittedAt:Date.now()-2000,total:575,services:[{svc:'driveway',qty:20,fixedPrice:575}],estimatedCost:200,gstRegistered:true,nextFollowUpAt:Date.now()+1000};
 const saves=[],events=[],notices=[];
 const ctx={records:[r],sb:{},businessStateReady:true,currentBusinessId:'A',businessSessionVersion:1,recordBusinesses:new WeakMap([[r,'A']]),canEditJobStatus:()=>true,isLost:x=>x.stage==='cancelled',isWon:x=>['won','scheduled','completed','paid'].includes(x.stage),syncRecordToSupabase:async x=>{saves.push(structuredClone(x));if(fail&&saves.length===2)throw Error('offline');},loadFromSupabase:async()=>{},render(){},renderAll(){},logActivity:(...x)=>events.push(x),toast:x=>notices.push(x),docNumber:()=> 'Q1',money:n=>String(n)};
 vm.createContext(ctx);vm.runInContext(code,ctx);return {ctx,r,saves,events,notices};
}
test('acceptance persists before reporting success and updates real metric formulas once',async()=>{
 const f=fixture();const result=await Promise.all([f.ctx.markWon(1),f.ctx.markWon(1)]);
 assert.deepEqual(result,[true,true]);assert.equal(f.saves.length,2);assert.equal(f.saves[0].stage,'quoted');assert.equal(f.saves[1].stage,'won');assert.equal(f.r.nextFollowUpAt,null);assert.equal(f.events.length,1);
 let report=metrics.report([f.r],{period:'today'});assert.equal(report.bookedSales,575);assert.equal(report.cohortWins,1);assert.equal(report.acceptance,1);assert.ok(Math.abs(report.estimatedProfit-300)<0.000001);
 await f.ctx.markWon(1);assert.equal(f.events.length,1);assert.equal(f.r.salesHistory.length,1);
});
test('failed durable acceptance restores the prior stage and does not inflate booked sales',async()=>{
 const f=fixture(true);assert.equal(await f.ctx.markWon(1),false);assert.equal(f.r.stage,'quoted');assert.equal(f.events.length,0);assert.equal(metrics.report([f.r],{period:'today'}).bookedSales,0);assert.match(f.notices.at(-1),/Could not confirm/);
});
test('foreign and cancelled opportunities cannot be accepted',async()=>{
 const f=fixture();f.ctx.currentBusinessId='B';assert.equal(await f.ctx.markWon(1),false);f.ctx.currentBusinessId='A';f.r.stage='cancelled';assert.equal(await f.ctx.markWon(1),false);assert.equal(f.saves.length,0);
});
