const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const id='00000000-0000-4000-8000-000000000001';
function setup(business='A',owner='A'){
 const row={id:42,jobId:id},events={},opened=[],messages=[],urls=[];
 const ctx={URL,location:{href:'https://turnkeycrm.net/index.html?open=pipeline&job='+id},history:{replaceState:(_,__,url)=>urls.push(url)},
  currentBusinessId:business,businessSessionVersion:2,businessStateReady:true,records:[row],recordBusinesses:new WeakMap([[row,owner]]),
  openDetail:ref=>opened.push(ref),toast:m=>messages.push(m),window:{addEventListener:(name,fn)=>events[name]=fn,postMessage:()=>{}},
  // The Google Earth customer-handoff IIFE appended later in this same file
  // (see customer-earth-handoff-link.test.cjs for its own dedicated tests)
  // needs document.addEventListener to exist — a no-op stub is enough here,
  // since this test file only exercises the earlier job-import IIFE.
  document:{addEventListener:()=>{}}};
 vm.runInNewContext(fs.readFileSync('extension-quote-link.js','utf8'),ctx);
 return {ctx,events,opened,messages,urls};
}
test('extension quote link waits for the exact ready business/session and opens once',()=>{
 const s=setup();assert.equal(s.opened.length,0);
 s.ctx.window.TK_READY_BUSINESS={id:'A',version:1};s.events['turnkey:business-ready']();assert.equal(s.opened.length,0);
 s.ctx.window.TK_READY_BUSINESS={id:'A',version:2};s.events['turnkey:business-ready']();s.events['turnkey:business-ready']();
 assert.deepEqual(s.opened,[42]);assert.equal(s.urls[0],'/index.html?open=pipeline');
});
test('another business cannot open a quote through its URL',()=>{
 const s=setup('B','A');s.ctx.window.TK_READY_BUSINESS={id:'B',version:2};s.events['turnkey:business-ready']();
 assert.equal(s.opened.length,0);assert.match(s.messages[0],/signed-in business/);
});
