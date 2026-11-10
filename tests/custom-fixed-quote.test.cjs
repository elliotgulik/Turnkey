const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function engines(){const c=vm.createContext({window:{}});for(const name of ['pricing-engine.js','cost-engine.js'])vm.runInContext(fs.readFileSync(name,'utf8'),c);return c.window;}
const fixed=(extra={})=>({lineKey:'custom-A',svc:'custom',pricingMode:'fixed',label:'  Move outdoor furniture  ',unitPrice:115,...extra});
test('custom items use quantity × GST inclusive unit price without measurements, access or calibration',async()=>{
 const {learningPricing,observationLines}=await import('../extension/content/panel/quote-learning.js');const {TK_PRICING:p,TK_COST:c}=engines();
 const row=fixed({qty:2,unit:'hour'}),m=learningPricing(p,c,[row],{access:'hard',engine:{recommend:()=>{throw Error('custom must not train')}},learningState:{}});
 assert.equal(m.total,230);assert.equal(m.lines[0].qty,2);assert.equal(m.lines[0].unit,'hour');assert.equal(m.lines[0].label,'Move outdoor furniture');assert.equal(m.lines[0].fixedPrice,230);
 assert.equal(m.profit,null);assert.equal(m.marginPct,null);assert.equal(m.breakdown.costUnrounded,null);assert.equal(m.breakdown.knownCost,0);assert.equal(m.snapshot.costComplete,false);assert.deepEqual(observationLines(m,[row],p),[]);
 assert.equal(p.lineTotal(m.lines[0]),230);assert.equal(learningPricing(p,c,[fixed()]).lines[0].qty,1);
 const known=learningPricing(p,c,[fixed({qty:2,customCost:50})]);assert.equal(known.breakdown.costUnrounded,50);assert.ok(Math.abs(known.profit-150)<1e-8);
 const zero=learningPricing(p,c,[fixed({customCost:0})]);assert.equal(zero.breakdown.costUnrounded,0);assert.equal(zero.snapshot.costComplete,true);
});
test('mixed quotes preserve measured service pricing/margins and only measured lines reach learning',async()=>{
 const {learningPricing,observationLines}=await import('../extension/content/panel/quote-learning.js');const {TK_PRICING:p,TK_COST:c}=engines();
 const measured={lineKey:'measured',svc:'driveway',qty:100,label:'Existing custom label'},base=learningPricing(p,c,[measured],{access:'hard'});
 let inputs;const options={access:'hard',engine:{recommend:body=>{inputs=body.lines;return []}},learningState:{}};
 const rows=[fixed({qty:3,unitPrice:10.01,customCost:5}),measured],m=learningPricing(p,c,rows,options);
 assert.equal(inputs.length,1);assert.equal(inputs[0].svc,'driveway');assert.equal(m.lines[1].fixedPrice,base.lines[0].fixedPrice);assert.equal(m.total,base.total+30.03);assert.equal(m.breakdown.costUnrounded,base.breakdown.costUnrounded+5);
 assert.equal(observationLines(m,rows,p).length,1);assert.equal(observationLines(m,rows,p)[0].svc,'driveway');
 const unknown=learningPricing(p,c,[fixed(),measured]);assert.equal(unknown.marginPct,null);assert.ok(unknown.breakdown.knownCost>0);
 assert.equal(learningPricing(p,c,[{...measured,manualPrice:0},fixed()]).total,115);
});
test('custom names, units, prices and quantities validate; arbitrary unknown measurement services are rejected',async()=>{
 const {learningPricing}=await import('../extension/content/panel/quote-learning.js');const {TK_PRICING:p,TK_COST:c}=engines();
 for(const patch of [{label:''},{label:'  '},{label:'a'.repeat(121)},{label:null},{unitPrice:null},{unitPrice:NaN},{unitPrice:-1},{unitPrice:Infinity},{unitPrice:'100'},{qty:0},{qty:null},{qty:-1},{unit:'m²'},{customCost:-1}])assert.throws(()=>learningPricing(p,c,[fixed(patch)]),/custom|name/);
 assert.throws(()=>learningPricing(p,c,[{svc:'unknown',label:'Unknown',qty:1}]),/configured delivery costs/);
 assert.equal(learningPricing(p,c,[fixed({label:'<script> & odd name',qty:.5,unit:'day',unitPrice:21.03})]).total,10.52);
});
test('custom quote metadata survives persistence and retry, with unknown costs explicitly null',async()=>{
 const {createQuoteDraft}=await import('../extension/content/panel/quote-create.js'),{learningPricing}=await import('../extension/content/panel/quote-learning.js');const {TK_PRICING:p,TK_COST:c}=engines();
 const model=learningPricing(p,c,[fixed({qty:2,unit:'day',unitPrice:49.99})]);let details,writes=0;
 const api={createQuote:async(b,row)=>({id:row.id,business_id:b}),createJob:async(b,row)=>{writes++;details=structuredClone(row.details);return{id:row.id,business_id:b}},logActivity:async()=>{}};
 const payload={lines:model.lines,total:model.total,customer:{id:'customer'},isNewCustomer:false,areaPolys:[],costSnapshot:model.snapshot,estimatedCost:null,estimatedMarginPct:null,gstRegistered:true};
 const progress={};await createQuoteDraft(api,progress,{businessId:'B',payload});await createQuoteDraft(api,progress,{businessId:'B',payload});
 assert.equal(writes,1);assert.equal(details.total,99.98);assert.equal(details.services[0].customCost,null);assert.equal(details.estimatedCost,null);assert.deepEqual(details.areaPolys,[]);
 const reopened=learningPricing(p,c,details.services);assert.equal(reopened.total,99.98);assert.deepEqual(reopened.lines,model.lines);
});
test('ServiceM8 keeps arbitrary custom names and saved line amounts',async()=>{
 const {approvedLines}=await import('../backend/src/salesTransfer.js');const result=approvedLines({amount:99.98,details:{gstRegistered:true,services:[fixed({label:'Move patio furniture',qty:2,unit:'day',fixedPrice:99.98})]}});
 assert.match(result[0].name,/Move patio furniture/);assert.equal(result[0].displayed_amount,'99.98');
});

