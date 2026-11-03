/* Shared by the authenticated browser and backend. No pricing assumptions or sample data. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TK_METRICS = api;
})(typeof window === "object" ? window : globalThis, function (root) {
  const DAY = 86400000;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const known = (v) => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const time = (v) => {
    if (!v) return null;
    const n = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  };
  const won = (r) =>
    ["won", "scheduled", "completed", "paid"].includes(r.stage);
  // Lost quotes: explicit lost stage, or cancelled without a prior win.
  // A won job later cancelled is not a lost sale unless lostAt marks it so.
  const everWon = (r) => !!(r.wonAt || r.approvedAt || r.acceptedAt);
  const lost = (r) =>
    r.stage === "lost" ||
    (r.stage === "cancelled" && (!!r.lostAt || !everWon(r)));
  const stage = (r) => (won(r) ? "won" : lost(r) ? "lost" : r.stage);
  const leadTime = (r) => time(r.requestSubmittedAt) || time(r.createdAt);
  const quoteTime = (r) => time(r.quoteSentAt);
  const winTime = (r) =>
    time(r.wonAt) || time(r.approvedAt) || time(r.acceptedAt);
  const ratio = (a, b) => (b ? a / b : null);
  const sm8Pricing = (r) =>
    r && (r.serviceM8Pricing || (r.details && r.details.serviceM8Pricing));
  // Booked amount: current ServiceM8 total when a snapshot exists (0 is valid;
  // unknown/non-finite stays unavailable). Otherwise the saved opportunity total.
  const bookedAmount = (r) => {
    const pricing = sm8Pricing(r);
    if (pricing && typeof pricing === "object") {
      if (Object.prototype.hasOwnProperty.call(pricing, "total")) {
        return known(pricing.total);
      }
    }
    return known(r.total);
  };
  // Quoted amount: frozen line snapshots when complete; else the saved total.
  // Never substitutes a live ServiceM8 job total for the historical quote —
  // there is no scalar "frozen total" field, only per-line priceSnapshot.
  const quoteAmount = (r) => {
    const lines = Array.isArray(r.services) ? r.services : [];
    if (lines.length) {
      const snaps = lines.map((l) => known(l.priceSnapshot));
      if (snaps.every((v) => v != null))
        return snaps.reduce((s, v) => s + v, 0);
    }
    if (sm8Pricing(r)) return null;
    return known(r.total);
  };
  const sumKnown = (rs, amount) =>
    rs.reduce((s, r) => {
      const v = amount(r);
      return v == null ? s : s + v;
    }, 0);
  const counted = (rs, amount) => rs.filter((r) => amount(r) != null);
  // Optional sibling identity helper; backend also pre-dedupes. No hard package
  // dep. Looked up fresh on every call, not captured at module load: in the
  // browser this script tag loads before lead-identity.js's, so capturing
  // root.TK_LEAD_IDENTITY once here would permanently miss it.
  function representatives(records, businessId) {
    const list = Array.isArray(records) ? records : [];
    let identityApi = root && root.TK_LEAD_IDENTITY;
    if (
      !identityApi &&
      typeof module === "object" &&
      typeof require === "function"
    ) {
      try {
        identityApi = require("./lead-identity.js");
      } catch (_) {
        identityApi = null;
      }
    }
    return identityApi &&
      typeof identityApi.selectRepresentatives === "function"
      ? identityApi.selectRepresentatives(list, businessId)
      : list;
  }
  function range(period, now = Date.now(), custom = {}) {
    const d = new Date(now),
      end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    let start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    if (period === "month")
      start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    else if (period === "year")
      start = new Date(d.getFullYear(), 0, 1).getTime();
    else if (period === "custom") {
      start = time(custom.start);
      const e = time(custom.end);
      if (start == null || e == null || e <= start)
        throw Error("Choose a valid date range");
      return { start, end: e };
    } else if (period !== "today")
      start -= Math.max(0, (parseInt(period) || 30) - 1) * DAY;
    return { start, end };
  }
  function report(records, opts = {}) {
    const now = opts.now || Date.now(),
      r = opts.range || range(opts.period || "30d", now, opts.custom);
    if (
      !Number.isFinite(r.start) ||
      !Number.isFinite(r.end) ||
      r.end <= r.start
    )
      throw Error("Invalid reporting range");
    const rows = representatives(records, opts.businessId);
    const within = (t) => t != null && t >= r.start && t < r.end;
    const leads = rows.filter((x) => within(leadTime(x))),
      quotes = rows.filter((x) => within(quoteTime(x))),
      wins = rows.filter((x) => won(x) && within(winTime(x)));
    const cohortQuoted = leads.filter((x) => quoteTime(x) != null),
      cohortWon = leads.filter(won),
      accepted = cohortQuoted.filter(won);
    // Historical cost/GST apply only to saved TurnKey totals — not live SM8 prices.
    const costed = wins.filter(
      (x) =>
        !sm8Pricing(x) &&
        x.estimatedCost != null &&
        Number.isFinite(Number(x.estimatedCost)) &&
        x.gstRegistered != null &&
        bookedAmount(x) != null,
    );
    const ex = (rec) => bookedAmount(rec) / (rec.gstRegistered ? 1.15 : 1);
    const costedRevenue = costed.reduce((s, rec) => s + ex(rec), 0),
      profit = costed.reduce(
        (s, rec) => s + ex(rec) - num(rec.estimatedCost),
        0,
      );
    const groups = (key) =>
      Object.entries(
        leads.reduce((o, x) => {
          const k = key(x) || "Unattributed";
          (o[k] || (o[k] = [])).push(x);
          return o;
        }, Object.create(null)),
      ).map(([name, rs]) => {
        const w = rs.filter(won);
        const knownCost = w.filter(
          (x) =>
            !sm8Pricing(x) &&
            x.estimatedCost != null &&
            Number.isFinite(Number(x.estimatedCost)) &&
            x.gstRegistered != null &&
            bookedAmount(x) != null,
        );
        const revenueExGst = knownCost.reduce((sum, x) => sum + ex(x), 0);
        const estimatedProfit = knownCost.reduce(
          (sum, x) => sum + ex(x) - num(x.estimatedCost),
          0,
        );
        return {
          name,
          leads: rs.length,
          won: w.length,
          revenue: sumKnown(w, bookedAmount),
          conversion: ratio(w.length, rs.length),
          estimatedProfit: knownCost.length ? estimatedProfit : null,
          estimatedMargin: revenueExGst
            ? estimatedProfit / revenueExGst
            : null,
          costCoverage: knownCost.length + "/" + w.length,
        };
      });
    const source = groups((x) => x.source || "Manual"),
      salespeople = groups(
        (x) => x.salespersonName || x.assignedSalespersonId || "Unassigned",
      );
    const spend = (opts.spend || []).filter((x) => within(time(x.spent_at)));
    for (const g of source) {
      const ss = spend.filter(
        (x) => String(x.source).toLowerCase() === g.name.toLowerCase(),
      );
      g.spend = ss.length ? ss.reduce((s, x) => s + num(x.amount), 0) : null;
      g.cpl = g.spend == null ? null : ratio(g.spend, g.leads);
      g.cac = g.spend == null ? null : ratio(g.spend, g.won);
      g.roas = g.spend > 0 ? g.revenue / g.spend : null;
    }
    const responded = leads.filter(
      (x) =>
        time(x.firstResponseAt) != null &&
        time(x.firstResponseAt) >= leadTime(x),
    );
    const closed = cohortWon.filter(
      (x) => winTime(x) != null && winTime(x) >= leadTime(x),
    );
    const open = rows.filter(
      (x) => !won(x) && !lost(x) && x.stage !== "cancelled",
    );
    const probabilities = opts.probabilities || {};
    const forecast = open.reduce((s, x) => {
      const p = probabilities[stage(x)];
      const value = known(x.total ?? x.opportunityValue) || 0;
      return (
        s +
        value *
          (p == null
            ? leads.length
              ? cohortWon.length / leads.length
              : 0
            : Math.max(0, Math.min(1, num(p))))
      );
    }, 0);
    const bucket = opts.bucket || "day",
      series = Object.create(null);
    wins.forEach((x) => {
      const amount = bookedAmount(x);
      if (amount == null) return;
      const d = new Date(winTime(x));
      if (bucket === "month") d.setDate(1);
      if (bucket === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      d.setHours(0, 0, 0, 0);
      const k = d.toLocaleDateString("en-CA");
      series[k] = (series[k] || 0) + amount;
    });
    const history = leads
      .flatMap((x) => (x.salesHistory || []).map((e) => ({ ...e, record: x })))
      .filter((x) => within(time(x.at)))
      .sort((a, b) => time(b.at) - time(a.at));
    const services = Object.create(null);
    for (const x of wins) {
      const amount = bookedAmount(x);
      if (amount == null) continue;
      const lines = x.services || [],
        sum = lines.reduce((s, l) => s + num(l.priceSnapshot), 0);
      for (const l of lines) {
        const key = l.svc || "Other",
          v =
            services[key] ||
            (services[key] = {
              name: key,
              revenue: 0,
              cost: 0,
              costKnown: true,
            });
        if (sum > 0 && v.revenue !== null)
          v.revenue += (amount * num(l.priceSnapshot)) / sum;
        else v.revenue = null;
        if (l.estCost == null) {
          v.costKnown = false;
          v.cost = null;
        } else if (v.costKnown) v.cost += num(l.estCost);
      }
    }
    const quotedWithAmount = counted(quotes, quoteAmount),
      bookedWithAmount = counted(wins, bookedAmount);
    return {
      range: r,
      leads: leads.length,
      newLeads: leads.filter((x) => x.stage === "new").length,
      quotes: quotes.length,
      quotedValue: sumKnown(quotes, quoteAmount),
      bookedSales: sumKnown(wins, bookedAmount),
      cohortWonValue: sumKnown(cohortWon, bookedAmount),
      conversion: ratio(cohortWon.length, leads.length),
      acceptance: ratio(accepted.length, cohortQuoted.length),
      averageQuote: ratio(
        sumKnown(quotedWithAmount, quoteAmount),
        quotedWithAmount.length,
      ),
      averageSale: ratio(
        sumKnown(bookedWithAmount, bookedAmount),
        bookedWithAmount.length,
      ),
      estimatedProfit: costed.length ? profit : null,
      estimatedMargin: costedRevenue ? profit / costedRevenue : null,
      costCoverage: { known: costed.length, total: wins.length },
      belowTarget: quotes.filter(
        (x) =>
          x.estimatedMarginPct != null &&
          x.targetMargin != null &&
          num(x.estimatedMarginPct) < num(x.targetMargin) * 100,
      ).length,
      responseHours: responded.length
        ? responded.reduce(
            (s, x) => s + (time(x.firstResponseAt) - leadTime(x)) / 36e5,
            0,
          ) / responded.length
        : null,
      closeDays: closed.length
        ? closed.reduce((s, x) => s + (winTime(x) - leadTime(x)) / DAY, 0) /
          closed.length
        : null,
      contacted: leads.filter((x) => time(x.firstResponseAt) != null).length,
      qualified: leads.filter((x) => time(x.qualifiedAt) != null).length,
      cohortQuotes: cohortQuoted.length,
      cohortWins: cohortWon.length,
      source,
      salespeople,
      services: Object.values(services),
      lostReasons: Object.entries(
        leads.filter(lost).reduce((o, x) => {
          const k = x.lostReason || "No reason recorded";
          (o[k] || (o[k] = [])).push(x);
          return o;
        }, Object.create(null)),
      ).map(([name, rs]) => ({
        name,
        leads: rs.length,
        revenue: rs.reduce((s, x) => {
          const v = known(x.total ?? x.opportunityValue);
          return v == null ? s : s + v;
        }, 0),
      })),
      pipeline: Object.entries(
        open.reduce((o, x) => {
          const k = stage(x);
          (o[k] || (o[k] = [])).push(x);
          return o;
        }, Object.create(null)),
      ).map(([key, rs]) => ({
        stage: key,
        count: rs.length,
        value: rs.reduce((s, x) => {
          const v = known(x.total ?? x.opportunityValue);
          return v == null ? s : s + v;
        }, 0),
      })),
      forecast,
      openValue: open.reduce((s, x) => {
        const v = known(x.total ?? x.opportunityValue);
        return v == null ? s : s + v;
      }, 0),
      overdue: open.filter(
        (x) => time(x.nextFollowUpAt) != null && time(x.nextFollowUpAt) < now,
      ),
      series: Object.entries(series)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value })),
      activity: history.slice(0, 30),
      unknownWinDates: rows.filter((x) => won(x) && winTime(x) == null).length,
      invoicedRevenue: null,
      collectedRevenue: null,
    };
  }
  function comparison(records, opts = {}) {
    const current = report(records, opts),
      r = current.range,
      previous = report(records, {
        ...opts,
        range: { start: r.start - (r.end - r.start), end: r.start },
      });
    return {
      ...current,
      previous: { bookedSales: previous.bookedSales, leads: previous.leads },
      growth: previous.bookedSales
        ? (current.bookedSales - previous.bookedSales) / previous.bookedSales
        : null,
    };
  }
  function csv(rows) {
    const keys = [...new Set(rows.flatMap(Object.keys))];
    const cell = (v) =>
      '"' +
      String(v == null ? "" : v)
        .replace(/^(?=[=+@\-])/, "'")
        .replace(/"/g, '""') +
      '"';
    return (
      "\ufeff" +
      [
        keys.map(cell).join(","),
        ...rows.map((r) => keys.map((k) => cell(r[k])).join(",")),
      ].join("\r\n")
    );
  }
  return {
    report,
    comparison,
    range,
    won,
    lost,
    stage,
    leadTime,
    quoteTime,
    winTime,
    csv,
  };
});
