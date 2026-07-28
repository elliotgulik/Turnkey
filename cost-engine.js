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
    patio:    { m2ph:50, chem:'sodiumHypo', litrePerM2:0.028 }
  };
  // Chemical prices per litre (concentrate) — editable in the Pricing tab.
  const CHEMICALS = {
    sodiumHypo:{ label:'Sodium hypochlorite (12%)', perL:3.20 },
    softWash:{ label:'Soft-wash mix (surfactant)', perL:5.80 },
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
    targetMargin:0.55,   // owner's target gross margin → drives every recommended price
    calloutMin:120  // no recommended price is ever suggested below this, however small the job
  };

  function lineCleanMin(line){
    const c=SVC_COST[line.svc]; if(!c)return 0;
    return ((parseFloat(line.qty)||0)/c.m2ph)*60;
  }
  function lineLitres(line){
    const c=SVC_COST[line.svc]; if(!c)return 0;
    return (parseFloat(line.qty)||0)*c.litrePerM2;
  }
  function lineChemCost(line){
    const c=SVC_COST[line.svc]; if(!c)return 0;
    return lineLitres(line)*(CHEMICALS[c.chem]?CHEMICALS[c.chem].perL:0);
  }

  // Full cost + recommended-price breakdown for a set of quote lines.
  // Wages and fixed per-job costs (setup, fuel, equipment, consumables) are
  // real per-JOB costs, not per-line — they're allocated back to each line
  // proportionally by that line's own direct cost share purely so a
  // per-service "recommended price" can be shown at all. Per-line figures
  // always sum exactly to the job-level totals (last line absorbs any
  // rounding remainder) so nothing here can ever look inconsistent.
  function costBreakdown(lines,travel){
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
    const fixedExtras=fuelCost+equipmentCost+consumablesCost;

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
    const rawRecommended=COST_INPUTS.targetMargin<1?totalCost/(1-COST_INPUTS.targetMargin):totalCost;
    const recommendedTotal=Math.max(Math.round(rawRecommended/5)*5, totalCost>0?COST_INPUTS.calloutMin:0);

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
      lines:perLine,
      labourMin:Math.round(totalLabourMin), labourHrs:totalLabourHrs,
      wageCost:totalWageCost, chem:totalChemCost, litres:totalLitres,
      fuelCost, equipmentCost, consumablesCost,
      travelKm, travelMins, travelIsEstimate:!(travel&&isFinite(travel.km)),
      cost:Math.round(totalCost),
      recommended:recommendedTotal,
      targetMargin:COST_INPUTS.targetMargin
    };
  }
  // Margin % for a given final price against a given cost — the one place
  // "revenue vs cost vs margin" is ever computed, used identically by the
  // Quote Builder's live panel and the Reporting tab.
  function marginPct(revenue,cost){
    if(!revenue||revenue<=0)return 0;
    return (revenue-cost)/revenue*100;
  }
  return {SVC_COST,CHEMICALS,COST_INPUTS,lineCleanMin,lineLitres,lineChemCost,costBreakdown,marginPct};
})();
