// Internal-only cost configuration. Keep the customer-facing pricing engine separate.
const defaults=new WeakMap();
export function configureCosts(engine,config={}){
  const groups=['COST_INPUTS','CHEMICALS','SVC_COST','OVERHEADS'];
  if(!defaults.has(engine))defaults.set(engine,JSON.parse(JSON.stringify(Object.fromEntries(groups.map(k=>[k,engine[k]])))));
  const baseline=defaults.get(engine);
  for(const key of groups)for(const [name,value] of Object.entries(baseline[key]))engine[key][name]=value&&typeof value==='object'?{...value}:value;
  for(const [key,value] of Object.entries(config.costInputs||{})){
    if(!Object.hasOwn(engine.COST_INPUTS,key))continue;
    if(key==='gstRegistered'){if(typeof value==='boolean')engine.COST_INPUTS[key]=value;continue;}
    if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&(key!=='targetMargin'||value<1)&&(key!=='crew'||value>0))engine.COST_INPUTS[key]=value;
  }
  engine.applyChemicalConfig(config);
  for(const [key,value] of Object.entries(config.overheads||{}))if(Object.hasOwn(engine.OVERHEADS,key)&&Number.isFinite(value)&&value>=0)engine.OVERHEADS[key].perMonth=value;
}
export function instantPricing(pricing,cost,lines,{targetMargin,price,travelKm,estimatedAt,access='standard'}={}){
  if(!lines.length)return {total:0,lines:[],breakdown:null};
  if(lines.some(l=>pricing.SERVICES[l.svc]?.unit==='panes'&&(!Number.isInteger(l.qty)||l.qty<=0)))throw Error('Enter a positive whole-number manual pane count for windows.');
  if(lines.some(l=>!cost.SVC_COST[l.svc]||!Number.isFinite(l.qty)||l.qty<=0))throw Error('Every service needs a positive quantity and configured delivery costs.');
  const margin=cost.targetMargin(targetMargin,cost.targetMargin(cost.COST_INPUTS.targetMargin));
  const travel=Number.isFinite(travelKm)&&travelKm>=0?{km:travelKm}:undefined;
  const bd=cost.costBreakdown(lines,travel,{targetMargin:margin,access});
  // Match the CRM quote builder: access affects the customer-facing service
  // price as well as the extra labour included in the internal cost estimate.
  const recommended=Math.max(bd.recommended,pricing.quoteTotal(lines,{access}));
  const total=Math.round(Number(price==null?recommended:price)*100)/100;
  if(!Number.isFinite(total)||total<1||total>1e8)throw Error('Enter a valid final price greater than zero.');
  const weights=bd.lines.map(l=>l.recommendedPrice),sum=weights.reduce((a,b)=>a+b,0);
  // Allocate integer cents by largest remainder. No negative last line,
  // and the customer-visible items always sum to the exact chosen total.
  const cents=Math.round(total*100);
  const shares=lines.map((_,i)=>cents*(sum?weights[i]/sum:1/lines.length));
  const allocations=shares.map(Math.floor);
  let remaining=cents-allocations.reduce((a,b)=>a+b,0);
  const order=shares.map((share,i)=>({i,remainder:share-allocations[i]})).sort((a,b)=>b.remainder-a.remainder||a.i-b.i);
  for(let i=0;i<remaining;i++)allocations[order[i%order.length].i]++;
  const priced=lines.map((line,i)=>({...line,fixedPrice:allocations[i]/100}));
  const exGst=cost.exGst(total),gst=total-exGst;
  return {lines:priced,total,breakdown:{...bd,recommended},exGst,gst,profit:cost.profit(total,bd.costUnrounded),marginPct:cost.marginPct(total,bd.costUnrounded),targetMargin:margin,
    snapshot:{...bd,recommended,access,lines:bd.lines.map(l=>({svc:l.svc,qty:l.qty,cost:l.cost,recommendedPrice:l.recommendedPrice})),travelIsEstimate:true,travelBasis:travel?'manual round-trip estimate':'business average round-trip estimate',estimatedAt:estimatedAt||new Date().toISOString(),price:total}};
}
