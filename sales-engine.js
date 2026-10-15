// TurnKey sales engine — every number on the Sales tab comes from here.
// Pure functions over the in-memory `records` array (no DOM, no network),
// loaded ONLY by index.html: conversion, lead-source spend and lost-quote
// reasons are internal business data, same as cost-engine.js.
//
// Cohort rule: a lead belongs to the period it ARRIVED in (requestSubmittedAt
// or createdAt). Its quote, win or loss is credited back to that period even
// if it happened later, so "conversion rate for September" means "of the
// leads that came in during September, how many became jobs" — the number
// that actually tells you whether your sales process is working.
window.TK_SALES = (function(){
  const DAY = 864e5;
  const WON_STAGES = ['won','scheduled','completed','paid'];
  const OPEN_STAGES = ['new','quoted','followup'];

  function leadAt(r){ return r.requestSubmittedAt || r.createdAt || null; }
  function isWonR(r){ return WON_STAGES.includes(r.stage); }
  // A lost quote sits on the 'cancelled' stage and was never won; a won job
  // that was later cancelled is NOT a lost sale.
  function isLostR(r){ return r.stage==='cancelled' && (!!r.lostAt || !(r.wonAt || r.approvedAt)); }
  function isOpenR(r){ return OPEN_STAGES.includes(r.stage); }
  function wasQuoted(r){ return !!r.quoteSentAt || isWonR(r) || (isLostR(r) && (r.total||0) > 0); }
  function sourceOf(r){
    const s = (r.source||'').trim();
    if(!s) return 'Unknown';
    if(/^imported/i.test(s)) return 'Imported (ServiceM8)';
    if(/widget|website|online|booking/i.test(s)) return 'Website';
    return s;
  }
  // Excluded from every stat: imported history has no trustworthy lead
  // timestamps, and repeat-due reminders aren't new sales leads.
  function countable(r){ return !!leadAt(r) && !/^imported/i.test(r.source||''); }

  // Period → [startMs, endMs). `now` injectable for tests.
  function periodRange(key, now){
    now = now || Date.now();
    const d = new Date(now);
    const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    switch(key){
      case 'month':   return {start:startOfMonth, end:now, months:Math.max((now-startOfMonth)/(30.44*DAY),0.25)};
      case '30d':     return {start:now-30*DAY, end:now, months:30/30.44};
      case '90d':     return {start:now-90*DAY, end:now, months:90/30.44};
      case 'year':    { const s=new Date(d.getFullYear(),0,1).getTime(); return {start:s, end:now, months:Math.max((now-s)/(30.44*DAY),1)}; }
      default:        return {start:0, end:now, months:null}; // 'all' — months filled in from data
    }
  }

  function median(arr){
    if(!arr.length) return null;
    const a=[...arr].sort((x,y)=>x-y), m=Math.floor(a.length/2);
    return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
  }
  function pct(n,d){ return d ? n/d*100 : null; }

  // Core funnel for one set of leads.
  function funnel(list){
    const leads=list.length;
    const quoted=list.filter(wasQuoted);
    const won=list.filter(isWonR);
    const lost=list.filter(isLostR);
    const open=list.filter(isOpenR);
    const wonValue=won.reduce((s,r)=>s+(r.total||0),0);
    const lostValue=lost.reduce((s,r)=>s+(r.total||0),0);
    const openQuoted=open.filter(r=>r.quoteSentAt&&(r.total||0)>0);
    const pipelineValue=openQuoted.reduce((s,r)=>s+(r.total||0),0);
    // Win rate on DECIDED quotes only — an open quote hasn't lost yet, and
    // counting it as a loss drags the rate down every time leads spike.
    const decided=won.length+lost.filter(wasQuoted).length;
    return {
      leads, quoted:quoted.length, won:won.length, lost:lost.length, open:open.length,
      wonValue, lostValue, pipelineValue, openQuotes:openQuoted.length,
      avgWonValue: won.length ? wonValue/won.length : null,
      leadToQuotePct: pct(quoted.length, leads),
      quoteToWinPct:  pct(won.length, quoted.length),
      winRateDecidedPct: pct(won.length, decided),
      conversionPct:  pct(won.length, leads)
    };
  }

  // Speed to quote: hours from the lead arriving to the quote going out,
  // and how win rate changes with it.
  const SPEED_BUCKETS=[
    {key:'fast', label:'Under 24 hours', maxH:24},
    {key:'mid',  label:'1–3 days',       maxH:72},
    {key:'slow', label:'Over 3 days',    maxH:Infinity}
  ];
  function speedToQuote(list){
    const timed=list.filter(r=>r.quoteSentAt&&leadAt(r)&&r.quoteSentAt>=leadAt(r))
      .map(r=>({r, h:(r.quoteSentAt-leadAt(r))/36e5}));
    const buckets=SPEED_BUCKETS.map(b=>({...b, quotes:0, won:0, decided:0}));
    timed.forEach(({r,h})=>{
      const b=buckets.find(x=>h<x.maxH);
      b.quotes++;
      if(isWonR(r)){b.won++;b.decided++;}
      else if(isLostR(r))b.decided++;
    });
    buckets.forEach(b=>{ b.winRatePct=pct(b.won,b.decided); });
    return {
      medianHours: median(timed.map(t=>t.h)),
      sample: timed.length,
      buckets
    };
  }

  // Per-source: volume, conversion, revenue, and — when a monthly spend is
  // set for that source — cost per lead, cost per won job and return.
  function bySource(list, spendPerMonth, months){
    const groups={};
    list.forEach(r=>{ (groups[sourceOf(r)]=groups[sourceOf(r)]||[]).push(r); });
    // Sources with spend but zero leads still deserve a row — that's the
    // worst-performing channel of all.
    Object.keys(spendPerMonth||{}).forEach(k=>{ if((spendPerMonth[k]||0)>0&&!groups[k])groups[k]=[]; });
    return Object.entries(groups).map(([source,rs])=>{
      const f=funnel(rs);
      const monthly=(spendPerMonth&&parseFloat(spendPerMonth[source]))||0;
      const spend=monthly&&months?monthly*months:0;
      return {
        source, ...f, spend,
        costPerLead: spend&&f.leads ? spend/f.leads : null,
        costPerWin:  spend&&f.won   ? spend/f.won   : null,
        returnX:     spend ? f.wonValue/spend : null
      };
    }).sort((a,b)=>b.wonValue-a.wonValue||b.leads-a.leads);
  }

  function lostReasons(list, labelFn){
    const lost=list.filter(isLostR);
    const g={};
    lost.forEach(r=>{
      const k=r.lostReason||'unrecorded';
      g[k]=g[k]||{key:k,label:k==='unrecorded'?'No reason recorded':(labelFn?labelFn(k):k),count:0,value:0};
      g[k].count++; g[k].value+=(r.total||0);
    });
    return Object.values(g).sort((a,b)=>b.count-a.count||b.value-a.value);
  }

  // Last N calendar months, oldest first, each a cohort funnel.
  function monthly(records, n, now){
    now=now||Date.now();
    const d=new Date(now), out=[];
    for(let i=n-1;i>=0;i--){
      const s=new Date(d.getFullYear(), d.getMonth()-i, 1);
      const e=new Date(d.getFullYear(), d.getMonth()-i+1, 1);
      const rs=records.filter(r=>countable(r)&&leadAt(r)>=s.getTime()&&leadAt(r)<e.getTime());
      out.push({label:s.toLocaleString('en-NZ',{month:'short'})+(s.getMonth()===0||i===n-1?' '+String(s.getFullYear()).slice(2):''), start:s.getTime(), ...funnel(rs)});
    }
    return out;
  }

  // The CRM to-do list: leads waiting on a quote, and sent quotes that
  // have gone quiet. Oldest first — those are the ones going cold.
  function needsAttention(records, now){
    now=now||Date.now();
    const unquoted=records.filter(r=>r.stage==='new'&&leadAt(r)&&now-leadAt(r)>24*36e5)
      .map(r=>({r, kind:'unquoted', ageH:(now-leadAt(r))/36e5}));
    const stale=records.filter(r=>(r.stage==='quoted'||r.stage==='followup')&&r.quoteSentAt&&!r.clientResponded&&now-r.quoteSentAt>5*DAY)
      .map(r=>({r, kind:'stale_quote', ageH:(now-r.quoteSentAt)/36e5}));
    return [...unquoted, ...stale].sort((a,b)=>b.ageH-a.ageH);
  }

  function report(records, opts){
    opts=opts||{};
    const now=opts.now||Date.now();
    const range=periodRange(opts.period||'90d', now);
    const all=(records||[]).filter(countable);
    const inPeriod=all.filter(r=>leadAt(r)>=range.start&&leadAt(r)<range.end);
    let months=range.months;
    if(months==null){
      const first=all.reduce((m,r)=>Math.min(m,leadAt(r)),now);
      months=Math.max((now-first)/(30.44*DAY),1);
    }
    return {
      period: opts.period||'90d', range, months,
      totals: funnel(inPeriod),
      speed: speedToQuote(inPeriod),
      sources: bySource(inPeriod, opts.sourceSpend, months),
      lost: lostReasons(inPeriod, opts.lostLabel),
      monthly: monthly(records||[], opts.monthsBack||6, now),
      attention: needsAttention(records||[], now),
      excludedImported: (records||[]).filter(r=>/^imported/i.test(r.source||'')).length
    };
  }

  return {report, funnel, speedToQuote, bySource, lostReasons, monthly, needsAttention, periodRange, sourceOf, leadAt, isLostR, isWonR, wasQuoted, SPEED_BUCKETS};
})();
