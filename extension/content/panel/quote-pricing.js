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
  for(const [key,value] of Object.entries(config.chemicals||{}))if(Object.hasOwn(engine.CHEMICALS,key)&&Number.isFinite(value)&&value>=0)engine.CHEMICALS[key].perL=value;
  for(const [key,value] of Object.entries(config.overheads||{}))if(Object.hasOwn(engine.OVERHEADS,key)&&Number.isFinite(value)&&value>=0)engine.OVERHEADS[key].perMonth=value;
  for(const [key,value] of Object.entries(config.svcCost||{}))if(Object.hasOwn(engine.SVC_COST,key)&&value){
    if(Number.isFinite(value.m2ph)&&value.m2ph>0)engine.SVC_COST[key].m2ph=value.m2ph;
    if(Number.isFinite(value.litrePerM2)&&value.litrePerM2>=0)engine.SVC_COST[key].litrePerM2=value.litrePerM2;
  }
}
export function instantPricing(pricing,cost,lines,{targetMargin,price,travelKm,estimatedAt}={}){
  if(!lines.length)return {total:0,lines:[],breakdown:null};
  if(lines.some(l=>!cost.SVC_COST[l.svc]||!Number.isFinite(l.qty)||l.qty<=0))throw Error('Every service needs a positive quantity and configured delivery costs.');
  const margin=cost.targetMargin(targetMargin,cost.targetMargin(cost.COST_INPUTS.targetMargin));
  const travel=Number.isFinite(travelKm)&&travelKm>=0?{km:travelKm}:undefined;
  const bd=cost.costBreakdown(lines,travel,{targetMargin:margin});
  const total=price==null?bd.recommended:Math.round(Number(price));
  if(!Number.isFinite(total)||total<1||total>1e8)throw Error('Enter a valid final price greater than zero.');
  const weights=bd.lines.map(l=>l.recommendedPrice),sum=weights.reduce((a,b)=>a+b,0);
  let allocated=0;
  const priced=lines.map((line,i)=>{
    const fixedPrice=i===lines.length-1?Math.round((total-allocated)*100)/100:Math.round(total*(sum?weights[i]/sum:1/lines.length)*100)/100;
    allocated=Math.round((allocated+fixedPrice)*100)/100;
    return {...line,fixedPrice};
  });
  const exGst=cost.exGst(total),gst=total-exGst;
  return {lines:priced,total,breakdown:bd,exGst,gst,profit:cost.profit(total,bd.costUnrounded),marginPct:cost.marginPct(total,bd.costUnrounded),targetMargin:margin,
    snapshot:{...bd,lines:bd.lines.map(l=>({svc:l.svc,qty:l.qty,cost:l.cost,recommendedPrice:l.recommendedPrice})),travelIsEstimate:true,travelBasis:travel?'manual round-trip estimate':'business average round-trip estimate',estimatedAt:estimatedAt||new Date().toISOString(),price:total}};
}
