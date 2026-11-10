const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function setup(){const c=vm.createContext({window:{},escapeHtml:s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),money:n=>'NZ$'+n});vm.runInContext(fs.readFileSync('pricing-engine.js','utf8'),c);vm.runInContext(fs.readFileSync('format-utils.js','utf8'),c);c.TK_PRICING=c.window.TK_PRICING;c.TK_FORMAT=c.window.TK_FORMAT;const html=fs.readFileSync('index.html','utf8');vm.runInContext(html.slice(html.indexOf('function isCustomQuoteLine('),html.indexOf('function fmtDur(',html.indexOf('function isCustomQuoteLine('))),c);return c;}
function fn(html,name){const a=html.indexOf('function '+name+'(');return html.slice(a,html.indexOf('\n}',a)+2);}
test('per-quote names are trimmed, bounded, fall back to service name and never change pricing',()=>{
 const c=setup(),p=c.TK_PRICING,line={svc:'driveway',qty:23,customRate:5},before=p.lineTotal(line);
 line.label='  Front steps & garden path  ';assert.equal(p.lineLabel(line),'Front steps & garden path');assert.equal(p.lineTotal(line),before);assert.equal(p.SERVICES.driveway.label,'Driveway / Patio Cleaning');
 line.label=' ';assert.equal(p.lineLabel(line),'Driveway / Patio Cleaning');line.label='x'.repeat(200);assert.equal(p.lineLabel(line).length,120);
});
test('public quote displays the saved custom line name escaped without changing totals',()=>{
 const c=setup(),html=fs.readFileSync('quote.html','utf8');for(const name of ['pubPropertySummary','pubPriceBreakdown','pubMapLegend'])vm.runInContext(fn(html,name),c);
 const lines=[{svc:'windows',label:'Upper-level <windows>',qty:20,fixedPrice:100},{svc:'driveway',label:'Front path',qty:10,fixedPrice:50}];const q=c.pubPriceBreakdown({services:lines,amount:150});
 assert.match(q,/Upper-level &lt;windows&gt;/);assert.match(q,/Front path/);assert.match(q,/NZ\$100/);assert.match(q,/NZ\$50/);assert.doesNotMatch(q,/20 panes/);
 assert.match(c.pubPropertySummary(lines),/Upper-level &lt;windows&gt;/);assert.match(c.pubMapLegend([{service:'driveway'}]),/Driveway/);
});
test('ServiceM8 transfer uses the custom label and preserves the saved amount',async()=>{
 const {approvedLines}=await import('../backend/src/salesTransfer.js');const lines=approvedLines({amount:115,details:{gstRegistered:true,services:[{svc:'driveway',label:'Custom entrance wash',qty:10,priceSnapshot:115}]}});
 assert.match(lines[0].name,/Custom entrance wash/);assert.equal(Number(lines[0].displayed_amount),115);
});
test('confirming a draft preserves its custom name and accepted quotes cannot be renamed',()=>{
 const c=setup(),html=fs.readFileSync('index.html','utf8'),record={id:1,stage:'new',services:[],total:0};
 Object.assign(c,{draftLines:[{svc:'driveway',qty:10,label:' Front courtyard ',fixedPrice:70}],records:[record],activeLeadId:1,isWon:()=>false,quoteTravelInfo:null,quoteAssumptions:{access:'easy'},TK_COST:{costBreakdown:()=>({lines:[],cost:20,recommended:60}),marginPct:()=>50},quoteTotal:()=>70,estimateJob:()=>({labourMin:30}),preloadMapSnapshot(){},closeModal(){},openDocPreview(){},toast(){}});
 vm.runInContext(fn(html,'confirmQuoteSend'),c);c.confirmQuoteSend();assert.equal(record.services[0].label,'Front courtyard');assert.equal(record.total,70);assert.equal(record.services[0].svc,'driveway');
 record.quoteStatus='accepted';c.draftLines[0].label='Forbidden change';c.confirmQuoteSend();assert.equal(record.services[0].label,'Front courtyard');
});
