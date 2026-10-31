/* Sales application shell. Reuses the original auth, maps, quote editor, mail and import infrastructure. */
(function () {
  "use strict";
  const M = window.TK_METRICS,
    esc = (v) =>
      String(v == null ? "" : v).replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
  const moneySafe = (v) => (v == null ? "Unavailable" : money(v)),
    pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
  const P=window.TK_PIPELINE;
  const defaults=P.stages.map(x=>({...x}));
  let stages = defaults.map((x) => ({ ...x })),
    settings = {},
    cloudGoals = [],
    spend = [],
    metrics = null,
    period = "30d",
    bucket = "day",
    custom = {},
    search = "",
    sourceFilter = "",
    stageFilter = "",
    leadSort = "newest",
    leadLayout = "cards",
    leadsDueOnly = false,
    migrationError = "",
    busy = false,
    serial = 0,
    activeId = null,
    mappings = [],
    pipelineScope="all", pipelineSearch="", pipelineDueOnly=false;
  const oldRender = render,
    oldAll = renderAll,
    oldConnections = openConnections,
    oldAuth = handleAuthedSession,
    oldSettings = openSettings,
    originalCustomerProfile = openCustomerProfile;
  const record = (id) => records.find((r) => String(r.id) === String(id));
  const button = (text, action, id = "", extra = "") =>
    `<button type="button" class="btn ${['quote-home','quote'].includes(action)?'accent quote-launch-btn':'ghost sm'}" data-sale-action="${action}" data-id="${esc(id)}" ${extra}>${['quote-home','quote'].includes(action)?'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></svg>':''}<span>${esc(text)}</span></button>`;
  function buildEarthQuote(id){
    if(!window.TK_EARTH_QUOTES?.open){toast('The Google Earth quote connection is still loading. Refresh TurnKey and try again.');return Promise.resolve(false);}
    return window.TK_EARTH_QUOTES.open(Number(id));
  }
  const field = (label, input) =>
    `<label class="sale-field"><span>${esc(label)}</span>${input}</label>`;
  const options = (list, value) =>
    list
      .map(
        ([v, t]) =>
          `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`,
      )
      .join("");
  const empty = (text) => `<div class="sale-empty">${esc(text)}</div>`;
  const dates = (v) => (v ? new Date(v).toLocaleString() : "Not recorded");
  function header(title, sub, actions = "") {
    return `<header class="sale-head"><div><span class="sale-eyebrow">TURNKEY · SALES &amp; GROWTH</span><h2>${esc(title)}</h2><p>${esc(sub)}</p></div><div class="sale-actions">${actions}</div></header>`;
  }
  function filters() {
    return `<div class="sale-filters">${field(
      "Date range",
      `<select data-sale-filter="period">${options(
        [
          ["today", "Today"],
          ["7d", "7 days"],
          ["30d", "30 days"],
          ["90d", "90 days"],
          ["month", "This month"],
          ["year", "This year"],
          ["custom", "Custom"],
        ],
        period,
      )}</select>`,
    )}${period === "custom" ? field("From", `<input type="date" data-sale-filter="start" value="${esc(custom.start || "")}">`) + field("Through", `<input type="date" data-sale-filter="end" value="${esc(custom.end || "")}">`) : ""}${field(
      "Revenue grouping",
      `<select data-sale-filter="bucket">${options(
        [
          ["day", "Daily"],
          ["week", "Weekly"],
          ["month", "Monthly"],
        ],
        bucket,
      )}</select>`,
    )}<span class="sale-muted">${busy ? "Refreshing…" : metrics ? "Server-calculated · saved records" : "Calculated from loaded account records"}</span></div>`;
  }
  function currentReport() {
    try {
      return (
        metrics ||
        M.comparison(records, {
          period,
          bucket,
          custom: rangeCustom(),
          spend,
          probabilities: settings.probabilities || {},
        })
      );
    } catch {
      return M.comparison(records, { period: "30d" });
    }
  }
  function rangeCustom() {
    return {
      start: custom.start
        ? new Date(custom.start + "T00:00:00").getTime()
        : null,
      end: custom.end
        ? new Date(custom.end + "T00:00:00").getTime() + 86400000
        : null,
    };
  }
  async function api(path, opts = {}) {
    const base = backendUrl();
    if (!base) throw Error("Connect your TurnKey backend to use this feature.");
    const {
      data: { session },
    } = await sb.auth.getSession();
    if (!session) throw Error("Please sign in again.");
    const response = await fetch(base + path, {
      credentials: path.startsWith("/api/sales/servicem8") ? "include" : "omit",
      ...opts,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.access_token,
        ...opts.headers,
      },
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(Error(data.error || "Request failed"), {code:data.code,status:response.status,missingFields:data.missingFields});
    return data;
  }
  async function refreshMetrics() {
    const call = ++serial;
    if (!backendUrl()) return;
    busy = true;
    try {
      const range = M.range(period, Date.now(), rangeCustom());
      const query = new URLSearchParams({
        start: range.start,
        end: range.end,
        bucket,
      });
      const data = await api("/api/sales/metrics?" + query);
      if (call === serial) metrics = data;
    } catch (e) {
      if (call === serial) {
        metrics = null;
        migrationError = e.message;
      }
    } finally {
      if (call === serial) {
        busy = false;
        renderActive();
      }
    }
  }
  function kpi(label, value, note = "") {
    return `<article class="sale-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
  }
  function chart(series) {
    if (!series.length)
      return empty("Booked sales will appear here when dated sales are won.");
    const max = Math.max(...series.map((x) => x.value), 1);
    return `<div class="sale-bars" role="img" aria-label="Booked sales by ${bucket}">${series.map((x) => `<div><span>${esc(money(x.value))}</span><i style="height:${Math.max(2, (x.value / max) * 150)}px"></i><small>${esc(x.date)}</small></div>`).join("")}</div>`;
  }
  function table(headers, rows) {
    return rows.length
      ? `<div class="sale-table-wrap"><table class="sale-table"><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : empty("No data in this period.");
  }
  function notice() {
    return migrationError
      ? `<div class="sale-notice" role="status">${esc(migrationError)}. Your existing records and quoting tools remain available.</div>`
      : "";
  }
  renderDashboard = function () {
    const r = currentReport(),
      goal = cloudGoals.find(
        (g) =>
          g.metric === "revenue" &&
          Date.parse(g.starts_at) <= Date.now() &&
          Date.parse(g.ends_at) > Date.now(),
      ),
      gr = goal ? goalReport(goal) : null;
    document.getElementById("view-dashboard").innerHTML =
      header(
        "Your sales, clearly.",
        "Capture enquiries. Quote profitably. Win the work.",
        button("+ New lead", "new") + button("Build a quote", "quote-home"),
      ) +
      filters() +
      notice() +
      `<div class="sale-kpis">${kpi("Leads received", r.leads, "Arrival date in selected period")}${kpi("New leads awaiting action", r.newLeads, "Selected arrival cohort")}${kpi("Quotes sent", r.quotes, "Quote sent date in period")}${kpi("Quoted value", money(r.quotedValue), "GST-inclusive customer prices")}${kpi("Booked sales", money(r.bookedSales), "Won date in period; not cash received")}${kpi("Lead → won", pct(r.conversion), "Selected lead-arrival cohort")}${kpi("Quote acceptance", pct(r.acceptance), "Quoted leads in arrival cohort")}${kpi("Average quote", moneySafe(r.averageQuote))}${kpi("Estimated gross profit", moneySafe(r.estimatedProfit), `${r.costCoverage.known}/${r.costCoverage.total} won sales have cost/GST snapshots`)}${kpi("Estimated gross margin", pct(r.estimatedMargin), "Ex-GST revenue less estimated cost")}${kpi("Previous-period growth", pct(r.growth), "Equal-length previous period")}${kpi("Sales against target", goal ? pct(gr.bookedSales / Number(goal.target)) : "No active revenue goal", "Goal period, independent of report filter")}</div><div class="sale-grid"><section class="sale-panel"><h3>Revenue performance</h3>${chart(r.series)}</section><section class="sale-panel"><h3>Pipeline at a glance</h3>${table(
        ["Stage", "Opportunities", "Value"],
        r.pipeline.map((s) => [
          stages.find((x) => x.key === s.stage)?.label || s.stage,
          s.count,
          money(s.value),
        ]),
      )}<p class="sale-muted">Current open pipeline, across all arrival dates.</p></section></div><div class="sale-grid"><section class="sale-panel"><h3>Follow-ups due</h3>${
        r.overdue.length
          ? r.overdue
              .slice(0, 8)
              .map(
                (x) =>
                  `<div class="sale-row"><div><b>${esc(x.name)}</b><small>${esc(dates(x.nextFollowUpAt))}</small></div>${button("Open", "detail", x.id)}</div>`,
              )
              .join("")
          : empty("No overdue follow-ups.")
      }</section><section class="sale-panel"><h3>Recent sales activity</h3>${
        r.activity.length
          ? r.activity
              .slice(0, 8)
              .map(
                (x) =>
                  `<div class="sale-row"><div><b>${esc(x.record.name)}</b><small>${esc(x.label || x.to || "Updated")} · ${esc(dates(x.at))}</small></div></div>`,
              )
              .join("")
          : empty("Sales activity will appear as opportunities progress.")
      }</section></div><p class="sale-muted">${r.unknownWinDates ? esc(r.unknownWinDates) + " historical wins have no recorded close date and are excluded from dated booked sales. " : ""}Invoiced revenue and cash received are reported separately in Analytics when ServiceM8 supplies them.</p>`;
  };
  renderSales = function () {
    const r = currentReport();
    document.getElementById("view-sales").innerHTML =
      header(
        "Analytics",
        "Understand what brings work in, what converts, and what it earns.",
        button("Export report", "export") + button("Record ad spend", "spend")+button("Marketing performance", "marketing"),
      ) +
      filters() +
      notice() +
      `<div class="sale-kpis">${kpi("Booked sales", money(r.bookedSales))}${kpi("Quoted revenue", money(r.quotedValue))}${kpi("Invoiced revenue", moneySafe(r.invoicedRevenue), "Linked ServiceM8 jobs only; availability stated below")}${kpi("Collected revenue", moneySafe(r.collectedRevenue), "Recorded payments, not quote approvals")}${kpi("Average sale", moneySafe(r.averageSale))}${kpi("Time to first response", r.responseHours == null ? "Unavailable" : r.responseHours.toFixed(1) + " hours")}${kpi("Average days to close", r.closeDays == null ? "Unavailable" : r.closeDays.toFixed(1))}${kpi("Quotes below target", r.belowTarget)}</div><section class="sale-panel"><h3>Sales funnel · lead arrival cohort</h3>${table(
        ["Step", "Count", "Share of received leads"],
        [
          ["Received", r.leads, pct(r.leads ? 1 : null)],
          [
            "Contacted",
            r.contacted,
            pct(r.leads ? r.contacted / r.leads : null),
          ],
          [
            "Qualified",
            r.qualified,
            pct(r.leads ? r.qualified / r.leads : null),
          ],
          [
            "Quoted",
            r.cohortQuotes,
            pct(r.leads ? r.cohortQuotes / r.leads : null),
          ],
          ["Won", r.cohortWins, pct(r.conversion)],
        ],
      )}</section><section class="sale-panel"><h3>Lead source performance</h3>${table(
        [
          "Source",
          "Leads",
          "Won",
          "Cohort booked value",
          "Conversion",
          "Recorded spend",
          "CPL",
          "CAC",
          "Return",
        ],
        r.source.map((x) => [
          x.name,
          x.leads,
          x.won,
          money(x.revenue),
          pct(x.conversion),
          moneySafe(x.spend),
          moneySafe(x.cpl),
          moneySafe(x.cac),
          x.roas == null ? "Unavailable" : x.roas.toFixed(2) + "×",
        ]),
      )}<p class="sale-muted">Spend uses recorded dates; return uses revenue from the selected lead cohort. No campaign attribution is assumed.</p></section><div class="sale-grid"><section class="sale-panel"><h3>Salesperson performance</h3>${table(
        [
          "Salesperson",
          "Leads",
          "Won",
          "Cohort booked value",
          "Estimated profit",
          "Estimated margin",
          "Cost coverage",
        ],
        r.salespeople.map((x) => [
          x.name,
          x.leads,
          x.won,
          money(x.revenue),
          moneySafe(x.estimatedProfit),
          pct(x.estimatedMargin),
          esc(x.costCoverage),
        ]),
      )}<p class="sale-muted">Selected lead-arrival cohort. Profit and margin cover won sales with cost/GST snapshots; coverage shows costed wins / all wins.</p></section><section class="sale-panel"><h3>Lost-sale reasons</h3>${table(
        ["Reason", "Count", "Opportunity value"],
        r.lostReasons.map((x) => [x.name, x.leads, money(x.revenue)]),
      )}</section></div><section class="sale-panel"><h3>Service profitability</h3>${table(
        ["Service", "Allocated booked revenue", "Direct estimated cost"],
        r.services.map((x) => [
          SERVICES[x.name]?.label || x.name,
          moneySafe(x.revenue),
          x.costKnown ? money(x.cost) : "Unavailable",
        ]),
      )}<p class="sale-muted">Revenue allocation requires frozen line prices. Direct cost excludes unallocated job overhead. Actual profit is unavailable without real job-cost data.</p></section><section class="sale-panel"><h3>Forecast · current open pipeline</h3><strong class="sale-number">${money(r.forecast)}</strong><p>Probability-weighted potential sales, separate from confirmed booked sales. Uses configured stage probabilities, falling back to the selected cohort's historical conversion rate. Without history or configured probabilities, forecast is zero.</p>${button("Configure stages & probabilities", "stages")}</section>${r.financialCoverage ? `<p class="sale-muted">Financial coverage: ${esc(r.financialCoverage)}. Invoice/payment totals describe linked ServiceM8 jobs whose sales were won in this period, not invoice/payment-date accounting.</p>` : ""}`;
  };
  const isOpen = (r) => !["won", "lost"].includes(P.key(r));
  const followupTime = (r) => {
    const t = r.nextFollowUpAt ? new Date(r.nextFollowUpAt).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const isOverdue = (r) => isOpen(r) && followupTime(r) != null && followupTime(r) < Date.now();
  const stageLabel = (r) => stages.find((s) => s.key === P.key(r))?.label || P.key(r) || "Unassigned stage";
  function stageBadge(r) {
    const operational = { scheduled: "Scheduled", completed: "Completed", paid: "Paid" }[r.stage];
    return `<span class="sale-state" data-sale-state="${esc(P.key(r))}">${esc(stageLabel(r))}</span>${operational ? `<span class="sale-state sale-state-operation">${operational}</span>` : ""}`;
  }
  function servicesLabel(r) {
    return (r.requestedServices || []).map((x) => x.name || x).join(", ") ||
      (r.services || []).map((x) => SERVICES[x.svc]?.label || x.svc).join(", ") || "Services to confirm";
  }
  function nextStep(r) {
    const key = P.key(r);
    if (key === "lost") return { action: "detail", label: "Review cancellation", note: r.lostReason || r.cancelReason || "Cancelled. Review the history before taking further action." };
    if (key === "won") return { action: "detail", label: "Review confirmed sale", note: {scheduled:"Work is scheduled. Review the booking and customer details.",completed:"Work is completed. Review the sale and its history.",paid:"Payment is recorded. Review this customer's sale."}[r.stage] || "Quote accepted. Review the sale and arrange delivery." };
    if (!r.email && !r.phone) return { action: "customer-edit", label: "Add contact details", note: "Add an email or phone number so you can reach this customer." };
    if (key === "new") return { action: r.email ? "contact" : "call", label: r.email ? "Contact customer" : "Call customer", note: "Respond to the enquiry and confirm the work they need." };
    if (key === "quoted") return { action: r.email ? "contact" : "call", label: r.email ? "Follow up" : "Call to follow up", note: "Ask about the quote and agree on the next step." };
    if (!r.address) return { action: "customer-edit", label: "Add property address", note: "Confirm the property address before opening Earth to quote." };
    return { action: "quote", label: "Build quote", note: "Open the property in Earth to measure and prepare a quote." };
  }
  function followupLabel(r) {
    if (!isOpen(r)) return "";
    const t = followupTime(r);
    if (t == null) return '<span class="sale-followup sale-followup-unset">No follow-up scheduled</span>';
    return `<span class="sale-followup ${isOverdue(r) ? 'sale-overdue' : ''}">${isOverdue(r) ? 'Overdue' : 'Follow-up'} · ${esc(dates(t))}</span>`;
  }
  function stepButton(r) {
    const step = nextStep(r);
    return step.action === 'call' ? `<a class="btn ghost sm" href="tel:${esc(r.phone.replace(/[^+\d]/g, ''))}">${esc(step.label)}</a>` : button(step.label, step.action, r.id);
  }
  function nextButton(r) {
    return `<div class="sale-next-action">${stepButton(r).replace('class="btn ', 'class="btn sale-next ')}<p>${esc(nextStep(r).note)}</p></div>`;
  }
  function contactActions(r) {
    return `${r.phone ? `<a class="btn ghost sm" href="tel:${esc(r.phone.replace(/[^+\d]/g, ""))}" aria-label="Call ${esc(r.name || 'customer')}">Call</a>` : ""}${r.email ? `<a class="btn ghost sm" href="mailto:${esc(r.email)}">Email</a>` : ""}`;
  }
  function recordActions(r) {
    const step = nextStep(r);
    return `<div class="sale-record-actions" aria-label="Actions for ${esc(r.name || 'customer')}">${contactActions(r)}${step.action !== 'contact' ? button('Contact', 'contact', r.id) : ''}${step.action !== 'quote' && P.key(r) !== 'lost' ? button(M.won(r) ? 'New quote' : 'Build quote', 'quote', r.id) : ''}${button('History', 'history', r.id)}${button('Edit customer', 'customer-edit', r.id)}</div>`;
  }
  function stageControl(r) {
    return field("Sales stage", `<select data-sale-stage="${esc(r.id)}" aria-label="Sales stage">${options(stages.map((s) => [s.key, s.label]), P.key(r))}</select>`);
  }
  function recordHeading(r) {
    return `<button type="button" class="sale-record-open" data-sale-action="detail" data-id="${esc(r.id)}" aria-label="Open ${esc(r.name || 'Unnamed enquiry')}">${esc(r.name || "Unnamed enquiry")}</button>`;
  }
  function customerInfo(r) {
    return `<div class="sale-section-head"><div><span class="sale-eyebrow">CUSTOMER</span><h3>Contact &amp; property</h3></div>${button('Edit customer details', 'customer-edit', r.id)}</div><dl class="sale-dl"><dt>Name</dt><dd>${esc(r.name || 'Not set')}</dd><dt>Email</dt><dd>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : 'Not set — add an email to send quotes'}</dd><dt>Phone</dt><dd>${r.phone ? `<a href="tel:${esc(r.phone.replace(/[^+\d]/g, ''))}">${esc(r.phone)}</a>` : 'Not set — add a phone number'}</dd><dt>Property</dt><dd>${esc([r.address, r.suburb].filter(Boolean).join(', ') || 'Not set — add the property to quote in Earth')}</dd><dt>Received</dt><dd>${esc(dates(M.leadTime(r)))}</dd><dt>Lead source</dt><dd>${esc(r.source || 'Manual')}</dd></dl><div class="sale-actions">${contactActions(r)}${button('Contact customer', 'contact', r.id)}${button('Conversations', 'inbox')}</div><p class="sale-muted">Customer details are shared across this customer's opportunities. Sales notes below belong to this opportunity.</p>`;
  }
  function detailNextActions(r) {
    return `${P.key(r) === 'won' ? button('Open jobs & invoices', 'nav', 'operations') : P.key(r) === 'lost' ? button('View sales history', 'history', r.id) : stepButton(r)}${button('Set follow-up / add notes', 'sales-plan', r.id)}`;
  }
  function refreshCustomerSummary() {
    const detail = document.getElementById('view-detail'), r = record(activeId);
    if (!r || !detail.classList.contains('active') || !detail.querySelector('#sale-customer')) return;
    // Shared customer saves rerender the list. Refresh contact context here while
    // preserving any unsaved owner, follow-up, value or notes in the sales plan.
    detail.querySelector('.sale-head h2').textContent = r.name || 'Sales opportunity';
    detail.querySelector('.sale-head p').textContent = r.address || 'Property address not set';
    detail.querySelector('#sale-customer').innerHTML = customerInfo(r);
    const next = detail.querySelector('.sale-detail-next');
    next.querySelector('h3').textContent = nextStep(r).label;
    next.querySelector('p').textContent = nextStep(r).note;
    next.querySelector('.sale-actions').innerHTML = detailNextActions(r);
  }
  function card(r) {
    const age = M.leadTime(r), value = window.TK_LEADS.value(r), grade = window.TK_LEADS.grade(r);
    return `<article class="sale-card sale-opportunity" draggable="true" data-record="${esc(r.id)}" aria-label="${esc(r.name || 'Unnamed enquiry')}">
      <div class="sale-state-row">${stageBadge(r)}</div>
      <div class="sale-card-top">${recordHeading(r)}<div class="sale-card-value"><strong>${value == null ? 'Not estimated' : esc(money(value))}</strong><small>${r.total > 0 ? 'Quote incl. GST' : 'Estimated value'}</small></div></div>
      <p class="sale-card-address">${esc(r.address || "Property address needed")}</p><p class="sale-card-services">${esc(servicesLabel(r))}</p>
      <div class="sale-tags"><span>${esc(r.source || "Manual")}</span><span title="${esc(grade.description)}">${esc(grade.label)}</span><span>${age ? Math.max(0, Math.floor((Date.now() - age) / 86400000)) + "d old" : "Age unknown"}</span></div>
      <div class="sale-card-owner">${esc(r.salespersonName || "Unassigned salesperson")}</div>${followupLabel(r)}
      ${nextButton(r)}${recordActions(r)}<div class="sale-card-stage">${stageControl(r)}</div></article>`;
  }
  function resultBar(count, total, filtered, action, context) {
    return `<div class="sale-results"><p role="status" aria-live="polite" aria-atomic="true">Showing <strong>${count}</strong> of <strong>${total}</strong> opportunities <span>· ${esc(context)}</span></p>${button('Reset filters', action, '', filtered ? '' : 'disabled')}</div>`;
  }
  function scopeButtons(action, selected, choices) {
    return `<div class="sale-scope-tabs" role="group" aria-label="Opportunity filters">${choices.map(([key, label, count]) => `<button type="button" class="btn ${selected === key ? 'accent' : 'ghost'}" data-sale-action="${action}" data-id="${key}" aria-pressed="${selected === key}">${esc(label)} <span>${count}</span></button>`).join('')}</div>`;
  }
  render = function () {
    if (typeof saveState === "function") saveState();
    document.getElementById("cnt-leads").textContent = records.filter(r => r.stage === 'new').length;
    const scopeStages = stages.filter(s => pipelineScope === 'all' || (pipelineScope === 'open' ? !['won', 'lost'].includes(s.key) : s.key === pipelineScope));
    let list = records.filter(r => P.visible(r, pipelineScope));
    if (pipelineSearch.trim()) list = list.filter(r => [r.name, r.address, r.email, r.phone, r.source].join(' ').toLowerCase().includes(pipelineSearch.trim().toLowerCase()));
    if (pipelineDueOnly) list = list.filter(isOverdue);
    document.getElementById('view-pipeline').innerHTML = header('Sales pipeline', 'See where every opportunity stands and give each customer a clear next step.', button('+ New lead', 'new') + button('Build a quote', 'quote-home') + button('Pipeline settings', 'stages')) +
      `<div class="sale-pipeline-toolbar">${scopeButtons('pipeline-scope', pipelineScope, [['all', 'All', records.length], ['open', 'Open opportunities', records.filter(isOpen).length], ['won', 'Quote confirmed', records.filter(r => P.key(r) === 'won').length], ['lost', 'Cancelled', records.filter(r => P.key(r) === 'lost').length]])}
      ${field('Search pipeline', `<input id="pipeline-search" type="search" value="${esc(pipelineSearch)}" placeholder="Customer, address or source">`)}<label class="sale-check"><input type="checkbox" id="pipeline-due" ${pipelineDueOnly ? 'checked' : ''}> Follow-ups overdue</label></div>` +
      resultBar(list.length, records.length, pipelineScope !== 'all' || pipelineSearch || pipelineDueOnly, 'pipeline-reset', pipelineDueOnly ? 'Overdue follow-ups' : pipelineScope === 'all' ? 'All stages' : pipelineScope === 'open' ? 'Open opportunities' : pipelineScope === 'won' ? 'Quote confirmed' : 'Cancelled') +
      `<nav class="sale-stage-jump" aria-label="Jump to stage">${scopeStages.map(s => `<button class="btn ghost sm" data-sale-action="pipeline-jump" data-id="${s.key}">${esc(s.label)} · ${list.filter(r => P.key(r) === s.key).length}</button>`).join('')}</nav><p class="sale-board-hint">Open a customer name for details. Move an opportunity with its Sales stage menu or drag it to a stage.</p>` +
      (!list.length ? `<div class="sale-no-results">${empty('No matching opportunities. Reset filters to see your pipeline.')}${button('Reset filters', 'pipeline-reset')}</div>` : '') +
      `<div class="sale-kanban" style="--pipeline-columns:${scopeStages.length}">${scopeStages.map(s => {
        const rs = list.filter(r => P.key(r) === s.key);
        return `<section class="sale-column" id="pipeline-${s.key}" data-drop-stage="${s.key}"><header><h3>${esc(s.label)} <span>${rs.length}</span></h3><small>${esc(money(rs.reduce((n, r) => n + (window.TK_LEADS.value(r) || 0), 0)))}</small><p>${esc(defaults.find(d => d.key === s.key)?.description || '')}</p></header>${rs.map(card).join('') || empty('No opportunities in this stage')}</section>`;
      }).join('')}</div>`;
    refreshCustomerSummary();
    renderLeads();
  };
  function leadsTable(rs) {
    return `<div class="sale-table-wrap sale-leads-table-wrap"><table class="sale-table sale-leads-table"><caption class="sale-sr-only">Sales opportunities and next actions</caption><thead><tr>${['Customer / property', 'Stage / source', 'Value incl. GST', 'Next step', 'Actions'].map(t => `<th scope="col">${t}</th>`).join('')}</tr></thead><tbody>${rs.map(r => `<tr data-record="${esc(r.id)}"><td data-label="Customer / property">${recordHeading(r)}<p>${esc(r.address || 'Property address needed')}</p><small>${esc(servicesLabel(r))}</small></td><td data-label="Stage / source"><div class="sale-state-row">${stageBadge(r)}</div><p>${esc(r.source || 'Manual')} · ${esc(r.salespersonName || 'Unassigned')}</p>${stageControl(r)}</td><td data-label="Value incl. GST"><strong>${window.TK_LEADS.value(r) == null ? 'Not estimated' : esc(money(window.TK_LEADS.value(r)))}</strong><p>${r.total > 0 ? 'Saved quote' : 'Estimate'}</p></td><td data-label="Next step">${followupLabel(r)}${nextButton(r)}</td><td data-label="Actions">${recordActions(r)}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function renderLeads() {
    let rs = records.filter(r => stageFilter === 'all' || P.visible(r, stageFilter ? 'all' : 'open'));
    if (search.trim()) rs = rs.filter(r => [r.name, r.email, r.phone, r.address, r.source].join(' ').toLowerCase().includes(search.trim().toLowerCase()));
    if (sourceFilter) rs = rs.filter(r => (r.source || 'Manual') === sourceFilter);
    if (stageFilter && stageFilter !== 'all') rs = rs.filter(r => P.key(r) === stageFilter);
    if (leadsDueOnly) rs = rs.filter(isOverdue);
    rs = window.TK_LEADS.sort(rs, leadSort);
    const sources = [...new Set(records.map(r => r.source || 'Manual'))].sort();
    const filtered = search || sourceFilter || stageFilter || leadsDueOnly || leadSort !== 'newest';
    document.getElementById('view-leads').innerHTML = header('Leads', 'Know who needs a response, what to do next, and which enquiries are ready to quote.', button('+ New lead', 'new') + button('Build a quote', 'quote-home') + button('Import', 'import')) +
      `<div class="sale-leads-overview">${scopeButtons('leads-scope', stageFilter, [['', 'Open leads', records.filter(isOpen).length], ['all', 'All opportunities', records.length], ['won', 'Quote confirmed', records.filter(r => P.key(r) === 'won').length], ['lost', 'Cancelled', records.filter(r => P.key(r) === 'lost').length]])}</div>` +
      `<div class="sale-filters">${field('Search leads', `<input id="sale-search" type="search" value="${esc(search)}" placeholder="Name, email, phone or address">`)}${field('Source', `<select data-sale-filter="source">${options([['', 'All sources'], ...sources.map(s => [s, s])], sourceFilter)}</select>`)}${field('Sales stage', `<select data-sale-filter="stage">${options([['', 'All open stages'], ['all', 'All opportunities'], ...stages.map(s => [s.key, s.label])], stageFilter)}</select>`)}${field('Sort by', `<select data-sale-filter="sort">${options([['newest','Newest first'],['oldest','Oldest first'],['value-high','Highest estimated value'],['value-low','Lowest estimated value'],['followup','Follow-up due first'],['name','Customer name']],leadSort)}</select>`)}<label class="sale-check"><input type="checkbox" id="sale-leads-due" ${leadsDueOnly ? 'checked' : ''}> Follow-ups overdue</label></div>` +
      `<div class="sale-leads-results">${resultBar(rs.length, records.length, filtered, 'leads-reset', leadsDueOnly ? 'Overdue follow-ups' : stageFilter === 'all' ? 'All stages' : stageFilter ? stages.find(s => s.key === stageFilter)?.label || stageFilter : 'Open leads')}<div class="sale-layout-switch" role="group" aria-label="Lead layout">${['cards', 'table'].map(layout => `<button class="btn ghost sm" data-sale-action="leads-layout" data-id="${layout}" aria-pressed="${leadLayout === layout}">${layout === 'cards' ? 'Cards' : 'Table'}</button>`).join('')}</div></div>` +
      (rs.length ? leadLayout === 'table' ? leadsTable(rs) : `<div class="sale-lead-grid">${rs.map(card).join('')}</div>` : `<div class="sale-no-results">${empty('No matching enquiries. Add a lead, import contacts or reset your filters.')}${button('Reset filters', 'leads-reset')}${button('+ New lead', 'new')}</div>`);
  }
  async function move(r, key) {
    if (!r) return;
    if (M.won(r) && !["won","lost"].includes(key)) {
      toast(
        "Won sales stay recorded. Create a new opportunity for further work.",
      );
      return;
    }
    if (key === "won" && !M.won(r)) {
      if (
        !sb ||
        !currentBusinessId ||
        !r.quoteId ||
        !r.jobId ||
        !(r.total > 0) ||
        !r.services?.length
      ) {
        toast("Save a sent quote on this opportunity before marking it won.");
        render();
        return;
      }
      // Persist the linked job's current commercial snapshot before accepting it.
      try {
        await syncRecordToSupabase(r);
      } catch (e) {
        toast("Could not save quote: " + e.message);
        return;
      }
      if (M.won(r)) {
        render();
        renderActive();
        return;
      }
    }
    const at = Date.now();
    if (key === "lost") {
      const reason = prompt("Why is this being cancelled?");
      if (!reason?.trim()) return;
      if(M.won(r)){r.cancelReason=reason.trim().slice(0,500);r.cancelledAt=at;}
      else{r.lostReason=reason.trim().slice(0,500);r.lostAt=at;}
      r.stage = "cancelled";
    } else {
      r.stage = key;
      if (key === "won") r.wonAt = r.wonAt || at;
      if (
        ["contacted", "qualified", "quoting", "quoted", "followup"].includes(
          key,
        )
      )
        r.firstResponseAt = r.firstResponseAt || at;
      if (key === "qualified") r.qualifiedAt = r.qualifiedAt || at;
    }
    r.salesHistory = [
      ...(r.salesHistory || []),
      { at, to: key, label: stages.find((x) => x.key === key)?.label || key },
    ];
    metrics = null;
    try {
      if (sb && currentBusinessId) await syncRecordToSupabase(r);
      render();
      renderActive();
      toast("Opportunity updated");
    } catch (e) {
      toast("Could not save: " + e.message);
      await loadFromSupabase();
    }
  }
  openDetail = function (id) {
    const r = record(id);
    if (!r) return;
    activeId = r.id;
    const map = mappings.find(m => m.local_id === r.jobId && m.object_type === "job"), step = nextStep(r);
    const stagePath = defaults.map(s => `<li ${s.key === P.key(r) ? 'aria-current="step"' : ''}><span>${esc(s.label)}</span></li>`).join('');
    document.getElementById("view-detail").innerHTML =
      header(r.name || "Sales opportunity", r.address || "Property address not set", button('← Pipeline', 'pipeline') + button('Leads', 'nav', 'leads') + button(M.won(r) ? 'New quote for this customer' : 'Build quote', 'quote', r.id)) +
      `<section class="sale-detail-summary" aria-label="Opportunity overview"><div class="sale-state-row">${stageBadge(r)}${followupLabel(r)}</div><ol class="sale-stage-path" aria-label="Sales stages">${stagePath}</ol><div class="sale-detail-next"><div><span class="sale-eyebrow">${isOpen(r) ? 'NEXT STEP' : 'OUTCOME'}</span><h3>${esc(step.label)}</h3><p>${esc(step.note)}</p></div><div class="sale-actions">${detailNextActions(r)}</div></div></section>
      <nav class="sale-detail-nav" aria-label="Opportunity sections"><a href="#sale-customer">Customer</a><a href="#sale-plan">Sales plan</a><a href="#sale-quote">Quote &amp; handoff</a><a href="#sale-history">Sales history</a></nav>
      <div class="sale-detail-layout"><div>
      <section class="sale-panel" id="sale-customer">${customerInfo(r)}</section>
      <section class="sale-panel" id="sale-plan"><span class="sale-eyebrow">SALES PLAN</span><h3 tabindex="-1">Owner, follow-up &amp; notes</h3>${stageControl(r)}<p class="sale-muted">Contact and quote stages also update after a successful send. Confirming a sale requires a saved, complete quote.</p>
      <div class="sale-form-pair">${field('Estimated opportunity value', `<input id="sale-opportunity" type="number" min="0" step="0.01" value="${esc(r.opportunityValue || 0)}">`)}${field('Salesperson', `<select id="sale-assignee">${options([['', 'Unassigned'], ...staff.map(x => [x.id, x.name || x.email])], r.assignedSalespersonId || '')}</select>`)}</div>${field('Next follow-up', `<input id="sale-followup" type="datetime-local" value="${followupTime(r) == null ? '' : esc(localDateTime(r.nextFollowUpAt))}">`)}${followupLabel(r)}${field('Sales notes', `<textarea id="sale-notes" rows="4" placeholder="What did you agree? What should happen next?">${esc(r.salesNotes || r.jobNotes || '')}</textarea>`)}${button('Save sales details', 'save-details', r.id)}</section></div>
      <div><section class="sale-panel" id="sale-quote"><span class="sale-eyebrow">QUOTE</span><h3>Quote &amp; profitability</h3><p class="sale-quote-services">${esc(servicesLabel(r))}</p>${table(['Metric', 'Value'], [
        ['Customer quote (incl. GST)', money(r.total || 0)],
        ['Estimated delivery costs', moneySafe(r.estimatedCost)],
        ['Estimated margin', r.estimatedMarginPct == null ? 'Unavailable' : r.estimatedMarginPct + '%'],
        ['Quote sent', dates(r.quoteSentAt)], ['Sale won', dates(M.winTime(r))]
      ])}<div class="sale-actions sale-quote-actions">${button(M.won(r) ? 'New quote for this customer' : 'Build quote', 'quote', r.id)}${!M.won(r) && (r.services || []).length ? button('Edit saved quote', 'edit-quote', r.id) : ''}${r.quotePublicToken ? `<a class="btn ghost" target="_blank" rel="noopener" href="quote.html?t=${encodeURIComponent(r.quotePublicToken)}">Open customer quote</a>` : ''}${!M.won(r) && r.quoteId && r.total > 0 ? button('Confirm quote accepted', 'confirm-sale', r.id) : ''}${button('Quote history', 'versions', r.id)}${!M.won(r) && r.total > 0 ? button('Send quote to ServiceM8', 'handoff-quote', r.id) : ''}</div>${!r.quoteId ? '<p class="sale-muted">No saved quote yet. Build a quote in Earth to start quoting this opportunity.</p>' : ''}<div id="sale-versions" tabindex="-1" aria-live="polite"></div>
      <div class="sale-handoff"><h3>ServiceM8 handoff</h3><p>Manage this job in TurnKey, or transfer it to your connected ServiceM8 account for delivery and billing.</p>${map ? `<a class="btn accent" target="_blank" rel="noopener" href="https://go.servicem8.com/OpenJob/${encodeURIComponent(map.external_uuid)}">Open in ServiceM8</a><p class="sale-muted">ServiceM8: ${esc(map.snapshot?.status || 'Transferred')} · Last checked ${esc(dates(map.synced_at))}</p>` : button('Transfer approved sale', 'handoff', r.id, M.won(r) ? '' : 'disabled')}${!map && !M.won(r) ? '<p class="sale-muted">Available after the customer accepts a saved quote.</p>' : ''}${!map && M.won(r) && !r.quoteId && r.jobId ? '<p class="sale-muted">This sale predates quote tracking — no quote was ever saved for it. Transferring will ask you to review its recorded amount and services before creating one.</p>' : ''}</div></section></div></div>
      <section class="sale-panel" id="sale-history"><span class="sale-eyebrow">ACTIVITY</span><h3 tabindex="-1">Sales history</h3>${(r.salesHistory || []).length ? `<ol class="sale-history-list">${r.salesHistory.slice().reverse().map(e => `<li><strong>${esc(e.label || e.to)}</strong><time>${esc(dates(e.at))}</time></li>`).join('')}</ol>` : empty('Historical stage timestamps are not available for this record.')}</section>`;
    switchView("detail");
  };
  function localDateTime(value) {
    const d = new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  function goalReport(g) {
    return M.report(
      records.filter(
        (r) =>
          !g.salesperson_id || r.assignedSalespersonId === g.salesperson_id,
      ),
      { range: { start: Date.parse(g.starts_at), end: Date.parse(g.ends_at) } },
    );
  }
  function canRecoverLegacyGoals() {
    try {
      const owner = localStorage.getItem(STORE_KEY + ":legacy-goals-owner");
      return (
        !!currentBusinessId &&
        !owner &&
        Array.isArray(
          JSON.parse(
            localStorage.getItem(STORE_KEY + ":legacy-unassigned") || "{}",
          ).goals,
        ) &&
        JSON.parse(
          localStorage.getItem(STORE_KEY + ":legacy-unassigned") || "{}",
        ).goals.length > 0
      );
    } catch {
      return false;
    }
  }
  renderGoals = function () {
    document.getElementById("view-goals").innerHTML =
      header(
        "Goals & forecasts",
        "Clear targets, a visible gap, and the pace needed to close it.",
        button("+ New goal", "goal-new") +
          (canRecoverLegacyGoals()
            ? button("Recover earlier device goals", "recover-goals")
            : ""),
      ) +
      notice() +
      `<div class="sale-lead-grid">${
        cloudGoals
          .map((g) => {
            const r = goalReport(g),
              cur = {
                revenue: r.bookedSales,
                leads: r.leads,
                quotes: r.quotes,
                conversion: r.conversion == null ? null : r.conversion * 100,
                margin:
                  r.estimatedMargin == null ? null : r.estimatedMargin * 100,
              }[g.metric],
              gap = Math.max(0, Number(g.target) - (cur || 0)),
              days = Math.max(
                1,
                Math.ceil((Date.parse(g.ends_at) - Date.now()) / 86400000),
              );
            return `<article class="sale-panel"><span class="sale-eyebrow">${esc(g.metric)}</span><h3>${esc(g.label)}</h3><p>${esc(new Date(g.starts_at).toLocaleDateString())} – ${esc(new Date(g.ends_at).toLocaleDateString())}</p><strong class="sale-number">${cur == null ? "Unavailable" : g.metric === "revenue" ? money(cur) : cur.toFixed(1)} / ${g.metric === "revenue" ? money(g.target) : esc(g.target)}</strong><progress max="100" value="${cur == null ? 0 : Math.min(100, (cur / Number(g.target)) * 100)}" aria-label="Goal progress"></progress><p>${g.metric === "revenue" ? money(gap) + " remaining · " + money(gap / days) + " per day" + (r.averageSale ? " · about " + Math.ceil(gap / r.averageSale) + " average sales" : "") : "Gap: " + gap.toFixed(1)}</p><p>${esc(g.reward || "")}</p>${button("Delete", "goal-delete", g.id)}</article>`;
          })
          .join("") ||
        empty(
          "Create a weekly, monthly, quarterly or annual target. Goals are stored against your business account.",
        )
      }</div>${goals.length ? `<section class="sale-panel"><h3>Earlier device-only goals</h3><p>These goals have no reporting dates. They are preserved below; create a dated account goal to track an equivalent target across devices.</p>${goals.map((g) => `<p>${esc(g.label)} · target ${esc(g.target)} · ${esc(g.reward)}</p>`).join("")}</section>` : ""}<section class="sale-panel"><h3>Current pipeline forecast</h3><strong class="sale-number">${money(currentReport().forecast)}</strong><p>Probability-weighted potential sales; not confirmed revenue.</p></section>`;
  };
  function modal(title, html) {
    let el = document.getElementById("sales-dialog");
    if (!el) {
      el = document.createElement("dialog");
      el.id = "sales-dialog";
      document.body.append(el);
    }
    el.innerHTML = `<div class="sale-dialog-head"><h2>${esc(title)}</h2>${button("Close", "dialog-close")}</div>${html}<p id="sales-dialog-error" role="alert"></p>`;
    el.showModal();
  }
  function quotePickerRows(query='') {
    const q=query.trim().toLowerCase();
    const groups=typeof groupRecordsByCustomer==='function' ? groupRecordsByCustomer() : records.map(r=>({customerId:r.customerId,name:r.name,email:r.email,phone:r.phone,address:r.address,suburb:r.suburb,jobs:[r]}));
    const matches=groups.filter(g=>g.jobs.some(r=>!M.won(r)) && (!q||[g.name,g.email,g.phone,g.address,g.suburb].some(v=>String(v||'').toLowerCase().includes(q)))).slice(0,12);
    return matches.map(g=>{const r=g.jobs.find(x=>!M.won(x))||g.jobs[0];return `<button type="button" class="sale-card" style="width:100%;text-align:left" data-sale-action="quote-select" data-id="${esc(r.id)}"><b>${esc(g.name||'New customer')}</b><div class="sale-muted">${esc([g.address,g.phone,g.email].filter(Boolean).join(' · '))}</div></button>`;}).join('')||'<p class="sale-muted">No matching opportunities. Create a customer below or adjust the search.</p>';
  }
  function openQuotePicker(query='') {
    modal('Build a quote in Google Earth', `<p>Choose a customer to open their property in Google Earth. Measurements, pricing and expenses return to their TurnKey file.</p><label class="sale-field"><span>Search customers</span><input id="sale-quote-search" type="search" value="${esc(query)}" placeholder="Name, phone, email or address"></label><div id="sale-quote-results">${quotePickerRows(query)}</div><hr><form id="sale-quote-new"><h3>New customer</h3>${field('Name','<input name="name" required maxlength="160" autocomplete="name">')}${field('Phone','<input name="phone" maxlength="80" autocomplete="tel">')}${field('Email','<input name="email" type="email" maxlength="254" autocomplete="email">')}${field('Property address','<input name="address" required maxlength="500" autocomplete="street-address">')}<button class="btn accent quote-launch-btn" type="submit">Create customer &amp; open Google Earth</button></form>`);
    document.getElementById('sale-quote-search')?.focus();
  }
  function openStageSettings() {
    modal('Pipeline settings', `<form id="sale-stages-form"><p>Rename and reorder stages to fit your sales process. Built-in stages keep their identity for reporting. A custom stage can be deleted after all its opportunities have been moved elsewhere.</p>${stages.map((s,i) => `<div class="sale-settings-row"><b>${esc(s.key)}</b><input name="label-${esc(s.key)}" value="${esc(s.label)}" required maxlength="50"><input aria-label="${esc(s.label)} probability" name="prob-${esc(s.key)}" type="number" min="0" max="100" value="${Math.round((settings.probabilities?.[s.key] || 0) * 100)}"><button type="button" class="btn ghost sm" data-sale-action="stage-move" data-stage="${esc(s.key)}" data-delta="-1" aria-label="Move ${esc(s.label)} up" ${i===0?'disabled':''}>↑</button><button type="button" class="btn ghost sm" data-sale-action="stage-move" data-stage="${esc(s.key)}" data-delta="1" aria-label="Move ${esc(s.label)} down" ${i===stages.length-1?'disabled':''}>↓</button>${defaults.some(d=>d.key===s.key)?'':'<button type="button" class="btn ghost sm" data-sale-action="stage-remove" data-stage="'+esc(s.key)+'">Delete</button>'}</div>`).join('')}<button type="button" class="btn ghost" data-sale-action="stage-add">＋ Add custom stage</button>${field("Quote follow-up reminder after days", `<input name="days" type="number" min="1" max="365" value="${settings.followup_days || 2}">`)}<button class="btn accent">Save settings</button></form>`);
  }
  function error(e) {
    const el = document.getElementById("sales-dialog-error");
    if (el) el.textContent = e.message;
    toast(e.message);
  }
  async function loadSales() {
    if (!sb || !currentBusinessId) return;
    const biz = currentBusinessId;
    const results = await Promise.all([
      sb
        .from("sales_settings")
        .select("*")
        .eq("business_id", biz)
        .maybeSingle(),
      sb
        .from("sales_goals")
        .select("*")
        .eq("business_id", biz)
        .order("ends_at"),
      sb.from("sales_spend").select("*").eq("business_id", biz),
    ]);
    if (biz !== currentBusinessId) return;
    if (results.some((x) => x.error)) {
      migrationError = "The sales database upgrade has not been applied yet";
    } else {
      settings = results[0].data || {};
      cloudGoals = results[1].data || [];
      spend = results[2].data || [];
      const configuredPipeline = Array.isArray(settings.pipeline) ? settings.pipeline : [];
      const allowedStage = s => s && typeof s.key === 'string' && (defaults.some(d => d.key === s.key) || /^custom_[a-z0-9_]{3,48}$/.test(s.key));
      stages = configuredPipeline.filter(allowedStage).map(s => ({
        key: s.key,
        label: defaults.find(d => d.key === s.key)?.label || String(s.label || 'Custom stage').slice(0,50),
      }));
      for (const d of defaults) if (!stages.some(s => s.key === d.key)) stages.push({...d});
      migrationError = "";
    }
    try {
      const s = await api("/api/sales/servicem8/status");
      mappings = s.mappings || [];
    } catch {}
    render();
    renderActive();
    refreshMetrics();
  }
  handleAuthedSession = async function (session) {
    cloudGoals = [];
    spend = [];
    settings = {};
    metrics = null;
    mappings = [];
    stages = defaults.map((x) => ({ ...x }));
    await oldAuth(session);
  };
  renderAll = function () {
    if (typeof saveState === "function") saveState();
    metrics = null;
    renderActive();
  };
  function renderActive() {
    if (document.getElementById("view-dashboard").classList.contains("active"))
      renderDashboard();
    if (document.getElementById("view-sales").classList.contains("active"))
      renderSales();
    if (document.getElementById("view-goals").classList.contains("active"))
      renderGoals();
  }
  openMoreSheet = function () {
    document.getElementById("more-body").innerHTML =
      [
        ["Dashboard", "dashboard"],
        ["Leads", "leads"],
        ["Pipeline", "pipeline"],
        ["Customers", "customers"],
        ["Jobs & invoices", "operations"],
        ["Analytics", "sales"],
        ["Goals", "goals"],
        ["Conversations", "inbox"],
      ]
        .map(
          ([t, v]) =>
            `<button class="more-row" data-sale-action="nav" data-id="${v}">${t}</button>`,
        )
        .join("") +
      `<button class="more-row" data-sale-action="connections">Connections</button><button class="more-row" data-sale-action="import">Import records</button><button class="more-row" onclick="closeModal('more-overlay');openSettings()">Settings</button><button class="more-row" onclick="handleLogout()">Log out</button>`;
    openModal("more-overlay");
  };
  let connectionOpenSerial=0;
  openConnections = async function () {
    const call=++connectionOpenSerial,biz=currentBusinessId,version=businessSessionVersion;
    openModal('conn-overlay');
    document.getElementById('conn-body').innerHTML='<p role="status">Checking saved connections…</p>';
    await Promise.allSettled([loadEmailAccountStatus(),wixStatus.pendingUrl?Promise.resolve():loadWixStatus(),loadMetaStatus()]);
    if(call!==connectionOpenSerial||biz!==currentBusinessId||version!==businessSessionVersion||!document.getElementById('conn-overlay').classList.contains('open'))return;
    oldConnections();
    const el = document.createElement("div");
    el.className = "conn-card";
    el.id = "sale-sm8";
    el.innerHTML = "<h3>ServiceM8</h3><p>Checking connection…</p>";
    document.getElementById("conn-body").prepend(el);
    loadConnection();
  };
  async function loadConnection() {
    try {
      const s = await api("/api/sales/servicem8/status"),
        el = document.getElementById("sale-sm8");
      if (!el) return;
      mappings = s.mappings || [];
      el.innerHTML = `<h3>ServiceM8 · operations handoff</h3><p>${s.connected ? "Connected to " + esc(s.accountName || s.accountUuid) : "Connect ServiceM8 to transfer approved work."}</p>${s.connected ? `<p>Pending: ${s.pending || 0} · Failed: ${s.failed || 0} · Last sync: ${esc(dates(s.lastSyncAt))} · Status updates: ${s.webhookSubscribed ? "connected" : "not subscribed"}</p>${s.scheduleSyncPermissionMissing ? '<p class="sale-warning">Reconnect ServiceM8 to grant read_schedule. TurnKey can currently sync statuses, but cannot show ServiceM8 booking dates.</p>' : '<p>Linked ServiceM8 booking dates appear in TurnKey Calendar and are managed in ServiceM8.</p>'}${s.lastError ? `<p role="alert">${esc(s.lastError)}</p>` : ""}<label><input type="checkbox" data-sale-auto ${s.autoHandoff ? "checked" : ""}> Automatically transfer approved sales</label><div class="sale-actions">${button("Retry failed transfers", "retry", "", s.retryAvailable ? "" : "disabled")}${button("Refresh linked jobs", "refresh-jobs")}${s.scheduleSyncPermissionMissing?button("Reconnect for booking sync", "oauth-sm8"):""}${button(s.webhookSubscribed?"Refresh status hooks":"Connect status updates", "subscribe-sm8")}${button("Disconnect", "disconnect-sm8")}</div>` : `<div class="sale-actions">${button("Connect ServiceM8", "oauth-sm8", "", s.oauthConfigured ? "" : "disabled")}${s.privateEnabled ? button("Private API key (testing)", "private-sm8") : ""}</div><p>${s.oauthConfigured ? "Authorize access to your ServiceM8 account." : "ServiceM8 OAuth needs to be configured on the backend."}</p>`}`;
    } catch (e) {
      const el = document.getElementById("sale-sm8");
      if (el) el.textContent = "ServiceM8: " + e.message;
    }
  }
  openSettings = function () {
    oldSettings();
    const body = document.getElementById("settings-body");
    body.insertAdjacentHTML('beforeend',settingsGroup('Pipeline',`<p>Configure stage names, order and sales probabilities for your business.</p>${button('Manage pipeline stages','stages')}`));
  };
  const oldSaveLead = saveLead;
  saveLead = function () {
    const email = document
        .getElementById("l-email")
        ?.value?.trim()
        .toLowerCase(),
      phone = document.getElementById("l-phone")?.value?.replace(/[^0-9]/g, "");
    const matches = records.filter(
      (r) =>
        (email && r.email?.trim().toLowerCase() === email) ||
        (phone && r.phone?.replace(/[^0-9]/g, "") === phone),
    );
    if (
      matches.length &&
      !confirm(
        "An enquiry with this email or phone already exists. Create a separate opportunity anyway?",
      )
    ) {
      closeModal("lead-overlay");
      openDetail(matches[0].id);
      return;
    }
    const prior = new Set(records.map((r) => r.id));
    oldSaveLead();
    const r = records.find((r) => !prior.has(r.id));
    if (r) {
      r.nextFollowUpAt =
        r.nextFollowUpAt ||
        new Date(
          Date.now() + (settings.followup_days || 2) * 86400000,
        ).toISOString();
      r.salesHistory = [
        { at: Date.now(), label: "Manual lead captured", to: "new" },
      ];
      saveState();
    }
  };
  // Keep the original customer modal and its shared contact-save workflow reachable.
  openCustomerProfile = async function (id) {
    const r = record(id) || records.find(x => x.customerId === id);
    if (!r) { toast("Select an opportunity in Leads."); return; }
    await originalCustomerProfile(r.id);
  };
  openCustomerProfileByCustomerId = function (id) {
    const r = records.find((x) => x.customerId === id);
    if (r) openDetail(r.id);
    else switchView("leads");
  };
  openNewJobModal = function (customerId) {
    const r = records.find((x) => x.customerId === customerId);
    openLeadModal();
    if (r) {
      document.getElementById("l-name").value = r.name || "";
      document.getElementById("l-email").value = r.email || "";
      document.getElementById("l-phone").value = r.phone || "";
      document.getElementById("l-address").value = r.address || "";
    }
    document.getElementById("lead-modal-title").textContent =
      "New sales opportunity";
  };
  const originalIngest = ingestQuoteRequest;
  ingestQuoteRequest = function (payload) {
    const existing = records.find(
      (r) =>
        payload.external_id &&
        r.externalId === payload.external_id &&
        r.externalSource === payload.source,
    );
    if (existing) return existing;
    const before = new Set(records.map((r) => r.id));
    originalIngest(payload);
    const r =
      records.find((r) => !before.has(r.id)) ||
      records.find(
        (r) => payload.submittedAt && r._submittedAt === payload.submittedAt,
      );
    if (r) {
      r.externalId = payload.external_id || r.externalId || null;
      r.externalSource = payload.source || r.externalSource || null;
      r.campaignId = payload.campaign_id || r.campaignId || null;
      r.campaignName = payload.campaign_name || r.campaignName || null;
      r.nextFollowUpAt =
        r.nextFollowUpAt ||
        new Date(
          Date.now() + (settings.followup_days || 2) * 86400000,
        ).toISOString();
      if (!r.salesHistory?.length)
        r.salesHistory = [
          {
            at: M.leadTime(r) || Date.now(),
            label: "Lead received",
            to: "new",
          },
        ];
    }
    return r;
  };
  let polling = false;
  pollBackendLeads = async function () {
    if (polling || !sb || !currentBusinessId || !backendUrl()) return;
    polling = true;
    const biz = currentBusinessId;
    try {
      const j = await api("/api/leads/pending");
      const ack = [];
      for (const item of j.leads || []) {
        if (biz !== currentBusinessId) break;
        const r = ingestQuoteRequest(item.payload);
        if (!r) continue;
        try {
          await syncRecordToSupabase(r);
          ack.push(item.id);
        } catch (e) {
          console.error(
            "Lead save failed; intake remains pending",
            e.code || e.name,
          );
        }
      }
      if (ack.length && biz === currentBusinessId)
        await api("/api/leads/ack", {
          method: "POST",
          body: JSON.stringify({ ids: ack }),
        });
      backendOnline = true;
    } catch (e) {
      backendOnline = false;
    } finally {
      polling = false;
    }
  };
  const oldQuote = openQuoteModal;
  openQuoteModal = function (id) {
    const r = record(id);
    if (M.won(r)) {
      toast(
        "Approved pricing is locked. Create a new opportunity for additional work.",
      );
      return;
    }
    oldQuote(id);
  };
  const oldConfirm = confirmQuoteSend;
  confirmQuoteSend = function () {
    const r = record(activeLeadId);
    if (M.won(r)) {
      toast("Approved quote is locked.");
      return;
    }
    oldConfirm();
    if (!r || !r.services?.length) return;
    r.gstRegistered = !!COST_INPUTS.gstRegistered;
    r.targetMargin = Number(COST_INPUTS.targetMargin);
    r.services.forEach((l) => {
      l.priceSnapshot = lineSubtotal(l);
      l.fixedPrice = l.priceSnapshot;
    });
    r.publicTerms = currentBusinessProfile?.policies_config?.quoteTerms || "";
  };
  // The Conversations bridge advances the stage only after Gmail confirms delivery.
  // Reminders never send customer messages automatically. Existing manual mail flow remains available.
  autoFollowUp = function () {};
  const recordControl = '.ux-select,a,button,input,select,textarea,label,summary,[role="button"],[role="combobox"],[role="listbox"],[role="option"],[contenteditable]:not([contenteditable="false"])';
  document.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-record]");
    if (c && e.target.closest(recordControl)) { e.preventDefault(); return; }
    if (c) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.dataset.record); }
  });
  document.addEventListener("dragover", (e) => {
    if (e.target.closest("[data-drop-stage]")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
  });
  document.addEventListener("drop", (e) => {
    const col = e.target.closest("[data-drop-stage]");
    if (!col) return;
    e.preventDefault();
    move(record(e.dataTransfer.getData("text/plain")), col.dataset.dropStage);
  });
  // Customer-name buttons supply native Enter/Space behaviour without nesting
  // links, inputs or stage menus inside an article with role="button".
  document.addEventListener("input", (e) => {
    if(e.target.id==='pipeline-search'){pipelineSearch=e.target.value;const pos=e.target.selectionStart;render();const input=document.getElementById('pipeline-search');input.focus();input.setSelectionRange(pos,pos);return;}

    if (e.target.id === "sale-search") {
      search = e.target.value;
      const pos = e.target.selectionStart;
      renderLeads();
      const input = document.getElementById("sale-search");
      input.focus();
      input.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener("change", async (e) => {
    if(e.target.id==='pipeline-due'){pipelineDueOnly=e.target.checked;render();return;}
    if(e.target.id==='sale-leads-due'){leadsDueOnly=e.target.checked;renderLeads();return;}

    if (e.target.dataset.saleStage) {
      await move(record(e.target.dataset.saleStage), e.target.value);
      // A blocked or cancelled move must leave the visible menu on its saved stage.
      // Rebuild rejected controls so the parent's enhanced select also refreshes.
      if (e.target.isConnected && e.target.value !== P.key(record(e.target.dataset.saleStage))) render();
      if (
        activeId != null &&
        document.getElementById("view-detail").classList.contains("active")
      )
        openDetail(activeId);
    }
    if (e.target.hasAttribute("data-sale-auto")) {
      try {
        await api("/api/sales/servicem8/settings", {
          method: "POST",
          body: JSON.stringify({ autoHandoff: e.target.checked }),
        });
        toast("Handoff setting saved");
      } catch (err) {
        error(err);
      }
    }
    const key = e.target.dataset.saleFilter;
    if (!key) return;
    if (key === "sort") { leadSort=e.target.value; renderLeads(); return; }
    if (key === "source") {
      sourceFilter = e.target.value;
      renderLeads();
      return;
    }
    if (key === "stage") {
      stageFilter = e.target.value;
      renderLeads();
      return;
    }
    if (key === "period") period = e.target.value;
    if (key === "bucket") bucket = e.target.value;
    if (["start", "end"].includes(key)) custom[key] = e.target.value;
    metrics = null;
    renderActive();
    if (period !== "custom" || (custom.start && custom.end)) refreshMetrics();
  });
  document.addEventListener("click", async (e) => {
    if (e.defaultPrevented) return;
    const b = e.target.closest("[data-sale-action]");
    if (!b) {
      const c = e.target.closest("[data-record]");
      if (c && !e.target.closest(recordControl) && !window.getSelection()?.toString())
        openDetail(record(c.dataset.record)?.id);
      return;
    }
    const a = b.dataset.saleAction,
      r = record(b.dataset.id);
    try {
      if(a==='pipeline-reset'){pipelineScope='all';pipelineSearch='';pipelineDueOnly=false;render();document.getElementById('pipeline-search')?.focus();return;}
      if(a==='leads-reset'){search='';sourceFilter='';stageFilter='';leadSort='newest';leadsDueOnly=false;renderLeads();document.getElementById('sale-search')?.focus();return;}
      if(a==='leads-layout'){leadLayout=b.dataset.id==='table'?'table':'cards';renderLeads();document.querySelector(`#view-leads [data-sale-action="leads-layout"][data-id="${leadLayout}"]`)?.focus();return;}
      if(a==='leads-scope'){stageFilter=b.dataset.id;renderLeads();document.querySelector(`#view-leads [data-sale-action="leads-scope"][data-id="${stageFilter}"]`)?.focus();return;}
      if(a==='pipeline-scope'){pipelineScope=b.dataset.id;render();document.querySelector(`#view-pipeline [data-sale-action="pipeline-scope"][data-id="${pipelineScope}"]`)?.focus();return;}
      if(a==='pipeline-jump'){document.getElementById('pipeline-'+b.dataset.id)?.scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});return;}
      if(a==='customer-edit'){
        await openCustomerProfile(r.id);
        const input=document.getElementById('cp-name');
        input?.scrollIntoView({block:'center'});input?.focus({preventScroll:true});return;
      }
      if(a==='history'){
        if(activeId!==r.id||!document.getElementById('view-detail').classList.contains('active'))openDetail(r.id);
        const title=document.querySelector('#sale-history h3');title?.scrollIntoView({block:'start'});title?.focus({preventScroll:true});return;
      }
      if(a==='sales-plan'){const input=document.getElementById('sale-followup');input?.scrollIntoView({block:'center'});input?.focus({preventScroll:true});return;}
      if(a==='contact'){openComposeModal({to:r.email||'',subject:P.key(r)==='quoted'?'Following up on your quote':'Your enquiry',customerId:r.customerId,jobId:r.jobId,opportunityId:String(r.id)});return;}
      if(a==='marketing'){window.TK_MARKETING?.open();return;}
      if(a==='confirm-sale'){if(confirm('Record this quote as accepted? If automatic handoff is enabled, the approved work will be sent to ServiceM8.')){await move(r,'won');openDetail(r.id);}return;}
      if (a === "collapse") {
        const collapsed = document.body.classList.toggle(
          "sale-sidebar-collapsed",
        );
        b.setAttribute("aria-expanded", String(!collapsed));
      }
      if (a === "dialog-close") document.getElementById("sales-dialog").close();
      if (a === "new") openLeadModal();
      if (a === "import") openImportWizard();
      if (a === "nav") {
        closeModal("more-overlay");
        switchView(b.dataset.id);
      }
      if (a === "pipeline") switchView("pipeline");
      if (a === "quote-home") openQuotePicker();
      if (a === "quote-select") { document.getElementById('sales-dialog')?.close(); await buildEarthQuote(r.id); }
      if (a === "edit-quote") openQuoteModal(r.id);
      if (a === "inbox") switchView("inbox");
      if (a === "detail") openDetail(r.id);
      if (a === "connections") openConnections();
      if (a === "quote") {
        if (M.won(r)) {
          if (
            !confirm(
              "Create a separate opportunity for this customer? The approved quote will stay unchanged.",
            )
          )
            return;
          const n = newRecord({
            name: r.name,
            email: r.email,
            phone: r.phone,
            address: r.address,
            suburb: r.suburb,
            source: r.source,
            customerId: r.customerId,
          });
          records.unshift(n);
          render();
          await buildEarthQuote(n.id);
        } else await buildEarthQuote(r.id);
      }
      if (a === "save-details") {
        r.opportunityValue = Math.max(
          0,
          Number(document.getElementById("sale-opportunity").value) || 0,
        );
        r.assignedSalespersonId =
          document.getElementById("sale-assignee").value || null;
        r.salespersonName =
          staff.find((x) => x.id === r.assignedSalespersonId)?.name || null;
        const v = document.getElementById("sale-followup").value;
        r.nextFollowUpAt = v ? new Date(v).toISOString() : null;
        r.salesNotes = document
          .getElementById("sale-notes")
          .value.slice(0, 10000);
        r.salesHistory = [
          ...(r.salesHistory || []),
          { at: Date.now(), label: "Sales details updated" },
        ];
        await syncRecordToSupabase(r);
        saveState();
        openDetail(r.id);
        toast("Sales details saved");
      }
      if (a === "versions") {
        const host=document.getElementById("sale-versions");
        if(!r?.quoteId){host.innerHTML=empty(r&&M.won(r)&&r.jobId?"This sale predates quote tracking and has no saved quote. Use “Transfer approved sale” to review and record its details.":r?.total>0?"An estimate is on file but no quote has been saved yet. Open “Build / edit quote” and continue through to Preview & send to save it and start its history.":"No saved quote yet. Build and save a quote to start its history.");return;}
        host.innerHTML='<p role="status">Loading saved quotes…</p>';
        b.disabled=true;
        try {
          const result=await api("/api/sales/quotes/"+encodeURIComponent(r.quoteId)+"/history");
          if(activeId!==r.id||!host.isConnected)return;
          const versions=result.versions||[];
          host.innerHTML='<h3>Saved quote versions</h3>'+ (versions.length ? table(["Saved","Quote amount","Status"],versions.map(x=>[dates(x.createdAt||x.created_at),money(x.snapshot?.amount||0),x.snapshot?.accepted?'Accepted · locked':'Saved quote'])) : empty("No saved versions exist for this legacy quote."));
        } catch(e) {if(host.isConnected)host.innerHTML='<p role="alert">'+esc(e.message)+'</p>';}
        finally {b.disabled=false;}
      }
      if (a === "export") {
        const rep = currentReport(),
          rows = [
            ...rep.source.map((x) => ({ report: "Lead source", ...x })),
            ...rep.salespeople.map((x) => ({ report: "Salesperson", ...x })),
            ...rep.services.map((x) => ({ report: "Service", ...x })),
            ...rep.series.map((x) => ({ report: "Booked sales", ...x })),
            ...rep.lostReasons.map((x) => ({ report: "Lost reason", ...x })),
          ];
        const url = URL.createObjectURL(
          new Blob([M.csv(rows)], { type: "text/csv;charset=utf-8" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download =
          "turnkey-sales-" + new Date().toISOString().slice(0, 10) + ".csv";
        link.click();
        URL.revokeObjectURL(url);
      }
      if (a === "goal-new")
        modal(
          "Set a business goal",
          `<form id="sale-goal-form">${field("Goal name", '<input name="label" required maxlength="200">')}${field(
            "Metric",
            `<select name="metric">${options([
              ["revenue", "Booked revenue"],
              ["leads", "Leads received"],
              ["quotes", "Quotes sent"],
              ["conversion", "Conversion %"],
              ["margin", "Estimated gross margin %"],
            ])}</select>`,
          )}${field("Target", '<input name="target" type="number" min="0.01" step="0.01" required>')}${field(
            "Period preset",
            `<select name="preset">${options([
              ["month", "Monthly"],
              ["week", "Weekly"],
              ["quarter", "Quarterly"],
              ["year", "Annual"],
              ["custom", "Custom"],
            ])}</select>`,
          )}${field("Start", '<input name="start" type="date" required value="' + todayISO() + '">')}${field("End (inclusive)", '<input name="end" type="date">')}${field("Salesperson", `<select name="person">${options([["", "Whole business"], ...staff.map((x) => [x.id, x.name || x.email])])}</select>`)}${field("Reward", '<input name="reward" maxlength="500">')}<button class="btn accent" type="submit">Save goal</button></form>`,
        );
      if (a === "recover-goals" && canRecoverLegacyGoals()) {
        if (
          !confirm(
            "Earlier goals have no business identity. Confirm that the goals previously stored on this device belong to your current business before importing them.",
          )
        )
          return;
        const cached = JSON.parse(
          localStorage.getItem(STORE_KEY + ":legacy-unassigned") || "{}",
        );
        goals = [...goals, ...cached.goals];
        localStorage.setItem(
          STORE_KEY + ":legacy-goals-owner",
          currentBusinessId,
        );
        saveState();
        renderGoals();
        toast("Earlier device goals recovered for this business");
      }
      if (a === "goal-delete") {
        if (!confirm("Delete this goal?")) return;
        const { error: err } = await sb
          .from("sales_goals")
          .delete()
          .eq("business_id", currentBusinessId)
          .eq("id", b.dataset.id);
        if (err) throw err;
        await loadSales();
      }
      if (a === "stages") {closeModal('settings-overlay');openStageSettings();}
      if (a === "stage-add") {
        const label = prompt("Name this pipeline stage");
        if (!label?.trim()) return;
        const key = 'custom_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        stages.push({key,label:label.trim().slice(0,50)});
        openStageSettings(); return;
      }
      if (a === "stage-move") {
        const from=stages.findIndex(s=>s.key===b.dataset.stage),to=from+Number(b.dataset.delta);
        if(from<0||to<0||to>=stages.length)return;
        [stages[from],stages[to]]=[stages[to],stages[from]];
        openStageSettings(); return;
      }
      if (a === "stage-remove") {
        const key=b.dataset.stage;
        if(defaults.some(s=>s.key===key)){toast('Built-in stages cannot be removed.');return;}
        if(records.some(r=>String(r.stage)===key)){toast('Move every opportunity out of this stage before deleting it.');return;}
        stages=stages.filter(s=>s.key!==key);openStageSettings();return;
      }
      if (a === "spend")
        modal(
          "Record advertising spend",
          `<form id="sale-spend-form">${field("Source", '<input name="source" placeholder="e.g. Meta, Instagram or Wix" required maxlength="100">')}${field("Campaign (optional)", '<input name="campaign" maxlength="200">')}${field("Amount", '<input name="amount" type="number" min="0" step="0.01" required>')}${field("Spend date", '<input name="date" type="date" required value="' + todayISO() + '">')}<button class="btn accent">Save spend</button></form>`,
        );
      if (a === "oauth-sm8") {
        const targetOrigin = new URL(backendUrl()).origin;
        let popup;
        const listener = async (event) => {
          if (
            event.origin !== targetOrigin ||
            event.source !== popup ||
            event.data?.type !== "turnkey-servicem8-ready"
          )
            return;
          window.removeEventListener("message", listener);
          try {
            const { url } = await api(
              "/api/sales/servicem8/oauth/start?browser=" +
                encodeURIComponent(event.data.nonce),
            );
            popup.location = url;
          } catch (err) {
            popup.close();
            error(err);
          }
        };
        window.addEventListener("message", listener);
        popup = window.open(
          backendUrl() + "/api/sales/servicem8/oauth/prepare",
          "turnkey-servicem8",
          "width=650,height=800",
        );
        if (!popup) {
          window.removeEventListener("message", listener);
          throw Error("Allow the connection popup to authorize ServiceM8.");
        }
      }
      if(a === "subscribe-sm8") {await api('/api/sales/servicem8/webhooks',{method:'POST'});await loadConnection();toast('ServiceM8 status updates connected');}
      if (a === "private-sm8")
        modal(
          "Private ServiceM8 test connection",
          `<form id="sale-private-form">${field("API key", '<input name="key" type="password" autocomplete="off" required>')}<p>For a single-company private test. Production SaaS accounts should connect with OAuth.</p><button class="btn accent">Connect test account</button></form>`,
        );
      if (a === "disconnect-sm8") {
        if (
          confirm(
            "Disconnect ServiceM8? Existing sales and transferred jobs will be preserved.",
          )
        ) {
          await api("/api/sales/servicem8/disconnect", { method: "POST" });
          await loadConnection();
        }
      }
      if (a === "retry") {
        await api("/api/sales/servicem8/retry", { method: "POST" });
        toast("Failed transfers queued for retry");
        loadConnection();
      }
      if (a === "refresh-jobs") {
        await api("/api/sales/servicem8/refresh", { method: "POST" });
        toast("Linked jobs queued for refresh");
      }
      if (a === "handoff" || a === "handoff-quote") {
        b.disabled=true;
        try {
          if(a==='handoff-quote'&&r.stage==='new')r.stage='quoting';
          await syncRecordToSupabase(r);
          if(!r.jobId)throw Error("Save this opportunity before transferring it.");
          // A draft quote transfer always needs an actual saved quote object.
          // An approved-sale transfer can still proceed without one — a
          // pre-quote-tracking legacy sale goes through the explicit review
          // below instead (backend never fabricates a quote without it).
          if(a==='handoff-quote'&&!r.quoteId)throw Error("Save a complete quote before transferring it.");
          let reviewedGst;
          const transfer=reviewLegacy=>api("/api/sales/servicem8/handoff", {
            method: "POST",
            body: JSON.stringify({ jobId: r.jobId, ...(a==='handoff-quote'?{mode:'quote'}:{}), ...(reviewLegacy?{reviewLegacy:true}:{}), ...(typeof reviewedGst==='boolean'?{gstRegistered:reviewedGst}:{}) }),
          });
          try {await transfer(false);}
          catch(e){
            if(e.code!=='LEGACY_REVIEW_REQUIRED')throw e;
            if(e.missingFields?.includes('amount'))throw Error('This legacy opportunity has no recorded quote amount to transfer. Enter and save a quote total first, then retry the transfer.');
            if(e.missingFields?.includes('gstRegistered')){
              const tax=prompt('This historical quote has no saved GST treatment. Check the original quote. Type GST if the accepted total includes 15% GST, or NO GST if no GST was charged. Cancel stops the transfer.');
              if(tax===null)return;
              const answer=tax.trim().toUpperCase();
              if(!['GST','NO GST'].includes(answer))throw Error('Transfer cancelled. Enter GST or NO GST to review the historical tax treatment.');
              reviewedGst=answer==='GST';
            }
            const services=(r.services||[]).map(l=>(SERVICES[l.svc]?.label||l.svc)+': '+l.qty).join('\n');
            if(!confirm('This accepted quote predates saved approval versions. Review its current details before transferring.\n\n'+r.name+'\n'+(r.address||'')+'\n'+services+'\nAccepted total: '+money(r.total)+'\nTax: '+((reviewedGst??r.gstRegistered)?'Includes 15% GST':'No GST charged')+'\n\nTransfer these details to ServiceM8? This records your review; it does not recreate the original approval history.'))return;
            await transfer(true);
          }
          toast(a==='handoff-quote'?"Quote queued for ServiceM8. Send and schedule it there.":"Approved sale queued for ServiceM8.");
          await loadSales();
          if(activeId===r.id)openDetail(r.id);
        } finally {b.disabled=false;}
      }

    } catch (err) {
      error(err);
    }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.id === 'sale-quote-new') {
      e.preventDefault();
      const f=new FormData(form),name=String(f.get('name')||'').trim();
      if(!name)return;
      if(!sb||!currentBusinessId){error(Error('Sign in before creating a customer quote.'));return;}
      const customer=newRecord({name,phone:String(f.get('phone')||'').trim(),email:String(f.get('email')||'').trim(),address:String(f.get('address')||'').trim(),source:'Manual'});
      records.unshift(customer);render();
      const submit=form.querySelector('button[type="submit"],button:last-child');if(submit)submit.disabled=true;
      try{await syncRecordToSupabase(customer);document.getElementById('sales-dialog').close();}
      catch(err){records=records.filter(x=>x!==customer);render();error(err);}
      if(records.includes(customer))try{await buildEarthQuote(customer.id);}catch(err){error(err);}
      return;
    }
    if (
      ![
        "sale-goal-form",
        "sale-stages-form",
        "sale-spend-form",
        "sale-private-form",
      ].includes(form.id)
    )
      return;
    e.preventDefault();
    const f = new FormData(form);
    const submit = form.querySelector('[type="submit"],button:last-child');
    if (submit) submit.disabled = true;
    try {
      if (form.id === "sale-goal-form") {
        const start = new Date(f.get("start") + "T00:00:00"),
          end = new Date(start),
          preset = f.get("preset");
        if (f.get("end")) {
          end.setTime(new Date(f.get("end") + "T00:00:00").getTime());
          end.setDate(end.getDate() + 1);
        } else if (preset === "week") end.setDate(end.getDate() + 7);
        else if (preset === "month") end.setMonth(end.getMonth() + 1);
        else if (preset === "quarter") end.setMonth(end.getMonth() + 3);
        else if (preset === "year") end.setFullYear(end.getFullYear() + 1);
        else throw Error("Choose an end date");
        if (end <= start) throw Error("End must be after start");
        const { error: err } = await sb.from("sales_goals").insert({
          business_id: currentBusinessId,
          label: f.get("label"),
          metric: f.get("metric"),
          target: Number(f.get("target")),
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          salesperson_id: f.get("person") || null,
          reward: f.get("reward"),
        });
        if (err) throw err;
      }
      if (form.id === "sale-stages-form") {
        const pipeline = stages.map((s) => ({
            key: s.key,
            label: String(f.get("label-" + s.key)),
          })),
          probabilities = Object.fromEntries(
            stages.map((s) => [s.key, Number(f.get("prob-" + s.key)) / 100]),
          );
        const { error: err } = await sb.from("sales_settings").upsert({
          business_id: currentBusinessId,
          pipeline,
          probabilities,
          followup_days: Number(f.get("days")),
          updated_at: new Date().toISOString(),
        });
        if (err) throw err;
      }
      if (form.id === "sale-spend-form") {
        const { error: err } = await sb.from("sales_spend").insert({
          business_id: currentBusinessId,
          source: f.get("source"),
          campaign: f.get("campaign") || null,
          amount: Number(f.get("amount")),
          spent_at: f.get("date"),
        });
        if (err) throw err;
      }
      if (form.id === "sale-private-form") {
        await api("/api/sales/servicem8/private", {
          method: "POST",
          body: JSON.stringify({ apiKey: f.get("key") }),
        });
        loadConnection();
      }
      document.getElementById("sales-dialog").close();
      toast("Saved");
      await loadSales();
    } catch (err) {
      error(err);
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  document.addEventListener('input',e=>{if(e.target.id==='sale-quote-search'){const host=document.getElementById('sale-quote-results');if(host)host.innerHTML=quotePickerRows(e.target.value);}});
  // Match mobile selection and initial server-side login landing.
  document
    .querySelector('#bottom-nav [data-view="pipeline"]')
    ?.classList.remove("active");
  const dashboardNav = document.querySelector(
    '#bottom-nav [data-view="leads"]',
  );
  if (dashboardNav) {
    dashboardNav.dataset.view = "dashboard";
    dashboardNav.textContent = "Dashboard";
    dashboardNav.classList.add("active");
  }
  window.addEventListener("focus", () => {
    if (document.getElementById("conn-overlay")?.classList.contains("open"))
      loadConnection();
  });
  window.TK_SALES_PLATFORM = {
    moveStage: async (id, key) => move(record(id), key),
    transferQuote: async (id) => {
      const r=record(id);
      if(!r||M.won(r))throw Error('Select an editable quote to transfer.');
      if(r.stage==='new')r.stage='quoting';
      await syncRecordToSupabase(r);
      if(!r.jobId||!r.quoteId||!r.services?.length||!(r.total>0))throw Error('Save a complete quote before transferring.');
      await api('/api/sales/servicem8/handoff',{method:'POST',body:JSON.stringify({jobId:r.jobId,mode:'quote'})});
      toast('Quote queued for ServiceM8. Send and schedule it there.');
    },
    refresh: loadSales,
    report: currentReport,
    reset: () => {
      pipelineScope="all"; pipelineSearch=""; pipelineDueOnly=false;
      search=""; sourceFilter=""; stageFilter=""; leadSort="newest"; leadLayout="cards"; leadsDueOnly=false; activeId=null;
      cloudGoals = [];
      spend = [];
      settings = {};
      metrics = null;
      mappings = [];
      migrationError = "";
      ++connectionOpenSerial;
      stages = defaults.map((x) => ({ ...x }));
    },
  };
})();
