/* Pure advisory model v1. Inputs are business-scoped snapshots, never geometry,
 * live rates, customer details or mutable job records. No persistence/side effects.
 * Each job gets one vote, even if a quote was revised or contains repeated lines.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TK_PRICE_LEARNING = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({ enabled: true, minSamples: 5, maxAdjustment: 0.25 });
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const positive = v => finite(v) && v > 0;
  const get = (o, camel, snake) => o[camel] !== undefined ? o[camel] : o[snake];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const money = v => v > Number.MAX_SAFE_INTEGER / 100 ? v : Math.round(v * 100) / 100;
  const median = values => {
    const a = values.slice().sort((a, b) => a - b), i = Math.floor(a.length / 2);
    return a.length ? (a.length % 2 ? a[i] : a[i - 1] / 2 + a[i] / 2) : 1;
  };
  function settingsOf(s) {
    s = s || {};
    const n = get(s, 'minSamples', 'min_samples'), max = get(s, 'maxAdjustment', 'max_adjustment');
    return { enabled: s.enabled !== false, minSamples: Number.isInteger(n) ? clamp(n, 5, 50) : 5,
      maxAdjustment: finite(max) ? clamp(max, 0, 0.35) : 0.25 };
  }
  function normalized(o) {
    return { ...o, businessId: get(o, 'businessId', 'business_id'), jobId: get(o, 'jobId', 'job_id'),
      quoteKey: get(o, 'quoteKey', 'quote_key'), baselinePrice: get(o, 'baselinePrice', 'baseline_price'),
      chosenPrice: get(o, 'chosenPrice', 'chosen_price'), measuredQuantity: get(o, 'measuredQuantity', 'measured_quantity'),
      verifiedQuantity: get(o, 'verifiedQuantity', 'verified_quantity'), measurementReason: get(o, 'measurementReason', 'measurement_reason') };
  }
  // One median per physical job (or quote when no job identity is available).
  function votes(rows, ratio) {
    const groups = new Map(), parents = new Map();
    const find = k => {
      if (!parents.has(k)) parents.set(k, k);
      if (parents.get(k) !== k) parents.set(k, find(parents.get(k)));
      return parents.get(k);
    };
    rows.forEach(o => {
      if (typeof o.quoteKey === 'string' && o.quoteKey && o.jobId) parents.set(find('quote:' + o.quoteKey), find('job:' + o.jobId));
    });
    rows.forEach(o => {
      if (typeof o.quoteKey !== 'string' || !o.quoteKey) return;
      const key = find('quote:' + o.quoteKey), v = ratio(o);
      if (!finite(v) || v < 0) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(v);
    });
    return Array.from(groups.values(), median);
  }
  const measurementReasons = new Set(['verified_measurement', 'manual_measurement', 'site_measurement', 'measurement_correction']);
  function recommend(input) {
    input = input || {};
    const settings = settingsOf(input.settings);
    const observations = (Array.isArray(input.observations) ? input.observations : []).filter(o => o && typeof o === 'object').map(normalized);
    const tenants = new Set(observations.map(o => o.businessId).filter(Boolean));
    return (Array.isArray(input.lines) ? input.lines : []).map(raw => {
      const line = raw || {}, baseline = finite(line.baselinePrice) ? Math.max(0, line.baselinePrice) : 0;
      const floor = finite(line.marginFloor) ? Math.max(0, line.marginFloor) : 0;
      const tenant = input.businessId || line.businessId;
      const context = line.context || input.context || {};
      const rows = observations.filter(o => !o.excluded &&
        (tenant ? o.businessId === tenant : tenants.size <= 1) &&
        o.svc === line.svc && o.unit === line.unit &&
        (o.storeys ?? 1) === (line.storeys ?? 1) && (o.access || 'standard') === (line.access || 'standard') &&
        positive(line.quantity) && positive(o.quantity) && o.quantity >= line.quantity * 0.5 && o.quantity <= line.quantity * 2 &&
        !(typeof context.gstRegistered === 'boolean' && typeof o.context?.gstRegistered === 'boolean' && context.gstRegistered !== o.context.gstRegistered));
      const priceVotes = votes(rows.filter(o => ['pricing_correction', 'difficult_access'].includes(o.reason) &&
        positive(o.baselinePrice) && positive(baseline) && finite(o.chosenPrice) && o.chosenPrice >= 0 &&
        // Both baselines must be pre-learning prices. Material rate/floor changes
        // invalidate old price corrections instead of compounding them again.
        Math.abs((o.baselinePrice / o.quantity) / (baseline / line.quantity) - 1) <= 0.100000001), o => o.chosenPrice / o.baselinePrice);
      // Measurement and extra-work corrections never influence price ratios.
      const measurementVotes = votes(rows.filter(o => o.reason !== 'discount' &&
        measurementReasons.has(o.measurementReason) && positive(o.measuredQuantity) && positive(o.verifiedQuantity)),
      o => o.verifiedQuantity / o.measuredQuantity);
      const n = priceVotes.length, weight = n / (n + settings.minSamples);
      const ready = settings.enabled && n >= settings.minSamples;
      const adjustment = ready ? clamp((median(priceVotes) - 1) * weight, -settings.maxAdjustment, settings.maxAdjustment) : 0;
      // Round the floor upward so cents rounding can never undercut the target.
      const adjusted = Math.min(Number.MAX_VALUE, baseline * (1 + adjustment));
      const recommendedPrice = Math.max(money(adjusted), floor > Number.MAX_SAFE_INTEGER / 100 ? floor : Math.ceil(floor * 100) / 100);
      let explanation = !settings.enabled ? 'Learning is disabled; baseline pricing applies.' : !ready ?
        `Baseline pricing: ${n} distinct comparable quotes; ${settings.minSamples} required.` :
        `${n} distinct comparable quotes; median price ratio ${median(priceVotes).toFixed(3)}, shrunk toward baseline and limited to ${(settings.maxAdjustment * 100).toFixed(0)}%. Confidence describes sample support, not acceptance probability.`;
      if (recommendedPrice > money(adjusted)) explanation += ' Target margin floor applied.';
      const mn = measurementVotes.length;
      const factor = settings.enabled && mn >= settings.minSamples ?
        1 + clamp((median(measurementVotes) - 1) * mn / (mn + settings.minSamples), -settings.maxAdjustment, settings.maxAdjustment) : 1;
      return { lineKey: line.lineKey, svc: line.svc, baselinePrice: baseline,
        learnedAdjustment: money(recommendedPrice - baseline), recommendedPrice, sampleCount: n,
        confidence: ready ? (n >= settings.minSamples * 3 ? 'high' : 'moderate') : 'insufficient', explanation,
        measurement: { factor, sampleCount: mn, suggestedQuantity: positive(line.quantity) ? money(Math.min(Number.MAX_VALUE, line.quantity * factor)) : null } };
    });
  }
  return Object.freeze({ recommend, DEFAULTS, modelVersion: 1 });
}));
