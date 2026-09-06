// VENDORED FILE — byte-for-byte copy of /pricing-engine.js at the repo root.
// The Chrome extension can't load that file directly (it isn't served to
// earth.google.com), so this copy ships inside the extension bundle instead.
// If pricing-engine.js changes, re-copy it here (`cp pricing-engine.js
// extension/vendor/pricing-engine.js`, then re-apply this header) so the
// extension never prices a quote differently than the CRM does.
//
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
    // Renamed from "Roof Treatment" to "Roof Wash" — this is the full
    // pressure/soft-wash service (more labour, more equipment, more time),
    // and calling the pricier of the two roof services "Treatment" was
    // itself the root of the "roof treatment is too expensive" complaint:
    // there was no cheaper, genuinely treatment-only option to compare it
    // against. usesRoofType flags which services get the roof-material
    // (concrete/metal/asphalt) rate multiplier below, instead of hardcoding
    // `svc==='roof'` at every call site that needs to know.
    roof:     {label:'Roof Wash',             unit:'m²', rate:6,   basis:'roof type', shape:'closed', color:'#7a5bbf', kw:['roof','tiles','roof wash','wash'], usesRoofType:true},
    // A genuinely separate, cheaper service — chemical/soft-wash application
    // only, no pressure-washing labour, so lower labour time and equipment
    // use than a full Roof Wash. Rate is independently configurable in
    // Settings → Pricing like every other service (setRate('rooftreatment',…)),
    // never hardcoded/tied to roof's rate.
    rooftreatment:{label:'Roof Treatment',    unit:'m²', rate:3.5, basis:'area',      shape:'closed', color:'#9a7fd1', kw:['roof treatment','moss treatment','spray','soft wash roof']},
    gutter:   {label:'Gutter Cleaning',       unit:'m',  rate:3.5, basis:'length',    shape:'open',   color:'#b08a1e', kw:['gutter','gutters','blocked','downpipe']},
    fence:    {label:'Fence Cleaning',        unit:'m',  rate:4,   basis:'length',    shape:'open',   color:'#6b7a3a', kw:['fence','wall','boundary','palings']},
    // Kept for existing/historical jobs that used the old combined "patio /
    // deck" concept — no longer offered as its own button in the customer
    // picker now that deck is its own service below, but still a valid,
    // fully-priced line the CRM's own quote builder can select.
    patio:    {label:'Patio',                 unit:'m²', rate:6,   basis:'area',      shape:'closed', color:'#0f7d6b', kw:['patio','courtyard','tiles']},
    deck:     {label:'Deck Cleaning',         unit:'m²', rate:6,   basis:'area',      shape:'closed', color:'#8a6f3f', kw:['deck','decking','timber']},
    // Label is the professional, business-side name shown in the normal
    // quote builder ("Window Cleaning") — booking.html's customer-facing
    // instant-request flow deliberately keeps its OWN separate, request-
    // phrased wording ("Request Windows Quote") on its dedicated add-on
    // toggle button, since windows there is a follow-up request, not a
    // priced/drawn line item; that page never reads this label at all for
    // that button (see SERVICES.windows in booking.html, a local override).
    windows:  {label:'Window Cleaning',       unit:'panes', rate:4, basis:'count',   shape:'none',   color:'#4a6b8a', kw:['window','windows','pane','glass','glazing']}
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
    if(svc.usesRoofType&&line.roofType&&ROOF_TYPES[line.roofType])return svc.rate*ROOF_TYPES[line.roofType].mult;
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

// Per-business customer-facing Terms & Policies — the single source of
// truth for field list/limits/defaults/rendering, shared by index.html (the
// Policies & Terms editor + its preview), booking.html (the quote-request
// terms checkbox link) and quote.html (the quote-acceptance terms line), so
// a business's wording — and how safely it's rendered — can never drift
// between where it's edited and where a customer actually sees it.
window.TK_POLICIES = (function(){
  const FIELDS=[
    {key:'customerAgreementWording',label:'Customer agreement wording',limit:400,
      default:'By accepting this quote you agree to the terms and conditions provided by [Business Name].'},
    {key:'quoteTerms',label:'Quote terms and conditions',limit:2000,
      default:'This quote is valid for 30 days from the date issued. Pricing assumes reasonable site access and available water/power on site unless noted otherwise. A firm booking is confirmed once the quote is accepted.'},
    {key:'cancellationPolicy',label:'Cancellation policy',limit:1000,
      default:'We ask for at least 24 hours notice to reschedule or cancel a booked job. Late cancellations may incur a call-out fee.'},
    {key:'paymentTerms',label:'Payment terms',limit:1000,
      default:'Payment is due within 7 days of the invoice date unless otherwise agreed.'},
    {key:'warrantyInfo',label:'Warranty information',limit:1000,
      default:'If you\'re not satisfied with any area we\'ve cleaned, let us know within 7 days and we\'ll come back and make it right at no extra cost.'},
    {key:'additionalNotes',label:'Additional notes',limit:1000,default:''}
  ];
  // Falls back to the field's own default (not a blank string) whenever a
  // business hasn't set/saved that field yet, so a freshly signed-up
  // business's customers see a sensible real policy immediately, not a gap.
  function getField(policies,key){
    const f=FIELDS.find(x=>x.key===key);
    const raw=(policies&&policies[key]!=null&&policies[key]!=='')?policies[key]:(f?f.default:'');
    return raw||'';
  }
  function withBizName(text,bizName){
    return (text||'').split('[Business Name]').join(bizName||'the business');
  }
  // The ONLY renderer for business-authored policy text anywhere in the
  // app: escapes HTML first (this is free text typed by a business owner,
  // ultimately displayed to THEIR customers on a public page — never
  // trusted as raw HTML) then applies a small, deliberately limited set of
  // plain-text conventions — blank line = new paragraph, "- " prefix = a
  // bullet list item — rather than a full contenteditable rich-text editor
  // storing raw HTML, which would be a real stored-XSS vector with no
  // sanitizer library in this build-step-free project. This is intentionally
  // simpler than a WYSIWYG editor, in exchange for being impossible to
  // break out of no matter what a business types.
  function renderPolicyHtml(text){
    if(!text)return '';
    const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return esc(text).replace(/\r\n/g,'\n').split(/\n{2,}/).map(block=>{
      const lines=block.split('\n').filter(l=>l.trim().length);
      if(!lines.length)return '';
      if(lines.every(l=>/^\s*-\s+/.test(l))){
        return '<ul>'+lines.map(l=>'<li>'+l.replace(/^\s*-\s+/,'')+'</li>').join('')+'</ul>';
      }
      return '<p>'+lines.join('<br>')+'</p>';
    }).join('');
  }
  return {FIELDS, getField, withBizName, renderPolicyHtml};
})();
