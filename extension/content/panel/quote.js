import { isCustomLine } from './quote-pricing.js';
import { TurnKeyApi } from '../../api/client-bridge.js';
import { learningPricing, allocatePrices, observationLines, REASONS } from './quote-learning.js';
import { measurementQuantity, measurementForService } from './measurements.js';
import { renderCustomerContext, requestedServices } from './customer-context.js';
// Instant Quote panel (build brief §9-§12) — turns the measurements list
// into priced service lines using TurnKey's own shared pricing engine
// (vendor/pricing-engine.js, the exact same window.TK_PRICING loaded by
// index.html/booking.html/quote.html — not a second pricing implementation),
// then creates the quote in Supabase using the same table shape
// syncRecordToSupabase() writes in index.html.
function money(n) {
  const amount=Math.round((Math.abs(n)+Number.EPSILON)*10)/10;
  return (n<0&&amount!==0?'-':'')+'NZ$'+amount.toLocaleString('en-NZ',{minimumFractionDigits:1,maximumFractionDigits:1});
}

// Every value interpolated into innerHTML/attribute strings below can come
// from the operator's own typed input or a customer's stored name/address
// — both are untrusted as far as HTML is concerned. Escaped at the point
// of interpolation rather than trusted upstream, since the CRM's own
// customer records can contain anything a past form submission put there.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Renders the quote builder into `container`. `ctx` = {measurements, address, TK_PRICING, business, customers}.
 * `actions` = {onCreateQuote(payload), onSearchCustomer(query), onCancel}.
 */
