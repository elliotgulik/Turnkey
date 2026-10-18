// TurnKey cost/margin engine — the single source of truth for recommended
// pricing, cost breakdowns and margin math. Loaded ONLY by index.html
// (never booking.html or quote.html): wage rates, chemical costs and
// target margin are internal business economics that must never reach a
// public, unauthenticated page's network tab — see the same reasoning
// already applied to pricing_config in booking.html's fetch.
window.TK_COST = (function(){
  // Cleaning rate (m²-or-equivalent-units per hour) and chemical use per
  // unit, by service — drives labour time and chemical cost, separately
  // from the customer-facing $/unit rate in pricing-engine.js.
  const SVC_COST = {
    driveway: { m2ph:55, chem:'sodiumHypo', litrePerM2:0.030 },
    housewash:{ m2ph:35, chem:'softWash',   litrePerM2:0.06  }, // per linear metre of perimeter
    roof:     { m2ph:30, chem:'softWash',   litrePerM2:0.055 },
    // Chemical/application only — no pressure-washing pass, so real labour
    // time per m² is much lower than a full Roof Wash (higher m2ph = faster
    // coverage); chemical use per m² is similar-to-slightly-higher since the
    // chemical application IS the service, not a pre-wash step.
    rooftreatment:{ m2ph:70, chem:'softWash', litrePerM2:0.06 },
    gutter:   { m2ph:45, chem:'degreaser',  litrePerM2:0.010 }, // per linear metre
    fence:    { m2ph:55, chem:'sodiumHypo', litrePerM2:0.020 }, // per linear metre
    patio:    { m2ph:50, chem:'sodiumHypo', litrePerM2:0.028 },
    // deck and windows previously had no cost entry at all, so their lines
    // were silently dropped from costBreakdown() — their revenue counted
    // against the other lines' cost and inflated the job's margin. These
    // are starting assumptions; tune them in Pricing → Productivity.
    deck:     { m2ph:40, chem:'sodiumHypo', litrePerM2:0.030 },
    windows:  { m2ph:20, chem:'none',       litrePerM2:0 }       // panes per hour
  };
  // Chemical prices per litre (concentrate) — editable in the Pricing tab.
  const CHEMICALS = {
    sodiumHypo:{ label:'Sodium hypochlorite (12%)', perL:3.20 },
    mossMould:{ label:'Moss & mould killer', perL:null },
    surfactant:{ label:'Surfactant', perL:null },
    softWash:{ label:'Soft-wash mix (legacy)', perL:5.80 },
    degreaser:{ label:'Degreaser', perL:4.50 }
  };
  // Every field here is editable in the Pricing tab (setCostInput()) and
  // persisted per-business via savePricingConfig() — nothing in the cost
  // model is a fixed, invisible constant a business can't see or change.
  const COST_INPUTS = {
    wage:32,        // $/hour per crew member on the job
    crew:2,         // people on a typical job
    setupMin:25,    // setup/pack-down per job (minutes) — once per job, not per line
    fuelPerKm:0.28, // running cost $/km
    avgKm:14,       // avg round-trip drive to a job (tune this to your area)
    equipmentPerJob:8,   // equipment wear/maintenance allowance per job
    consumablesPerJob:5, // PPE, rags, misc supplies per job
    targetMargin:0.55,   // owner's target margin, measured on EX-GST revenue
    calloutMin:120, // no recommended price is ever suggested below this, however small the job (GST-incl)
    // Every customer-facing price in TK_PRICING is GST-inclusive. When the
    // business is GST-registered, 15% of every dollar quoted goes to IRD,
    // so margin and the recommended price are computed on the ex-GST
    // amount. Costs here are treated as ex-GST (wages carry no GST; GST on
    // chemicals/fuel/equipment is claimed back).
    gstRegistered:true,
    // Fixed monthly overheads (OVERHEADS below) are spread evenly across
    // this many jobs a month to give a per-job overhead charge.
    jobsPerMonth:40
  };
  // Fixed monthly running costs that aren't tied to any one job but every
  // job has to pay for. Zero by default — set real figures in the Pricing
  // tab. Monthly $ amounts, ex-GST.
  const OVERHEADS = {
    vehicle:   { label:'Vehicle (lease/finance, rego, WOF, servicing)', perMonth:0 },
    insurance: { label:'Insurance (liability, vehicle, equipment)',     perMonth:0 },
    software:  { label:'Software & subscriptions',                       perMonth:0 },
    phone:     { label:'Phone & internet',                               perMonth:0 },
    marketing: { label:'Marketing & advertising',                        perMonth:0 },
    admin:     { label:'Admin / office wages',                           perMonth:0 },
    other:     { label:'Other (accounting, storage, bank fees)',         perMonth:0 }
  };
  const GST_RATE=0.15;
  function overheadsMonthly(){
    return Object.values(OVERHEADS).reduce((s,o)=>s+(parseFloat(o.perMonth)||0),0);
  }
  function overheadPerJob(){
    const jobs=parseFloat(COST_INPUTS.jobsPerMonth)||0;
    return jobs>0?overheadsMonthly()/jobs:0;
  }
  // GST-inclusive customer price → the revenue the business actually keeps.
  function exGst(amountIncl){
    const a=parseFloat(amountIncl)||0;
    return COST_INPUTS.gstRegistered?a/(1+GST_RATE):a;
  }
  function inclGst(amountEx){
    const a=parseFloat(amountEx)||0;
    return COST_INPUTS.gstRegistered?a*(1+GST_RATE):a;
  }

  function lineCleanMin(line){
    const c=SVC_COST[line.svc]; if(!c)return 0;
    return ((parseFloat(line.qty)||0)/c.m2ph)*60;
  }
  // Concentrate litres per service unit, keyed by chemical ID. Missing
  // chemicals retains legacy single-product settings; {} means no chemicals.
  function serviceChemicals(svc){
    const c=SVC_COST[svc]; if(!c)return {};
    return c.chemicals!==undefined?{...c.chemicals}:
      (CHEMICALS[c.chem]?{[c.chem]:c.litrePerM2}:{});
  }
  function lineLitres(line){
    return (parseFloat(line.qty)||0)*Object.values(serviceChemicals(line.svc)).reduce((s,n)=>s+n,0);
  }
  function lineChemCost(line){
    const qty=parseFloat(line.qty)||0;
    return Object.entries(serviceChemicals(line.svc))
      .reduce((s,[id,litres])=>s+(qty*litres)*(CHEMICALS[id].perL??0),0);
  }
  function unsetChemicals(lines){
    return [...new Set((lines||[]).filter(l=>Number(l.qty)>0).flatMap(l=>
      Object.entries(serviceChemicals(l.svc)).filter(([id,n])=>n>0&&CHEMICALS[id].perL===null).map(([id])=>id)))];
  }
  const chemicalDefaults=JSON.parse(JSON.stringify(CHEMICALS));
  const serviceDefaults=JSON.parse(JSON.stringify(SVC_COST));
  function chemicalConfig(){
    return {
      chemicals:Object.fromEntries(Object.entries(CHEMICALS).map(([k,v])=>[k,v.perL])),
      svcCost:JSON.parse(JSON.stringify(SVC_COST))
    };
  }
  // Reset each business before applying its saved configuration. Shared by
  // CRM reloads and Earth so selections and unset costs have one meaning.
  function applyChemicalConfig(config={}){
    for(const [k,v] of Object.entries(chemicalDefaults))Object.assign(CHEMICALS[k],v);
    for(const [k,v] of Object.entries(serviceDefaults)){
      delete SVC_COST[k].chemicals;
      Object.assign(SVC_COST[k],v);
    }
    for(const [k,v] of Object.entries(config.chemicals||{})){
      if(Object.hasOwn(CHEMICALS,k)&&(v===null||(Number.isFinite(v)&&v>=0)))CHEMICALS[k].perL=v;
    }
    for(const [k,v] of Object.entries(config.svcCost||{})){
      if(!Object.hasOwn(SVC_COST,k)||!v)continue;
      const c=SVC_COST[k];
      if(Number.isFinite(v.m2ph)&&v.m2ph>0)c.m2ph=v.m2ph;
      if(v.chem==='none'||Object.hasOwn(CHEMICALS,v.chem))c.chem=v.chem;
      if(Number.isFinite(v.litrePerM2)&&v.litrePerM2>=0)c.litrePerM2=v.litrePerM2;
      if(v.chemicals&&typeof v.chemicals==='object'&&!Array.isArray(v.chemicals)){
        c.chemicals=Object.fromEntries(Object.entries(v.chemicals).filter(([id,n])=>
          Object.hasOwn(CHEMICALS,id)&&Number.isFinite(n)&&n>=0));
      }
    }
  }

  // Full cost + recommended-price breakdown for a set of quote lines.
  // Wages and fixed per-job costs (setup, fuel, equipment, consumables) are
  // real per-JOB costs, not per-line — they're allocated back to each line
  // proportionally by that line's own direct cost share purely so a
  // per-service "recommended price" can be shown at all. Per-line figures
  // always sum exactly to the job-level totals (last line absorbs any
  // rounding remainder) so nothing here can ever look inconsistent.
  // Quote-local targets can override the business default without changing it.
  function targetMargin(value,fallback=0.55){
    if(value===null||value===''||value===undefined)return fallback;
    const n=Number(value);return Number.isFinite(n)&&n>=0&&n<1?n:fallback;
  }
  function costBreakdown(lines,travel,options){
    const margin=targetMargin(options&&options.targetMargin,targetMargin(COST_INPUTS.targetMargin));
    const active=(lines||[]).filter(l=>SVC_COST[l.svc]&&(parseFloat(l.qty)||0)>0);
    const totalCleanMin=active.reduce((s,l)=>s+lineCleanMin(l),0);
    // travel is optional {km, mins} for the actual business->job distance
    // (see calcTravelDistance() in index.html); falls back to the fixed
    // avgKm guess when no real distance has been calculated yet (e.g. no
    // home address configured, or the lookup is still in flight).
    const travelKm=(travel&&isFinite(travel.km))?travel.km:COST_INPUTS.avgKm;
    const travelMins=(travel&&isFinite(travel.mins))?travel.mins:null;
    const totalLabourMin=totalCleanMin+COST_INPUTS.setupMin;
    const totalLabourHrs=totalLabourMin/60;
    const totalWageCost=totalLabourHrs*COST_INPUTS.wage*COST_INPUTS.crew;
    const totalChemCost=active.reduce((s,l)=>s+lineChemCost(l),0);
    const totalLitres=active.reduce((s,l)=>s+lineLitres(l),0);
    const fuelCost=travelKm*COST_INPUTS.fuelPerKm;
    const equipmentCost=COST_INPUTS.equipmentPerJob||0;
    const consumablesCost=COST_INPUTS.consumablesPerJob||0;
    const overheadCost=active.length?overheadPerJob():0;
    const fixedExtras=fuelCost+equipmentCost+consumablesCost+overheadCost;

    // Direct cost per line (wage share by clean-time + its own chemical
    // cost) — this is what each line's share of the total is based on.
    const lineDirect=active.map(l=>{
      const cleanMin=lineCleanMin(l);
      const wageShare=totalCleanMin>0?totalWageCost*(cleanMin/totalCleanMin):0;
      const chemCost=lineChemCost(l);
      return {line:l, cleanMin, wageShare, chemCost, directCost:wageShare+chemCost};
    });
    const totalDirectCost=lineDirect.reduce((s,d)=>s+d.directCost,0);
    const totalCost=totalDirectCost+fixedExtras;
    // Target margin is hit on ex-GST revenue, then GST is added on top so
    // the recommended figure is the GST-inclusive price the customer sees.
    const recommendedExGst=totalCost/(1-margin);
    const rawRecommended=inclGst(recommendedExGst);
    // Round UP only at the customer-price boundary: rounding to nearest can
    // otherwise recommend less than the requested margin on actual costs.
    const recommendedTotal=Math.max(Math.ceil(rawRecommended/5)*5, totalCost>0?COST_INPUTS.calloutMin:0);

    let allocated=0;
    const perLine=lineDirect.map((d,i)=>{
      let rec;
      if(i===lineDirect.length-1){
        rec=recommendedTotal-allocated; // last line absorbs rounding remainder
      }else{
        const share=totalDirectCost>0?d.directCost/totalDirectCost:1/lineDirect.length;
        rec=Math.round(recommendedTotal*share);
        allocated+=rec;
      }
      // `line` is the actual input object (not a copy) so callers can match
      // a recommendation back to a specific draftLines row via === identity
      // even when two lines share the same service (e.g. two driveway
      // sections priced separately).
      return {line:d.line, svc:d.line.svc, qty:d.line.qty, cost:Math.round(d.directCost), recommendedPrice:Math.max(rec,0)};
    });

    return {
      ...(unsetChemicals(active).length?{unsetChemicals:unsetChemicals(active)}:{}),
      lines:perLine,
      labourMin:Math.round(totalLabourMin), labourHrs:totalLabourHrs,
      wageCost:totalWageCost, chem:totalChemCost, litres:totalLitres,
      fuelCost, equipmentCost, consumablesCost, overheadCost,
      travelKm, travelMins, travelIsEstimate:!(travel&&isFinite(travel.km)),
      cost:Math.round(totalCost), // retained for existing display/snapshot consumers
      costUnrounded:totalCost, // internal audit basis for target-margin guarantees
      recommended:recommendedTotal,
      targetMargin:margin
    };
  }
  // Margin % for a given GST-inclusive final price against a given cost —
  // the one place "revenue vs cost vs margin" is ever computed, used
  // identically by the Quote Builder's live panel and the Reporting tab.
  // Revenue is converted to ex-GST first: the GST portion was never the
  // business's money.
  function marginPct(revenueIncl,cost){
    const rev=exGst(revenueIncl);
    if(!rev||rev<=0)return 0;
    return (rev-cost)/rev*100;
  }
  // Profit in dollars on a GST-inclusive price.
  function profit(revenueIncl,cost){
    return exGst(revenueIncl)-(cost||0);
  }
  return {serviceChemicals,unsetChemicals,chemicalConfig,applyChemicalConfig,targetMargin,SVC_COST,CHEMICALS,COST_INPUTS,OVERHEADS,GST_RATE,lineCleanMin,lineLitres,lineChemCost,costBreakdown,marginPct,profit,exGst,inclGst,overheadsMonthly,overheadPerJob};
})();