test('custom-only saved quotes skip calibration submission entirely',async()=>{
 const {observationSubmission}=await import('../extension/content/panel/quote-learning.js');let calls=0;
 const submit=observationSubmission({submitPricingLearning:async()=>{calls++;}},'B',{id:'Q',business_id:'B'},{id:'J',quote_id:'Q',business_id:'B'},{quoteKey:'custom-only',lines:[],context:{}});
 await submit();await submit();assert.equal(calls,0);
});

function rootContext(){
 const c=vm.createContext({window:{},console});for(const file of ['pricing-engine.js','cost-engine.js','format-utils.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c);
 Object.assign(c,c.window);c.SERVICES=c.TK_PRICING.SERVICES;
 c.escapeHtmlSafe=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));c.escapeHtml=c.escapeHtmlSafe;c.money=n=>'NZ$'+n;
 const html=fs.readFileSync('index.html','utf8');vm.runInContext(html.slice(html.indexOf('function isCustomQuoteLine('),html.indexOf('function fmtDur(',html.indexOf('function isCustomQuoteLine('))),c);
 function add(name){const a=html.indexOf('function '+name+'('),b=html.indexOf('\nfunction ',a+1);vm.runInContext(html.slice(a,b<0?html.length:b),c);}
 for(const name of ['lineSubtotal','calculatedQuoteTotal','quoteTotal','docMoney','docFinancials','lineVariantNote','renderDocHTML','confirmQuoteSend','hexToRgb','buildDocPDF','buildDocEmailBody'])add(name);
 Object.assign(c,{quoteTotalOverride:null,quoteAssumptions:{access:'hard',premium:true},assumptionsMult:()=>c.TK_PRICING.accessPremiumMult(c.quoteAssumptions),baseQuoteTotal:()=>c.TK_PRICING.linesBaseTotal(c.draftLines),docBizName:()=> 'Public Business',docNumber:()=> 'Q-1',docMapSectionHtml:()=>'',currentBusinessProfile:null,docTemplate:{business:'Public Business',quoteTerms:'Public terms',invoiceTerms:'Pay on completion',footer:'Thank you'},cachedLogoDataUrl:null});
 return c;
}
test('CRM custom confirmation preserves exact cents, metadata, nullable costs and measured behavior',()=>{
 const c=rootContext(),line=fixed({label:'Move furniture',qty:2,unit:'hour',unitPrice:20.01,fixedPrice:40.02,customCost:null});
 c.draftLines=[line];const record={id:1,total:40.02,services:[],stage:'quoting'};
 Object.assign(c,{records:[record],activeLeadId:1,isWon:()=>false,quoteTravelInfo:null,preloadMapSnapshot(){},closeModal(){},openDocPreview(){},toast:message=>{c.toastMessage=message;}});
 assert.equal(c.quoteTotal(),40.02);c.confirmQuoteSend();
 assert.equal(record.total,40.02);assert.equal(record.services[0].unitPrice,20.01);assert.equal(record.services[0].unit,'hour');assert.equal(record.services[0].priceSnapshot,40.02);assert.equal(record.estimatedCost,null);assert.equal(record.estimatedMarginPct,null);assert.equal(record.estimatedDurationMin,null);
 c.draftLines=record.services.map(l=>({...l}));assert.equal(c.quoteTotal(),40.02);
 const measured={svc:'driveway',qty:100};c.draftLines=[measured];assert.equal(c.quoteTotal(),Math.round(c.TK_PRICING.lineTotal(measured)*c.assumptionsMult()));
 const base=c.quoteCostBreakdown([measured]);const mixed=c.quoteCostBreakdown([measured,{...line,customCost:10}]);assert.equal(mixed.costUnrounded,base.costUnrounded+10);
 c.draftLines=[{...line,customCost:0}];c.confirmQuoteSend();assert.equal(record.estimatedCost,0);assert.equal(record.costSnapshot.costComplete,true);
 c.draftLines=[{...line,label:'   '}];const before=record.services;c.confirmQuoteSend();assert.equal(record.services,before);assert.match(c.toastMessage,/custom service name/);
});
test('public HTML, CRM document/PDF/email show custom names and units, exact prices, and no internal costs',()=>{
 const c=rootContext(),line=fixed({label:'Patio <furniture>',qty:2,unit:'day',unitPrice:20.01,fixedPrice:40.02,customCost:98765});
 const record={id:1,name:'Customer',total:40.02,services:[line],costSnapshot:{private:'SECRET'},estimatedCost:98765,gstRegistered:true,stage:'quoting'};
 const html=c.renderDocHTML('quote',record);assert.match(html,/Patio &lt;furniture&gt;/);assert.match(html,/2 day/);assert.match(html,/40\.02/);assert.doesNotMatch(html,/98765|SECRET|m²/);
 Object.assign(c,{quoteLinkFor:()=> 'https://example.test/quote',docPreview:{},COST_INPUTS:c.TK_COST.COST_INPUTS});
 // Exercise actual PDF content writes with a minimal jsPDF drawing surface.
 const text=[];c.window.jspdf={jsPDF:function(){return new Proxy({splitTextToSize:s=>[s],text:s=>text.push(String(s)),output:()=>text.join('\n')},{get:(obj,key)=>obj[key]||(()=>{})});}};
 c.buildDocPDF('quote',record);assert.match(text.join('\n'),/Patio <furniture>/);assert.match(text.join('\n'),/2 day/);assert.match(text.join('\n'),/40\.02/);assert.doesNotMatch(text.join('\n'),/98765|SECRET|m²/);
 const email=c.buildDocEmailBody('quote',record);assert.match(email,/Patio <furniture>/);assert.match(email,/2 day/);assert.match(email,/40\.02/);assert.doesNotMatch(email,/98765|SECRET|m²/);
 const publicHtml=fs.readFileSync('quote.html','utf8');for(const name of ['pubPropertySummary','pubPriceBreakdown']){const a=publicHtml.indexOf('function '+name+'(');vm.runInContext(publicHtml.slice(a,publicHtml.indexOf('\n}',a)+2),c);}
 const summary=c.pubPropertySummary([line]),publicDoc=c.pubPriceBreakdown({services:[line],amount:40.02});assert.match(summary,/2 day/);assert.match(publicDoc,/Patio &lt;furniture&gt;/);assert.match(publicDoc,/40\.02/);assert.doesNotMatch(publicDoc,/98765|m²|Site adjustment/);
});