export function renderQuotePanel(container, ctx, actions) {
  const { SERVICES } = ctx.TK_PRICING;
  // Each measurement becomes one candidate line, defaulted ON. `m.service`
  // was already resolved once, when the measurement was finished (see
  // app.js's guessServiceForCategory()) — reused here rather than
  // re-guessing, so the service shown here always matches what's stored.
  const quoteKey=crypto.randomUUID();
  let nextKey=0, pendingTotal=null, totalError='';
  const key=()=>`earth-${nextKey++}`;
  const savedServices=ctx.boundJob?.details?.services || [];
  const matchedServices=new Set();
  function savedMeasuredLine(m,svc) {
    const candidates=savedServices.filter(line=>!isCustomLine(line)&&line.svc===svc&&!matchedServices.has(line));
    const byId=candidates.filter(line=>(m.lineKey&&line.lineKey===m.lineKey)||line.measurementId===m.id||line.lineKey===m.id);
    const byQuantity=candidates.filter(line=>Number(line.qty)===measurementQuantity(m,SERVICES[svc]));
    // Ambiguous identical services must not borrow another outline's name.
    const match=byId.length===1?byId[0]:byQuantity.length===1?byQuantity[0]:null;
    if(match)matchedServices.add(match);
    return match;
  }
  const lineState = ctx.measurements.map((m) => {
    const svc=m.service || Object.keys(SERVICES)[0],saved=savedMeasuredLine(m,svc);
    return {
      lineKey:key(),measurementId:m.id,include:true,svc,qty:m.size,unit:m.unit,
      categoryLabel:m.categoryLabel,
      label:saved?.label ?? m.categoryLabel ?? SERVICES[svc].label,
      storeys:Number(m.storeys)||Number(saved?.storeys)||1
    };
  });
  let localMargin=ctx.TK_COST.targetMargin(ctx.TK_COST.COST_INPUTS.targetMargin), travelKm=ctx.TK_COST.COST_INPUTS.avgKm;
  const estimatedAt=new Date().toISOString();
  let access=ctx.boundJob?.details?.assumptions?.access || 'standard';
  const priceModel=(ignoreManual=false)=>learningPricing(ctx.TK_PRICING,ctx.TK_COST,computeLines().map(l=>ignoreManual?(isCustomLine(l)?{...l,label:l.label||'Custom item',qty:l.qty>0?l.qty:1,unitPrice:Number.isFinite(l.unitPrice)&&l.unitPrice>=0?l.unitPrice:0,customCost:Number.isFinite(l.customCost)&&l.customCost>=0?l.customCost:null}:{...l,manualPrice:undefined,label:undefined}):l),{allowZeroTotal:ignoreManual,targetMargin:localMargin,travelKm,estimatedAt,access,engine:ctx.TK_PRICE_LEARNING,learningState:ctx.learningState,businessId:ctx.business?.id});
  const savedWindows=savedServices.filter(line=>line.svc==='windows'&&!matchedServices.has(line));
  const wantsWindows = ctx.manualWindows || savedWindows.length || requestedServices(ctx.boundCustomer || {},ctx.boundJob).some(service => service.service_id === 'windows');
  const extraLines = wantsWindows ? (savedWindows.length?savedWindows:[{}]).map(line=>({
    lineKey:key(),include:true,svc:'windows',label:line.label ?? SERVICES.windows.label,
    qty:Number.isInteger(line.qty)&&line.qty>0?line.qty:0
  })) : []; // ad-hoc services not tied to a drawn measurement
  // Explicit provenance on new custom lines avoids guessing whether an old
  // service was a drawn measurement or an additional manual service.
  savedServices.filter(line=>line.manual===true&&line.svc!=='windows'&&!matchedServices.has(line)&&SERVICES[line.svc]).forEach(line=>{
    extraLines.push({lineKey:key(),include:true,svc:line.svc,label:line.label??SERVICES[line.svc].label,qty:Number(line.qty)||0,storeys:line.storeys||1});
  });
  savedServices.filter(isCustomLine).forEach(line=>extraLines.push({...line,lineKey:key(),include:true}));
  // When this tab was opened from an existing customer's "Build quote"
  // button (see app.js's loadBoundCustomerContext()), the quote is for
  // THAT customer and nothing else — no re-picking, no "new customer" path.
  const customerLocked = !!ctx.boundCustomer;
  let selectedCustomer = ctx.boundCustomer ? { ...ctx.boundCustomer } : null; // {id,name} | null = "new customer"
  let newCustomer = { name: '', phone: '', email: '' };

  const activeRows=()=>lineState.concat(extraLines).filter(l=>l.include);
  const rawQuantity=l=>l.measurementId?measurementQuantity(ctx.measurements.find(m=>m.id===l.measurementId),SERVICES[l.svc]):l.qty;
  const displayLabel=row=>row.label.trim() || (isCustomLine(row)?'':SERVICES[row.svc].label);
  function computeLines() {
    return activeRows().map(l=>isCustomLine(l)?{lineKey:l.lineKey,svc:'custom',pricingMode:'fixed',label:displayLabel(l),qty:l.qty,unit:l.unit,unitPrice:l.unitPrice,customCost:l.customCost,manual:true}:({lineKey:l.lineKey,measurementId:l.measurementId,label:displayLabel(l),manual:!l.measurementId,svc:l.svc,qty:l.appliedQuantity??rawQuantity(l),originalQuantity:l.originalQuantity??rawQuantity(l),manualPrice:l.manualPrice,distributedPrice:l.distributedPrice,reason:l.reason,verifiedQuantity:l.verifiedQuantity,measurementReason:l.measurementReason,...(l.svc==='housewash'?{storeys:Number(l.storeys)||1}:{})}));
  }
  function changeService(line,svc) {
    line.svc=svc;
    // A different unit/service needs its own quantity verification and reason.
    delete line.appliedQuantity;delete line.originalQuantity;delete line.verifiedQuantity;delete line.measurementReason;delete line.reason;delete line.manualPrice;delete line.distributedPrice;
    if(svc==='housewash'&&!line.storeys)line.storeys=1;
  }
  function priceCard(l,i,model) {
    const rec=model.recommendations[i],row=activeRows()[i];
    if(isCustomLine(l))return `<section class="tk-learning-line" data-service-price="custom"><div class="tk-price-line"><span data-line-title="${escapeHtml(l.lineKey)}">${escapeHtml(l.label)} · ${l.qty} ${escapeHtml(l.unit)}</span><strong>${money(l.fixedPrice)}</strong></div><p class="tk-modal-sub">Custom fixed price · excluded from measurement and price learning.</p></section>`;
    const hint=Number(rec.measurement?.suggestedQuantity);
    const hasHint=ctx.learningState?.settings?.enabled!==false&&Number(rec.measurement?.sampleCount)>=Math.max(5,ctx.learningState?.settings?.minSamples||5)&&Math.abs((rec.measurement?.factor||1)-1)>.00001;
    return `<section class="tk-learning-line" data-service-price="${escapeHtml(l.svc)}">
      <div class="tk-price-line"><span><span data-line-title="${escapeHtml(l.lineKey)}">${escapeHtml(displayLabel(row))}</span> · ${l.qty} ${escapeHtml(SERVICES[l.svc]?.unit)}${l.svc==='housewash'?' · '+Number(l.storeys||1)+' storey':''}</span><strong>${money(l.fixedPrice)}</strong></div>
      <p class="tk-modal-sub">Configured ${money(rec.configuredPrice)} · Target margin floor ${money(rec.marginFloor)}<br>Base ${money(rec.baselinePrice)} → Learned adjustment ${rec.learnedAdjustment<0?'−':'+'}${money(Math.abs(rec.learnedAdjustment))} → Recommended ${money(rec.recommendedPrice)}</p>
      <p class="tk-modal-sub">${escapeHtml(rec.explanation||'Base price shown until enough eligible quotes are available (default: 5 distinct quotes).')} · ${Number(rec.sampleCount)||0} quotes · Confidence: ${escapeHtml(rec.confidence??'insufficient')}</p>
      <label class="tk-price-line">Final service price (GST inclusive dollars)<input class="tk-qty-input" style="width:120px" aria-label="Final service price for ${escapeHtml(SERVICES[l.svc]?.label)}" data-line-price="${escapeHtml(l.lineKey)}" type="number" min="0" step="0.01" value="${row.manualPrice==null?l.fixedPrice:Number.isFinite(row.manualPrice)?row.manualPrice:''}"></label>
      <button type="button" class="tk-link-btn" data-reset-line="${escapeHtml(l.lineKey)}" ${row.manualPrice==null?'hidden':''}>Reset this service to recommended</button>
      <p class="tk-error" role="status" data-line-floor-warning ${l.fixedPrice+0.001<rec.marginFloor?'':'hidden'}>This service price is below its target margin floor. You can save this manual price.</p>
      <label class="tk-quote-field">Price learning reason (optional)<select class="tk-select" aria-label="Override reason" data-line-reason="${escapeHtml(l.lineKey)}"><option value="">Automatic for edited measured-service prices</option>${Object.entries(REASONS).map(([value,label])=>`<option value="${value}" ${row.reason===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <p class="tk-modal-sub">Discounts never train pricing. Pricing corrections and explained difficult access can train matching contexts.</p>
      <div class="tk-measurement-correction"><p class="tk-modal-sub">Original quantity: ${escapeHtml(row.originalQuantity??rawQuantity(row))} ${escapeHtml(SERVICES[l.svc]?.unit)}. Applying a verified quantity changes this service quantity and price only; it does not move the outline or change the geometry.</p>
      ${hasHint&&Number.isFinite(hint)&&hint>0?`<p class="tk-modal-sub">Learned measurement hint: ${hint.toFixed(2)} ${escapeHtml(SERVICES[l.svc]?.unit)} (${Number(rec.measurement.sampleCount)||0} quotes). Review before applying.</p><button type="button" class="tk-link-btn" data-measure-hint="${escapeHtml(l.lineKey)}" data-hint="${hint}">Use hint as verified input</button>`:''}
      <label class="tk-quote-field">Verified quantity<input class="tk-qty-input" data-verified="${escapeHtml(l.lineKey)}" aria-label="Verified quantity" type="number" min="0.01" step="${SERVICES[l.svc]?.unit==='panes'?'1':'0.01'}" value="${escapeHtml(row.verifiedDraft??row.verifiedQuantity??'')}"></label>
      <label class="tk-quote-field">Measurement reason<select class="tk-select" data-measure-reason="${escapeHtml(l.lineKey)}" aria-label="Measurement reason"><option value="">Choose how quantity was verified</option>${Object.entries({verified_measurement:'Verified measurement',manual_measurement:'Manual measurement',site_measurement:'Measured on site',measurement_correction:'Measurement correction'}).map(([value,label])=>`<option value="${value}" ${(row.measurementDraft??row.measurementReason)===value?'selected':''}>${label}</option>`).join('')}</select></label>
      <button type="button" class="tk-link-btn" data-apply-quantity="${escapeHtml(l.lineKey)}">Apply verified quantity</button>
      ${row.measurementError?`<p class="tk-error" role="alert">${escapeHtml(row.measurementError)}</p>`:''}</div>
    </section>`;
  }

  // Offer only services with an available quantity for this outline.
  function renderServiceOptions(selected, measurement) {
    return Object.entries(SERVICES)
      .filter(([, service]) => !measurement || measurementQuantity(measurement, service) !== null)
      .map(([key, service]) => `<option value="${escapeHtml(key)}" ${key === selected ? 'selected' : ''}>${escapeHtml(service.label)} (${escapeHtml(service.unit)})</option>`).join('');
  }

  function measuredQuantity(line) {
    return measurementQuantity(ctx.measurements.find(m => m.id === line.measurementId), SERVICES[line.svc]);
  }


  function paint() {
    const lines = computeLines();
    let model, pricingError='';
    try{model=priceModel();}catch(error){pricingError=error.message;try{model=priceModel(true);}catch{model={total:0,exGst:0,gst:0,breakdown:null};}}
    const {total,exGst=0,gst=0,breakdown:bd}=model;

    container.innerHTML = `
      <div class="tk-modal-backdrop">
        <div class="tk-modal tk-quote-modal">
          <div class="tk-modal-head">
            <div>
              <h3>Create Instant Quote</h3>
              <p class="tk-modal-sub">${escapeHtml(ctx.address) || 'No address set'}</p>
            </div>
            <button type="button" class="tk-icon-btn" data-close aria-label="Close">×</button>
          </div>
          <div class="tk-modal-body">
            ${renderCustomerContext(selectedCustomer, ctx.boundJob, SERVICES)}
            <div class="tk-section-label">Measurements &amp; services</div>
            <p class="tk-modal-sub">Driveways use area (m²); house wash uses perimeter (m). Reuse a closed outline for another compatible service. Windows require a manual pane count.</p>
            <div class="tk-requested-actions">${requestedServices(selectedCustomer || {},ctx.boundJob).filter(s => SERVICES[s.service_id]).map(s => `<button type="button" class="tk-link-btn" data-add-request="${escapeHtml(s.service_id)}">+ ${escapeHtml(SERVICES[s.service_id].label)} (manual ${escapeHtml(SERVICES[s.service_id].unit)})</button>`).join('')}</div>
            <div class="tk-lines" data-role="lines">
              ${lineState
                .map(
                  (l, i) => `
                <div class="tk-line-row">
                  <input type="checkbox" aria-label="Include ${escapeHtml(l.categoryLabel)}" data-line="${i}" ${l.include ? 'checked' : ''}/>
                  <input type="text" class="tk-input" aria-label="Service name" maxlength="120" placeholder="${escapeHtml(SERVICES[l.svc]?.label)}" data-line-label="${escapeHtml(l.lineKey)}" value="${escapeHtml(l.label)}"/>
                  <select class="tk-select" data-line-svc="${i}">${renderServiceOptions(l.svc, ctx.measurements.find(m => m.id === l.measurementId))}</select>
                  <span class="tk-line-qty">${measuredQuantity(l)} ${escapeHtml(SERVICES[l.svc]?.unit)}</span>
                  ${l.svc==='housewash'?`<label class="tk-quote-field">House levels<select class="tk-select" aria-label="House levels for ${escapeHtml(l.categoryLabel)}" data-storeys="${i}">${Object.entries(ctx.TK_PRICING.STOREY_TYPES).map(([n,v])=>`<option value="${n}" ${Number(l.storeys)===Number(n)?'selected':''}>${escapeHtml(v.label)}</option>`).join('')}</select></label>`:''}
                  <button type="button" class="tk-link-btn" data-reuse="${i}">Reuse outline</button>
                </div>`
                )
                .join('')}
              ${extraLines
                .map(
                  (l, i) => `
                <div class="tk-line-row">
                  <input type="checkbox" data-extra="${i}" ${l.include ? 'checked' : ''}/>
                  <input type="text" class="tk-input" aria-label="Service name" maxlength="120" placeholder="${escapeHtml(SERVICES[l.svc]?.label)}" data-line-label="${escapeHtml(l.lineKey)}" value="${escapeHtml(l.label)}"/>
                  ${isCustomLine(l)?`<input type="number" class="tk-qty-input" aria-label="Custom quantity" data-custom-field="qty" data-custom-key="${escapeHtml(l.lineKey)}" min="0.01" step="any" value="${escapeHtml(l.qty)}">
                  <select class="tk-select" aria-label="Custom unit" data-custom-field="unit" data-custom-key="${escapeHtml(l.lineKey)}">${['item','hour','day'].map(u=>`<option ${l.unit===u?'selected':''}>${u}</option>`).join('')}</select>
                  <label>Unit price (GST inclusive)<input class="tk-qty-input" type="number" aria-label="Custom unit price" data-custom-field="unitPrice" data-custom-key="${escapeHtml(l.lineKey)}" min="0" step="0.01" value="${Number.isFinite(l.unitPrice)?l.unitPrice:''}"></label>
                  <label>Total delivery cost (ex GST, optional)<input class="tk-qty-input" type="number" aria-label="Custom delivery cost" data-custom-field="customCost" data-custom-key="${escapeHtml(l.lineKey)}" min="0" step="0.01" placeholder="Unknown" value="${escapeHtml(l.customCost??'')}"></label>`:`<select class="tk-select" data-extra-svc="${i}">${renderServiceOptions(l.svc, null)}</select>
                  <input type="number" min="0" step="${SERVICES[l.svc]?.unit === 'panes' ? '1' : '0.1'}" class="tk-qty-input" aria-label="Manual ${escapeHtml(SERVICES[l.svc]?.unit)} for ${escapeHtml(SERVICES[l.svc]?.label)}" data-extra-qty="${i}" value="${l.qty || ''}"/>
                  <span class="tk-line-qty">Manual ${escapeHtml(SERVICES[l.svc]?.unit)}</span>
                  ${l.svc==='housewash'?`<label class="tk-quote-field">House levels<select class="tk-select" aria-label="House levels for manual ${escapeHtml(SERVICES[l.svc]?.label)}" data-extra-storeys="${i}">${Object.entries(ctx.TK_PRICING.STOREY_TYPES).map(([n,v])=>`<option value="${n}" ${Number(l.storeys||1)===Number(n)?'selected':''}>${escapeHtml(v.label)}</option>`).join('')}</select></label>`:''}
                `}</div>`
                )
                .join('')}
            </div>
            <button type="button" class="tk-link-btn" data-add-extra>+ Add a manual service</button>
            <button type="button" class="tk-link-btn" data-add-custom>+ Add a custom fixed-price item</button>

            <button type="button" class="tk-link-btn" data-add-windows>+ Windows — manual pane count</button>

            <div class="tk-section-label">Customer</div>
            <div class="tk-customer-picker">
              ${
                customerLocked
                  ? `<div class="tk-customer-chip tk-customer-locked">${escapeHtml(selectedCustomer.name || 'Saved customer')}<span class="tk-modal-sub">Saved to this customer — opened from their TurnKey profile, so this draft goes straight back to them.</span></div>`
                  : selectedCustomer
                  ? `<div class="tk-customer-chip">${escapeHtml(selectedCustomer.name)} <button type="button" data-clear-customer>Change</button></div>`
                  : `
                <input type="text" class="tk-input" placeholder="Search TurnKey customers…" data-role="customer-search"/>
                <div class="tk-customer-results" data-role="customer-results"></div>
                <div class="tk-new-customer">
                  <input type="text" class="tk-input" placeholder="Name" data-new="name" value="${escapeHtml(newCustomer.name)}"/>
                  <input type="text" class="tk-input" placeholder="Phone" data-new="phone" value="${escapeHtml(newCustomer.phone)}"/>
                  <input type="text" class="tk-input" placeholder="Email" data-new="email" value="${escapeHtml(newCustomer.email)}"/>
                </div>`
              }
            </div>

            <div class="tk-price-block">
              <section class="tk-quote-assumptions" aria-label="Site access settings"><div><h4>Property &amp; access</h4><p>Adjust for building height and conditions at this property.</p></div><label class="tk-quote-field">Access difficulty<select class="tk-select" data-access aria-label="Access difficulty"><option value="easy" ${access==='easy'?'selected':''}>Easy · open, ground-level access</option><option value="standard" ${access==='standard'?'selected':''}>Standard · typical access</option><option value="hard" ${access==='hard'?'selected':''}>Difficult · steep, tight or high access</option></select></label></section>
              <div class="tk-section-label">Itemised service prices</div>
              <p class="tk-modal-sub" role="status">${escapeHtml(ctx.learningWarning||(!ctx.TK_PRICE_LEARNING||!ctx.learningState?'Learning unavailable. Base recommendations and manual service prices remain available.':'Learning uses only your signed-in business. Manage settings and resets in TurnKey.'))}</p>
              ${model.engineError?`<p class="tk-error" role="status">${escapeHtml(model.engineError)}</p>`:''}
              <div data-role="itemised-prices">${(model.lines||[]).map((l,i)=>priceCard(l,i,model)).join('')}</div>
              ${totalError?`<p class="tk-error" role="alert">${escapeHtml(totalError)}</p>`:''}
              <div class="tk-section-label">Internal delivery estimate</div>
              <p class="tk-modal-sub">Based on your business’s saved cost settings. Travel is an estimate, not a live route calculation.</p>
              ${bd ? [ ['Labour + setup ('+bd.labourHrs.toFixed(1)+' hours × '+ctx.TK_COST.COST_INPUTS.crew+' crew)',bd.wageCost],['Materials / chemicals',bd.unsetChemicals?.length?null:bd.chem],['Travel / fuel',bd.fuelCost],['Equipment',bd.equipmentCost],['Consumables',bd.consumablesCost],['Allocated overheads',bd.overheadCost],...(bd.knownCost!=null?[['Known costs (including custom)',bd.knownCost]]:[]),['Total estimated costs (ex GST)',bd.costUnrounded] ].map(([label,value])=>`<div class="tk-price-line"><span>${label}</span><strong data-cost-label="${escapeHtml(label)}">${value===null?'Incomplete':money(value)}</strong></div>`).join('') : ''}
              <p class="tk-error" role="status" data-unknown-cost ${bd?.costComplete===false?'':'hidden'}>Custom delivery cost unknown. Total cost, profit and margin are incomplete.</p>
              ${bd?.unsetChemicals?.length?`<p class="tk-error" role="status">Supplier cost not set: ${bd.unsetChemicals.map(id=>escapeHtml(ctx.TK_COST.CHEMICALS[id].label)).join(', ')}. Costs, recommended price and margin are incomplete. Enter actual supplier costs in TurnKey Pricing.</p>`:''}
              <label class="tk-price-line">Round-trip travel estimate (km) <input class="tk-qty-input" aria-label="Round-trip travel estimate in km" data-travel type="number" min="0" step="0.1" value="${travelKm}"></label>
              <label class="tk-price-line">Target gross margin (%) <input class="tk-qty-input" aria-label="Target gross margin" data-margin type="number" min="0" max="99" step="1" value="${Math.round(localMargin*100)}"></label>
              <div class="tk-price-line"><span>Recommended customer price${ctx.TK_COST.COST_INPUTS.gstRegistered?' (incl GST)':''}</span><strong data-recommended>${money(bd?.recommended||0)}</strong></div>
              <label class="tk-price-line">Final customer price${ctx.TK_COST.COST_INPUTS.gstRegistered?' (incl GST)':''} <input class="tk-qty-input" style="width:120px" aria-label="Final customer price" data-price type="number" min="1" step="0.01" value="${pendingTotal??total}"></label>
              <button type="button" class="tk-link-btn" data-discard-total>Discard entered total (keep service prices)</button>
              <button type="button" class="tk-link-btn" data-distribute-total>Distribute entered total across services (replaces manual line prices)</button>
              <p class="tk-modal-sub" data-price-adjustment>The total saves as the exact sum of service prices. An entered total takes effect only when you choose Distribute.</p>
              <button type="button" class="tk-link-btn" data-use-recommended>Reset all services to recommended price</button>
              <div class="tk-price-line"><span>Expected gross profit</span><strong data-profit>${model.profit===null?'Unknown':money(model.profit||0)}</strong></div>
              <div class="tk-price-line"><span>Expected gross margin</span><strong data-margin-result>${model.marginPct===null?'Unknown':(model.marginPct||0).toFixed(1)+'%'}</strong></div>
              <p role="status" class="tk-error" data-total-floor-warning ${bd&&model.marginPct!=null&&model.marginPct+0.01<localMargin*100?'':'hidden'}>This price is below your target gross margin.</p>
              <div class="tk-price-line"><span>Subtotal${ctx.TK_COST.COST_INPUTS.gstRegistered?' (ex GST)':''}</span><span data-subtotal>${money(exGst)}</span></div>
              <div class="tk-price-line"><span>${ctx.TK_COST.COST_INPUTS.gstRegistered?'GST':'GST (not registered)'}</span><span data-gst>${money(gst)}</span></div>
              <div class="tk-price-total"><span>Final customer total</span><span data-final-total>${money(total)}</span></div>
              <p class="tk-error" role="alert" data-pricing-error ${pricingError?'':'hidden'}>${escapeHtml(pricingError)}</p>
              <p class="tk-modal-sub">Margin uses revenue excluding GST. These are estimated costs, not actual job expenses. Your internal costs stay off the customer quote.</p>
            </div>
          </div>
          <div class="tk-modal-foot">
            <button type="button" class="tk-btn" data-close>Cancel</button>
            <button type="button" class="tk-btn tk-btn-accent" data-create ${lines.length&&!pricingError ? '' : 'disabled'}>Create Quote</button>
          </div>
        </div>
      </div>`;

    const rowFor=key=>activeRows().find(l=>l.lineKey===key);
    container.querySelector('[data-add-custom]').addEventListener('click',()=>{
      extraLines.push({lineKey:key(),include:true,svc:'custom',pricingMode:'fixed',label:'',qty:1,unit:'item',unitPrice:null,customCost:null});paint();
    });
    container.querySelectorAll('[data-custom-field]').forEach(input=>input.addEventListener(input.tagName==='SELECT'?'change':'input',()=>{
      const row=lineState.concat(extraLines).find(l=>l.lineKey===input.dataset.customKey),field=input.dataset.customField;
      row[field]=field==='unit'?input.value:input.value===''?null:Number(input.value);
      pendingTotal=null;refreshPricing();
    }));
    container.querySelectorAll('[data-line-label]').forEach(input=>{
      const update=()=>{
        const row=lineState.concat(extraLines).find(l=>l.lineKey===input.dataset.lineLabel);
        row.label=input.value;
        const title=container.querySelector(`[data-line-title="${input.dataset.lineLabel}"]`);
        if(title)title.textContent=displayLabel(row);
        refreshPricing();
      };
      input.addEventListener('input',update);
      input.addEventListener('change',update);
    });
    // Never replace a price input or Create button on input/blur. In-place
    // updates preserve decimal typing/caret and the pending click target.
    function updateServicePrice(input) {
      rowFor(input.dataset.linePrice).manualPrice=input.value===''?NaN:Number(input.value);
      delete rowFor(input.dataset.linePrice).distributedPrice;
      pendingTotal=null;
      input.closest('[data-service-price]').querySelector('[data-reset-line]').hidden=false;
      refreshPricing();
    }
    function refreshPricing() {
      let model,error='';
      try{model=priceModel();}catch(e){error=e.message;}
      const errorEl=container.querySelector('[data-pricing-error]');errorEl.textContent=error;errorEl.hidden=!error;
      container.querySelector('[data-create]').disabled=!!error||!computeLines().length;
      if(!model)return;
      container.querySelectorAll('[data-service-price]').forEach((card,i)=>{
        card.querySelector('strong').textContent=money(model.lines[i].fixedPrice);
        if(isCustomLine(model.lines[i]))card.querySelector('[data-line-title]').textContent=model.lines[i].label+' · '+model.lines[i].qty+' '+model.lines[i].unit;
        if(!card.querySelector('[data-line-floor-warning]'))return;
        card.querySelector('[data-line-floor-warning]').hidden=model.lines[i].fixedPrice+0.001>=model.recommendations[i].marginFloor;
      });
      container.querySelectorAll('[data-cost-label]').forEach(el=>{
        if(el.dataset.costLabel==='Total estimated costs (ex GST)')el.textContent=model.breakdown.costUnrounded===null?'Incomplete':money(model.breakdown.costUnrounded);
        if(el.dataset.costLabel==='Known costs (including custom)')el.textContent=money(model.breakdown.knownCost);
      });
      container.querySelector('[data-unknown-cost]').hidden=model.breakdown?.costComplete!==false;
      container.querySelector('[data-price]').value=pendingTotal??model.total;
      container.querySelector('[data-final-total]').textContent=money(model.total);
      container.querySelector('[data-subtotal]').textContent=money(model.exGst);
      container.querySelector('[data-gst]').textContent=money(model.gst);
      container.querySelector('[data-profit]').textContent=model.profit===null?'Unknown':money(model.profit);
      container.querySelector('[data-margin-result]').textContent=model.marginPct===null?'Unknown':model.marginPct.toFixed(1)+'%';
      container.querySelector('[data-total-floor-warning]').hidden=model.marginPct==null||model.marginPct+0.01>=localMargin*100;
    }
    container.querySelectorAll('[data-line-price]').forEach(input=>{
      input.addEventListener('input',()=>updateServicePrice(input));
      input.addEventListener('change',()=>updateServicePrice(input));
    });
    container.querySelectorAll('[data-reset-line]').forEach(button=>button.addEventListener('click',()=>{const row=rowFor(button.dataset.resetLine);delete row.manualPrice;delete row.reason;pendingTotal=null;paint();}));
    container.querySelectorAll('[data-line-reason]').forEach(input=>input.addEventListener('change',()=>{rowFor(input.dataset.lineReason).reason=input.value;}));
    container.querySelectorAll('[data-verified]').forEach(input=>input.addEventListener('input',()=>{rowFor(input.dataset.verified).verifiedDraft=input.value;}));
    container.querySelectorAll('[data-measure-reason]').forEach(input=>input.addEventListener('change',()=>{rowFor(input.dataset.measureReason).measurementDraft=input.value;}));
    container.querySelectorAll('[data-measure-hint]').forEach(button=>button.addEventListener('click',()=>{rowFor(button.dataset.measureHint).verifiedDraft=button.dataset.hint;paint();}));
    container.querySelectorAll('[data-apply-quantity]').forEach(button=>button.addEventListener('click',()=>{
      const row=rowFor(button.dataset.applyQuantity),value=Number(row.verifiedDraft),reason=(row.measurementDraft||'').trim();
      if(!Number.isFinite(value)||value<=0||(SERVICES[row.svc]?.unit==='panes'&&!Number.isInteger(value))||!reason){row.measurementError='Enter a positive verified quantity (whole panes for windows) and a measurement reason, then Apply.';paint();return;}
      row.originalQuantity??=rawQuantity(row);row.appliedQuantity=value;row.verifiedQuantity=value;row.measurementReason=reason;row.reason='measurement_correction';delete row.measurementError;pendingTotal=null;paint();
    }));
    container.querySelector('[data-price]').addEventListener('input',e=>{pendingTotal=e.target.value;});
    container.querySelector('[data-discard-total]').addEventListener('click',()=>{pendingTotal=null;totalError='';paint();});
    container.querySelector('[data-distribute-total]').addEventListener('click',()=>{
      try {
        const total=Number(pendingTotal),model=priceModel();
        if(activeRows().some(isCustomLine))throw Error('Edit custom unit prices directly; total distribution is available for measured services only.');
        if(!pendingTotal||!Number.isFinite(total)||total<1)throw Error('Enter a positive total before distributing.');
        const amounts=allocatePrices(total,model.lines.map(l=>l.fixedPrice));
        activeRows().forEach((row,i)=>{row.manualPrice=amounts[i];row.distributedPrice=true;row.reason='';});pendingTotal=null;totalError='';
      }catch(error){totalError=error.message;}
      paint();
    });
    container.querySelector('[data-margin]').addEventListener('change',e=>{const value=Number(e.target.value)/100;if(Number.isFinite(value)&&value>=0&&value<1)localMargin=value;paint();});
    container.querySelector('[data-travel]').addEventListener('change',e=>{const value=Number(e.target.value);if(Number.isFinite(value)&&value>=0)travelKm=value;paint();});
    container.querySelector('[data-access]').addEventListener('change',e=>{access=e.target.value;paint();});
    container.querySelectorAll('[data-storeys]').forEach(select=>select.addEventListener('change',()=>{lineState[Number(select.dataset.storeys)].storeys=Number(select.value);paint();}));
    container.querySelectorAll('[data-extra-storeys]').forEach(select=>select.addEventListener('change',()=>{extraLines[Number(select.dataset.extraStoreys)].storeys=Number(select.value);paint();}));
    container.querySelector('[data-use-recommended]').addEventListener('click',()=>{lineState.concat(extraLines).forEach(row=>{delete row.manualPrice;delete row.reason;});pendingTotal=null;totalError='';paint();});
    container.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => actions.onCancel()));
    container.querySelectorAll('[data-line]').forEach((cb) =>
      cb.addEventListener('change', () => {
        lineState[+cb.getAttribute('data-line')].include = cb.checked;
        paint();
      })
    );
    container.querySelectorAll('[data-line-svc]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const line=lineState[+sel.getAttribute('data-line-svc')];changeService(line,sel.value);
        paint();
      })
    );
    container.querySelectorAll('[data-extra]').forEach((cb) =>
      cb.addEventListener('change', () => {
        extraLines[+cb.getAttribute('data-extra')].include = cb.checked;
        paint();
      })
    );
    container.querySelectorAll('[data-extra-svc]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const line=extraLines[+sel.getAttribute('data-extra-svc')];changeService(line,sel.value);
        paint();
      })
    );
    container.querySelectorAll('[data-extra-qty]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const row=extraLines[+inp.getAttribute('data-extra-qty')];row.qty=parseFloat(inp.value)||0;delete row.appliedQuantity;delete row.originalQuantity;delete row.verifiedQuantity;delete row.measurementReason;
        paint();
      })
    );
    container.querySelectorAll('[data-reuse]').forEach(button => button.addEventListener('click', () => {
      const original = lineState[+button.getAttribute('data-reuse')];
      const measurement = ctx.measurements.find(m => m.id === original.measurementId);
      const next = Object.keys(SERVICES).find(key => key !== original.svc && measurementQuantity(measurement, SERVICES[key]) !== null);
      lineState.push({lineKey:key(),measurementId:original.measurementId,categoryLabel:original.categoryLabel,label:original.categoryLabel || SERVICES[next||original.svc].label,storeys:original.storeys,svc:next||original.svc,include:true});
      paint();
    }));
    const addManual = svc => { extraLines.push({lineKey:key(),include:true,svc,label:SERVICES[svc].label,qty:0}); paint(); };
    container.querySelector('[data-add-windows]').addEventListener('click', () => addManual('windows'));
    container.querySelectorAll('[data-add-request]').forEach(button => button.addEventListener('click', () => addManual(button.getAttribute('data-add-request'))));
    const addExtraBtn = container.querySelector('[data-add-extra]');
    if (addExtraBtn)
      addExtraBtn.addEventListener('click', () => {
        extraLines.push({ lineKey:key(), include: true, svc: Object.keys(SERVICES)[0], label: SERVICES[Object.keys(SERVICES)[0]].label, qty: 0 });
        paint();
      });

    const searchInput = container.querySelector('[data-role="customer-search"]');
    if (searchInput) {
      let debounce;
      searchInput.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          const results = await actions.onSearchCustomer(searchInput.value);
          const resultsEl = container.querySelector('[data-role="customer-results"]');
          if (!resultsEl) return;
          resultsEl.innerHTML = results
            .map((c) => `<button type="button" class="tk-customer-result" data-pick="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.address ? ' — ' + escapeHtml(c.address) : ''}</button>`)
            .join('');
          resultsEl.querySelectorAll('[data-pick]').forEach((b) =>
            b.addEventListener('click', () => {
              const id = b.getAttribute('data-pick');
              selectedCustomer = { ...results.find((r) => r.id === id) };
              paint();
            })
          );
        }, 200);
      });
    }
    container.querySelectorAll('[data-new]').forEach((inp) =>
      inp.addEventListener('input', () => {
        newCustomer[inp.getAttribute('data-new')] = inp.value;
      })
    );
    const clearCustomerBtn = container.querySelector('[data-clear-customer]');
    if (clearCustomerBtn) clearCustomerBtn.addEventListener('click', () => { selectedCustomer = null; paint(); });

    container.querySelector('[data-create]').addEventListener('click', async () => {
      if(pendingTotal!==null){totalError='Distribute the entered total or discard it before saving.';paint();return;}
      if (!selectedCustomer && !newCustomer.name.trim()) {
        container.querySelector('[data-new="name"]').focus();
        return;
      }
      const createBtn = container.querySelector('[data-create]');
      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      try {
        const finalModel=priceModel();
        const finalLines=finalModel.lines, finalTotal=finalModel.total;
        await actions.onCreateQuote({
          quoteLearning:{quoteKey,lines:observationLines(finalModel,computeLines(),ctx.TK_PRICING),context:{source:'earth-extension',modelVersion:ctx.learningState?.modelVersion||1,estimatedDurationMin:finalModel.breakdown.totalTimeMin,estimatedCost:finalModel.breakdown.costUnrounded,travelKm,targetMargin:localMargin,gstRegistered:ctx.TK_COST.COST_INPUTS.gstRegistered,originalQuantities:Object.fromEntries(computeLines().map(l=>[l.lineKey,l.originalQuantity]))}},
          customer: selectedCustomer || newCustomer,
          isNewCustomer: !selectedCustomer,
          address: ctx.address,
          lines: finalLines,
          total: finalTotal,
          areaPolys: lineState.filter(l=>l.include).map((l,i)=>({...measurementForService(ctx.measurements.find(m=>m.id===l.measurementId),l.svc,SERVICES[l.svc]),id:l.measurementId+'_'+i})),
          costSnapshot:finalModel.snapshot,
          estimatedCost:finalModel.breakdown.costUnrounded,
          estimatedMarginPct:finalModel.marginPct,
          gstRegistered:ctx.TK_COST.COST_INPUTS.gstRegistered,
          targetMargin:localMargin,
          assumptions:{access,premium:false}
        });
      } catch (err) {
        createBtn.disabled = false;
        createBtn.textContent = 'Create Quote';
        const foot = container.querySelector('.tk-modal-foot');
        const errEl = document.createElement('div');
        errEl.className = 'tk-error';
        errEl.textContent = err.message || 'Could not create the quote — check your connection and try again.';
        foot.prepend(errEl);
      }
    });
  }

  paint();
}

