import { instantPricing } from './quote-pricing.js';

export const REASONS = {unexplained:'Exclude from price learning',pricing_correction:'Pricing correction',difficult_access:'Difficult access',extra_work:'Extra work',discount:'Discount',measurement_correction:'Measurement correction'};
export const cents = n => Math.round(Number(n)*100);
export function allocatePrices(total, weights) {
  const value=cents(total);
  if(!Number.isSafeInteger(value)||value<0||value>1e10)throw Error('Enter a valid total.');
  if(!weights.length)return [];
  const sum=weights.reduce((a,b)=>a+Math.max(0,b),0);
  const shares=weights.map(w=>value*(sum?Math.max(0,w)/sum:1/weights.length));
  const result=shares.map(Math.floor);
  const order=shares.map((n,i)=>({i,r:n-result[i]})).sort((a,b)=>b.r-a.r||a.i-b.i);
  for(let i=0,left=value-result.reduce((a,b)=>a+b,0);i<left;i++)result[order[i].i]++;
  return result.map(n=>n/100);
}

// Edits live in the panel's row state, never in generated HTML or engine output.
export function learningPricing(pricing,cost,lines,options={}) {
  const base=instantPricing(pricing,cost,lines,options);
  if(!lines.length)return {...base,recommendations:[]};
  const inputs=lines.map((line,i)=>{
    const marginFloor=base.breakdown.lines[i].recommendedPrice;
    const configuredPrice=Math.round(pricing.lineTotal({...line,fixedPrice:undefined})*pricing.accessPremiumMult({access:options.access})*100)/100;
    return {lineKey:line.lineKey,svc:line.svc,unit:pricing.SERVICES[line.svc].unit,quantity:line.qty,configuredPrice,marginFloor,baselinePrice:Math.max(configuredPrice,marginFloor),storeys:line.storeys||1,access:options.access||'standard',gstRegistered:cost.COST_INPUTS.gstRegistered};
  });
  let output=[],engineError='';
  if(options.engine&&options.learningState) {
    try {
      const response=options.engine.recommend({businessId:options.businessId,lines:inputs,observations:options.learningState.observations||[],settings:options.learningState.settings||{},context:{gstRegistered:cost.COST_INPUTS.gstRegistered}});
      output=Array.isArray(response)?response:response?.lines||[];
    }catch {engineError='Learning could not be calculated. Base recommendations are shown; manual edits still work.';}
  }
  const recommendations=inputs.map(input=>{
    const learned=output.find(row=>row.lineKey===input.lineKey);
    const price=Number(learned?.recommendedPrice);
    const recommendedPrice=Math.ceil(Math.max(input.marginFloor,Number.isFinite(price)&&price>=0?price:input.baselinePrice)*100-1e-7)/100;
    return {...input,...learned,recommendedPrice,learnedAdjustment:recommendedPrice-input.baselinePrice};
  });
  const priced=lines.map((line,i)=>{
    const fixedPrice=line.manualPrice==null?recommendations[i].recommendedPrice:Math.round(line.manualPrice*100)/100;
    if(!Number.isFinite(fixedPrice)||fixedPrice<0||fixedPrice>1e8)throw Error('Enter a valid final service price (zero or more).');
    const {manualPrice,distributedPrice,reason,measurementReason,verifiedQuantity,...saved}=line;
    return {...saved,fixedPrice};
  });
  const total=priced.reduce((sum,line)=>sum+cents(line.fixedPrice),0)/100;
  if(total<1||total>1e8)throw Error('Enter a valid final price greater than zero.');
  const recommended=recommendations.reduce((sum,line)=>sum+cents(line.recommendedPrice),0)/100;
  const exGst=cost.exGst(total);
  const observationReasons=lines.map((line,i)=>options.engine?.reasonForPriceEdit?.({
    reason:line.reason,isManual:line.manualPrice!=null&&!line.distributedPrice,
    unit:inputs[i].unit,chosenPrice:priced[i].fixedPrice,
    recommendedPrice:recommendations[i].recommendedPrice,verifiedQuantity:line.verifiedQuantity
  })||'');
  return {...base,lines:priced,total,exGst,gst:total-exGst,profit:cost.profit(total,base.breakdown.costUnrounded),marginPct:cost.marginPct(total,base.breakdown.costUnrounded),breakdown:{...base.breakdown,recommended},snapshot:{...base.snapshot,price:total,recommended},recommendations,engineError,observationReasons};
}

export function observationLines(model,lines,pricing) {
  if(lines.some(l=>l.reason==='measurement_correction'&&!(l.verifiedQuantity>0)))throw Error('Apply a verified quantity and measurement reason for each measurement correction before saving.');
  return model.lines.map((line,i)=>({lineKey:line.lineKey,svc:line.svc,unit:pricing.SERVICES[line.svc].unit,quantity:line.qty,baselinePrice:model.recommendations[i].baselinePrice,chosenPrice:line.fixedPrice,reason:lines[i].reason||model.observationReasons?.[i]||'',storeys:line.storeys||1,access:model.recommendations[i].access,...(lines[i].verifiedQuantity!=null?{measuredQuantity:lines[i].originalQuantity,verifiedQuantity:lines[i].verifiedQuantity,measurementReason:lines[i].measurementReason||''}:{})}));
}

// The POST is deliberately separate from draft persistence. Reuse this exact
// body for retries, including after an ambiguous response. Backend dedupes by
// authenticated business + quoteKey + lineKey; never create another quote.
export function observationSubmission(api,businessId,quote,job,quoteLearning,isCurrent=()=>true) {
  const body={quoteKey:quoteLearning.quoteKey,jobId:job.id,lines:quoteLearning.lines,context:quoteLearning.context};
  let done=false,pending=null;
  return async function submit() {
    if(done)return;
    if(pending)return pending;
    if(!isCurrent())throw Error('Your account changed. Reopen the saved quote in TurnKey.');
    if(!quote.id||job.quote_id!==quote.id||job.business_id!==businessId||quote.business_id!==businessId)throw Error('Saved quote context could not be verified.');
    pending=api.submitPricingLearning(businessId,body).then(()=>{done=true}).finally(()=>{pending=null});
    return pending;
  };
}
