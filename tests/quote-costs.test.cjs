const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function engine(){const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../cost-engine.js'),'utf8'),context);return context.window.TK_COST;}
test('quote target recommendations use ex-GST margin without changing the business default',()=>{
 const e=engine(),lines=[{svc:'driveway',qty:200},{svc:'roof',qty:120}],before=e.COST_INPUTS.targetMargin;
 const bd=e.costBreakdown(lines,{km:50,mins:70},{targetMargin:0.65});
 assert.equal(bd.targetMargin,0.65);assert.equal(e.COST_INPUTS.targetMargin,before);
 assert(Math.abs(e.marginPct(bd.recommended,bd.cost)-65)<0.5);
 assert.equal(bd.lines.reduce((sum,l)=>sum+l.recommendedPrice,0),bd.recommended);
 assert.equal(bd.lines[0].line,lines[0]);assert.equal(bd.travelKm,50);assert.equal(bd.travelMins,70);
});
test('higher target and real travel change recommendations; non-GST businesses do not add GST',()=>{
 const e=engine(),lines=[{svc:'driveway',qty:200}];
 const low=e.costBreakdown(lines,{km:0},{targetMargin:0.4}),high=e.costBreakdown(lines,{km:80},{targetMargin:0.7});
 assert(high.recommended>low.recommended);assert.equal(high.fuelCost,80*e.COST_INPUTS.fuelPerKm);
 e.COST_INPUTS.gstRegistered=false;
 const noGst=e.costBreakdown(lines,{km:80},{targetMargin:0.7});
 assert(noGst.recommended<high.recommended);assert(Math.abs(e.marginPct(noGst.recommended,noGst.cost)-70)<0.5);
});
test('invalid margins are bounded, while a zero margin is supported and call-out minimum stays intact',()=>{
 const e=engine(),lines=[{svc:'driveway',qty:1}];
 for(const targetMargin of [1,-1,Infinity,'invalid',null,'']){
  const result=e.costBreakdown(lines,null,{targetMargin});assert(Number.isFinite(result.recommended));assert.equal(result.targetMargin,e.COST_INPUTS.targetMargin);
 }
 const result=e.costBreakdown(lines,null,{targetMargin:0});assert.equal(result.targetMargin,0);assert(result.recommended>=e.COST_INPUTS.calloutMin);
});
test('recommendations never undercut the unrounded target cost at the five-dollar boundary',()=>{
 const e=engine();e.OVERHEADS.insurance.perMonth=123.45;e.COST_INPUTS.jobsPerMonth=37;
 for(const gst of [true,false])for(const qty of [0.1,1,7.3,18,39.7,50,111.11,200,457.9])for(const target of [0,0.4,0.55,0.65,0.95]){
  e.COST_INPUTS.gstRegistered=gst;
  const lines=[{svc:'driveway',qty},{svc:'roof',qty:qty*0.37},{svc:'housewash',qty:qty*0.19}];
  const b=e.costBreakdown(lines,{km:17.35,mins:24},{targetMargin:target});
  const components=b.wageCost+b.chem+b.fuelCost+b.equipmentCost+b.consumablesCost+b.overheadCost;
  assert(Math.abs(b.costUnrounded-components)<1e-9,'Raw cost must include every delivery cost');
  assert(Math.abs(b.cost-b.costUnrounded)<=0.5+1e-9,'Legacy display cost stays rounded');
  const minimum=b.costUnrounded/(1-target)*(gst?1.15:1);
  assert(b.recommended+1e-9>=minimum,`Under target: GST=${gst}, qty=${qty}, target=${target}`);
  assert.equal(b.recommended,Math.max(Math.ceil(minimum/5)*5,e.COST_INPUTS.calloutMin));
  assert(e.marginPct(b.recommended,b.costUnrounded)+1e-9>=target*100);
  assert.equal(b.lines.reduce((sum,line)=>sum+line.recommendedPrice,0),b.recommended);
 }
});
test('recommended custom rates win over variants and assumptions never erode the recommendation floor',()=>{
 const context={window:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../pricing-engine.js'),'utf8'),context);
 const p=context.window.TK_PRICING,e=engine();
 const variants=[{svc:'roof',qty:123.4,roofType:Object.keys(p.ROOF_TYPES).at(-1)},{svc:'housewash',qty:45.6,storeys:2},{svc:'fence',qty:78.9,sides:2}];
 const b=e.costBreakdown(variants,{km:27.7},{targetMargin:0.65});
 for(const access of Object.keys(p.ACCESS_OPTS))for(const premium of [true,false]){
  const assumptions={access,premium},discount=Math.min(1,p.accessPremiumMult(assumptions));
  const lines=b.lines.map(entry=>({...entry.line,customRate:entry.recommendedPrice/(entry.line.qty*discount)}));
  for(const line of lines)assert.equal(p.effectiveRate(line),line.customRate,'Custom recommendation must bypass variant multiplication');
  const final=p.quoteTotal(lines,assumptions);
  assert(final>=b.recommended,'Access/premium must not reduce below the target recommendation');
  assert(e.marginPct(final,b.costUnrounded)>=65-1e-9);
 }
});
