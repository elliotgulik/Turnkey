/* Shared by the authenticated browser and backend. No pricing assumptions or sample data. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TK_METRICS = api;
})(typeof window === "object" ? window : globalThis, function () {
  const DAY = 86400000;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const time = (v) => {
    if (!v) return null;
    const n = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(n) ? n : null;
  };
  const won = (r) =>
    ["won", "scheduled", "completed", "paid"].includes(r.stage);
  const lost = (r) =>
    r.stage === "lost" || (r.stage === "cancelled" && !!r.lostAt);
  const stage = (r) => (won(r) ? "won" : lost(r) ? "lost" : r.stage);
  const leadTime = (r) => time(r.requestSubmittedAt) || time(r.createdAt);
  const quoteTime = (r) => time(r.quoteSentAt);
  const winTime = (r) =>
    time(r.wonAt) || time(r.approvedAt) || time(r.acceptedAt);
  const ratio = (a, b) => (b ? a / b : null);
  const total = (rs) => rs.reduce((s, r) => s + num(r.total), 0);
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
    const within = (t) => t != null && t >= r.start && t < r.end;
    const leads = records.filter((x) => within(leadTime(x))),
      quotes = records.filter((x) => within(quoteTime(x))),
      wins = records.filter((x) => won(x) && within(winTime(x)));
    const cohortQuoted = leads.filter((x) => quoteTime(x) != null),
      cohortWon = leads.filter(won),
      accepted = cohortQuoted.filter(won);
    const costed = wins.filter(
      (x) =>
        x.estimatedCost != null &&
        Number.isFinite(Number(x.estimatedCost)) &&
        x.gstRegistered != null,
    );
    const ex = (r) => num(r.total) / (r.gstRegistered ? 1.15 : 1);
    const costedRevenue = costed.reduce((s, r) => s + ex(r), 0),
      profit = costed.reduce((s, r) => s + ex(r) - num(r.estimatedCost), 0);
    const groups = (key) =>
      Object.entries(
        leads.reduce((o, x) => {
          const k = key(x) || "Unattributed";
          (o[k] || (o[k] = [])).push(x);
          return o;
        }, Object.create(null)),
      ).map(([name, rs]) => {
        const w = rs.filter(won);
        const known = w.filter(x => x.estimatedCost != null && Number.isFinite(Number(x.estimatedCost)) && x.gstRegistered != null);
        const revenueExGst = known.reduce((sum,x) => sum + ex(x),0);
        const estimatedProfit = known.reduce((sum,x) => sum + ex(x) - num(x.estimatedCost),0);
        return {
          name,
          leads: rs.length,
          won: w.length,
          revenue: total(w),
          conversion: ratio(w.length, rs.length),
          estimatedProfit: known.length ? estimatedProfit : null,
          estimatedMargin: revenueExGst ? estimatedProfit / revenueExGst : null,
          costCoverage: known.length + "/" + w.length,
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
    const open = records.filter(
      (x) => !won(x) && !lost(x) && x.stage !== "cancelled",
    );
    const probabilities = opts.probabilities || {};
    const forecast = open.reduce((s, x) => {
      const p = probabilities[stage(x)];
      return (
        s +
        num(x.total || x.opportunityValue) *
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
      const d = new Date(winTime(x));
      if (bucket === "month") d.setDate(1);
      if (bucket === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      d.setHours(0, 0, 0, 0);
      const k = d.toLocaleDateString("en-CA");
      series[k] = (series[k] || 0) + num(x.total);
    });
    const history = leads
      .flatMap((x) => (x.salesHistory || []).map((e) => ({ ...e, record: x })))
      .filter((x) => within(time(x.at)))
      .sort((a, b) => time(b.at) - time(a.at));
    const services = Object.create(null);
    for (const x of wins) {
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
        if (sum > 0 && v.revenue !== null) v.revenue += (num(x.total) * num(l.priceSnapshot)) / sum;
        else v.revenue = null;
        if (l.estCost == null) v.costKnown = false;
        else v.cost += num(l.estCost);
      }
    }
    return {
      range: r,
      leads: leads.length,
      newLeads: leads.filter((x) => x.stage === "new").length,
      quotes: quotes.length,
      quotedValue: total(quotes),
      bookedSales: total(wins),
      cohortWonValue: total(cohortWon),
      conversion: ratio(cohortWon.length, leads.length),
      acceptance: ratio(accepted.length, cohortQuoted.length),
      averageQuote: ratio(total(quotes), quotes.length),
      averageSale: ratio(total(wins), wins.length),
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
        revenue: rs.reduce((s, x) => s + num(x.total || x.opportunityValue), 0),
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
        value: rs.reduce((s, x) => s + num(x.total || x.opportunityValue), 0),
      })),
      forecast,
      openValue: open.reduce(
        (s, x) => s + num(x.total || x.opportunityValue),
        0,
      ),
      overdue: open.filter(
        (x) => time(x.nextFollowUpAt) != null && time(x.nextFollowUpAt) < now,
      ),
      series: Object.entries(series)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value })),
      activity: history.slice(0, 30),
      unknownWinDates: records.filter((x) => won(x) && winTime(x) == null)
        .length,
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
