// TurnKey shared pricing engine — the single source of truth for service
// rates, multipliers and line-total math. Loaded by index.html (internal
// quote builder + PDF/email/customer-profile renderers), booking.html (the
// public online quote-request estimate) and quote.html (the public quote
// approval page), so a quote is never priced or labelled differently on
// different pages. Business-internal cost/margin data (wages, chemical
// cost, target margin) deliberately does NOT live here — this file is
// loaded by public, unauthenticated pages, so only customer-facing rate
// data belongs in it.
window.TK_PRICING = (function(){
  // `shape` is the map-drawing/snapshot classification (closed polygon vs
  // open line vs not drawn at all) — kept distinct from `basis` (the
  // pricing terminology, e.g. roof's basis is 'roof type' but its shape is
  // still a closed polygon) so callers never have to string-match basis
  // values to answer "does this close back to its first point".
  const SERVICES = {
    // Labels here are customer-facing copy (shown on invoices/quotes and in
    // the booking widget's service picker, not just internal CRM text), so
    // they're kept in the polished, title-cased wording the public-facing
    // pages use — driveway's now explicitly covers patio too (see the
    // customer picker's merged "Driveway / Patio Cleaning" button below;
    // patio itself stays defined, just not customer-selectable, so
    // existing/historical jobs that used it still price and display correctly).
    driveway: {label:'Driveway / Patio Cleaning', unit:'m²', rate:4,   basis:'area',      shape:'closed', color:'#c2683a', kw:['driveway','concrete','path','mossy','moss','patio']},
    housewash:{label:'House Wash',            unit:'m',  rate:5,   basis:'perimeter', shape:'closed', color:'#2f7d8f', kw:['house wash','house','wall','exterior','siding','cladding']},
    // Was $9/m² — that priced a typical roof (150-250m² footprint) at
    // $1,350-$2,250, a ~73% margin against the app's own cost model at
    // COST_INPUTS.targetMargin (55%) — well above every other service's
    // margin and the actual outlier customers were pushing back on. $6/m²
    // lands roof at ~59% margin, in line with the business's own target and
    // matching patio's rate rather than sitting 50% above it for no
    // modelled reason (height/access risk is still covered separately by
    // ACCESS_OPTS when the operator marks a job as difficult access).
    roof:     {label:'Roof Treatment',        unit:'m²', rate:6,   basis:'roof type', shape:'closed', color:'#7a5bbf', kw:['roof','tiles','treatment']},
    gutter:   {label:'Gutter Cleaning',       unit:'m',  rate:3.5, basis:'length',    shape:'open',   color:'#b08a1e', kw:['gutter','gutters','blocked','downpipe']},
    fence:    {label:'Fence Cleaning',        unit:'m',  rate:4,   basis:'length',    shape:'open',   color:'#6b7a3a', kw:['fence','wall','boundary','palings']},
    // Kept for existing/historical jobs that used the old combined "patio /
    // deck" concept — no longer offered as its own button in the customer
    // picker now that deck is its own service below, but still a valid,
    // fully-priced line the CRM's own quote builder can select.
    patio:    {label:'Patio',                 unit:'m²', rate:6,   basis:'area',      shape:'closed', color:'#0f7d6b', kw:['patio','courtyard','tiles']},
    deck:     {label:'Deck Cleaning',         unit:'m²', rate:6,   basis:'area',      shape:'closed', color:'#8a6f3f', kw:['deck','decking','timber']},
    windows:  {label:'Window clean',          unit:'panes', rate:4, basis:'count',   shape:'none',   color:'#4a6b8a', kw:['window','windows','pane','glass','glazing']}
  };
  const ROOF_TYPES = {
    concrete:{label:'Concrete tile',      mult:1.0},
    metal:   {label:'Metal / colorsteel', mult:0.85},
    asphalt: {label:'Asphalt shingle',    mult:1.15}
  };
  const STOREY_TYPES = {
    1:{label:'Single storey', mult:1.0},
    2:{label:'Two storey',    mult:1.2},
    3:{label:'Three storey',  mult:1.44}
  };
  // Fence pricing default assumes one face washed. "2 sides" (both faces of
  // a boundary fence — common when a customer owns/can access both) simply
  // doubles the rate on the same measured length, rather than asking the
  // operator to draw the same line twice.
  const FENCE_SIDES = {
    1:{label:'1 side',              mult:1},
    2:{label:'2 sides (both faces)',mult:2}
  };
  const ACCESS_OPTS = {
    easy:    {label:'Easy access',     mult:0.95, note:'open, ground level'},
    standard:{label:'Standard',        mult:1.0,  note:'typical site'},
    hard:    {label:'Difficult access',mult:1.15, note:'steep, tight, or high'}
  };
  const PREMIUM_MULT = 1.12; // premium/delicate surface handling

  // Effective $/unit rate for one line: manual override wins outright,
  // otherwise the service's base rate with whichever multiplier applies.
  function effectiveRate(line){
    if(!line)return 0;
    if(line.customRate!=null)return parseFloat(line.customRate)||0;
    const svc=SERVICES[line.svc]; if(!svc)return 0;
    if(line.svc==='roof'&&line.roofType&&ROOF_TYPES[line.roofType])return svc.rate*ROOF_TYPES[line.roofType].mult;
    if(line.svc==='housewash'&&line.storeys&&STOREY_TYPES[line.storeys])return svc.rate*STOREY_TYPES[line.storeys].mult;
    if(line.svc==='fence'&&line.sides&&FENCE_SIDES[line.sides])return svc.rate*FENCE_SIDES[line.sides].mult;
    return svc.rate;
  }
  // Total for one line: a fixed price wins outright (set by the operator to
  // override area/rate math entirely), otherwise qty × effective rate.
  function lineTotal(line){
    if(!line)return 0;
    if(line.fixedPrice!=null)return parseFloat(line.fixedPrice)||0;
    return (parseFloat(line.qty)||0)*effectiveRate(line);
  }
  function accessPremiumMult(assumptions){
    if(!assumptions)return 1;
    const a=ACCESS_OPTS[assumptions.access]||ACCESS_OPTS.standard;
    let m=a.mult;
    if(assumptions.premium)m*=PREMIUM_MULT;
    return m;
  }
  function linesBaseTotal(lines){
    return (lines||[]).reduce((s,l)=>s+lineTotal(l),0);
  }
  // The one true "what does this quote cost" function. Every page that
  // shows a quote total (builder, PDF, email, customer approval page,
  // invoice) routes through this, so a mapping-precision rounding
  // difference can never produce two different totals for the same quote.
  function quoteTotal(lines,assumptions){
    return Math.round(linesBaseTotal(lines)*accessPremiumMult(assumptions));
  }
  // Every displayed price is GST-inclusive; this extracts the GST component
  // from a total for the "Subtotal / GST / Total" breakdown shown in the
  // PDF, invoice and public quote page — one formula, so the split always
  // adds back up to the same total shown everywhere else.
  function gstFromInclusive(total){
    const gst=Math.round((total||0)-(total||0)/1.15);
    return {exGst:(total||0)-gst, gst};
  }
  // Applies a business's saved rate overrides (Settings → Pricing) onto the
  // shared table — call once per page load after fetching pricing_config.
  // Deliberately rates-only: chemical cost/target margin are cost-model
  // data that never belongs on a page a customer's browser can load.
  function applyRateOverrides(rates){
    if(!rates)return;
    Object.entries(rates).forEach(([k,v])=>{if(SERVICES[k]&&typeof v==='number')SERVICES[k].rate=v;});
  }

  return {
    SERVICES, ROOF_TYPES, STOREY_TYPES, FENCE_SIDES, ACCESS_OPTS, PREMIUM_MULT,
    effectiveRate, lineTotal, linesBaseTotal, accessPremiumMult, quoteTotal, applyRateOverrides, gstFromInclusive
  };
})();
