/* Display upstream ServiceM8 pricing separately from immutable TurnKey quotes. */
(function(root){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric=v=>typeof v==='number'&&Number.isFinite(v);
  const snapshot=r=>r?.serviceM8Pricing||r?.details?.serviceM8Pricing||r?.details?.pricing||null;
  function money(value,p){
    if(!numeric(value))return 'Unavailable';
    // The owner's NZD default covers ServiceM8 records without a currency.
    // Explicit foreign amounts retain their source label; never fake conversion.
    const currency=/^[A-Z]{3}$/.test(p?.currency||'')?p.currency:'NZD';
    if(currency!=='NZD')return new Intl.NumberFormat('en-NZ',{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:1,maximumFractionDigits:1}).format(value);
    if(root.TK_FORMAT?.money)return root.TK_FORMAT.money(value);
    const rounded=Math.round((Math.abs(value)+Number.EPSILON)*10)/10;
    return (value<0&&rounded!==0?'-':'')+'NZ$'+rounded.toLocaleString('en-NZ',{minimumFractionDigits:1,maximumFractionDigits:1});
  }
  function amount(r){const p=snapshot(r);return numeric(p?.total)?p.total:null;}
  function total(r,fallback='Unavailable'){const p=snapshot(r);return p?money(p.total,p):fallback;}
  function label(r,fallback='TurnKey quote'){const p=snapshot(r);return p?'ServiceM8 job total':fallback;}
  function render(r,{compact=false}={}){
    const p=snapshot(r);if(!p)return '';
    const items=Array.isArray(p.items)?p.items.filter(x=>x&&typeof x==='object'):[];
    return `<section class="tk-sm8-pricing ${compact?'compact':''}" aria-label="ServiceM8 services and prices"><div class="tk-sm8-pricing-heading"><strong>ServiceM8 services &amp; prices</strong>${!compact&&p.updatedAt?`<small>Updated ${esc(new Date(p.updatedAt).toLocaleString('en-NZ'))}</small>`:''}</div>${p.lineTaxLabel?`<p class="tk-sm8-pricing-note">${esc(p.lineTaxLabel)}</p>`:''}${items.length?`<ul>${items.map(item=>`<li><div><span>${esc(item.name||'Unnamed service')}</span>${numeric(item.quantity)?`<small>Qty ${esc(item.quantity)}${!compact&&numeric(item.unitPrice)?' · '+esc(money(item.unitPrice,p))+' each':''}</small>`:''}</div><strong>${numeric(item.lineTotal)?esc(money(item.lineTotal,p)):'Price unavailable'}</strong></li>`).join('')}</ul>`:'<p class="tk-sm8-pricing-note">ServiceM8 has not supplied itemised prices.</p>'}<div class="tk-sm8-pricing-total"><span>ServiceM8 total${p.taxLabel?` <small>${esc(p.taxLabel)}</small>`:''}</span><strong>${esc(money(p.total,p))}</strong></div></section>`;
  }
  root.TK_SM8_PRICING={snapshot,amount,total,label,render};
  if(typeof module!=='undefined'&&module.exports)module.exports=root.TK_SM8_PRICING;
})(typeof window!=='undefined'?window:globalThis);