/** The post-creation "QUOTE CREATED" screen (build brief §12). */
export function renderQuoteCreated(container, { address, total, lines, SERVICES, openUrl, publicUrl, warning, learningWarning }, actions) {
  container.innerHTML = `
    <div class="tk-modal-backdrop">
      <div class="tk-modal tk-quote-created">
        <div class="tk-created-badge">✓</div>
        <h3>Quote Created</h3>
        ${warning ? `<p role="status" class="tk-modal-sub">${escapeHtml(warning)}</p>` : ''}
        <p class="tk-error" role="status" data-learning-status>${escapeHtml(learningWarning||'')}</p>
        <button type="button" class="tk-btn" data-retry-learning ${learningWarning?'':'hidden'}>Retry saving learning</button>
        <p class="tk-modal-sub">${escapeHtml(address)}</p>
        <div class="tk-created-total">${money(total)}</div>
        <div class="tk-created-lines">
          ${lines.map((l) => `<div class="tk-kv"><span>${escapeHtml(l.label ?? SERVICES[l.svc]?.label ?? l.svc)}${l.svc==='housewash'?' · '+Number(l.storeys||1)+' storey':''}</span><span>${l.qty} ${escapeHtml(isCustomLine(l)?l.unit:SERVICES[l.svc]?.unit || '')} · ${money(l.fixedPrice)}</span></div>`).join('')}
        </div>
        <div class="tk-modal-foot tk-created-foot">
          <button type="button" class="tk-btn" data-copy>Copy Quote Link</button>
          <button type="button" class="tk-btn tk-btn-accent" data-open>Open in TurnKey</button>
        </div>
        <div class="tk-created-transfer">
          <button type="button" class="tk-btn tk-btn-accent" data-servicem8>Send to ServiceM8</button>
          <button type="button" class="tk-btn" data-check-transfer hidden>Check transfer</button>
          <p class="tk-modal-sub" role="status" aria-live="polite" data-transfer-status></p>
          <p><a data-open-servicem8 target="_blank" rel="noopener" hidden>Open in ServiceM8</a></p>
        </div>
        <button type="button" class="tk-link-btn" data-done>Done</button>
      </div>
    </div>`;
  container.querySelector('[data-retry-learning]').addEventListener('click',async e=>{
    const button=e.target,status=container.querySelector('[data-learning-status]');button.disabled=true;
    try{await actions.onRetryLearning();status.textContent='Learning saved. Your quote remains saved.';button.hidden=true;}
    catch(error){status.textContent='Your quote is saved. Learning was not saved: '+error.message;}
    finally{button.disabled=false;}
  });
  container.querySelector('[data-open]').addEventListener('click', async () => {
    try { await TurnKeyApi.openTurnKey(openUrl); }
    catch(error) { container.querySelector('[data-transfer-status]').textContent=error.message; }
  });
  container.querySelector('[data-copy]').addEventListener('click', async (e) => {
    await navigator.clipboard.writeText(publicUrl);
    e.target.textContent = 'Copied!';
    setTimeout(() => (e.target.textContent = 'Copy Quote Link'), 1500);
  });
  const send=container.querySelector('[data-servicem8]'),check=container.querySelector('[data-check-transfer]'),status=container.querySelector('[data-transfer-status]'),link=container.querySelector('[data-open-servicem8]');
  send.addEventListener('click',async()=>{
    if(send.disabled)return;
    send.disabled=true;status.textContent='Queueing your saved quote…';
    try{
      const result=await actions.onSendServiceM8();
      if(!result||result.queued!==true)throw new Error('The transfer was not confirmed. Your TurnKey quote is still saved.');
      send.textContent='Queued for ServiceM8';check.hidden=false;
      status.textContent='Queued. You can leave this screen; TurnKey will process the transfer in the background.';
    }catch(error){status.textContent=(error.message||'Could not transfer.')+' Your TurnKey quote remains saved.';send.textContent='Retry ServiceM8 transfer';send.disabled=false;}
  });
  check.addEventListener('click',async()=>{
    if(check.disabled)return;
    check.disabled=true;
    try{
      const result=await actions.onCheckServiceM8();
      status.textContent=result.message||'Check TurnKey Connections for transfer progress.';
      if(result.state==='transferred'&&/^https:\/\/go\.servicem8\.com\/OpenJob\/[0-9a-f-]{36}$/i.test(result.openUrl||'')){
        link.href=result.openUrl;link.hidden=false;check.hidden=true;send.textContent='Transferred to ServiceM8';
      }
      if(result.state==='not_connected'||result.state==='not_queued'){send.disabled=false;send.textContent='Retry ServiceM8 transfer';}
    }catch(error){status.textContent=error.message||'Could not check transfer. Your quote is saved.';}
    finally{check.disabled=false;}
  });
  container.querySelector('[data-done]').addEventListener('click', () => actions.onDone());
}
