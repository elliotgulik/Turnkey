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
  const defaults = [
    ["new", "New Lead"],
    ["contacted", "Contacted"],
    ["qualified", "Qualified"],
    ["quoting", "Quote in Progress"],
    ["quoted", "Quote Sent"],
    ["followup", "Follow-Up"],
    ["won", "Won"],
    ["lost", "Lost"],
  ].map(([key, label]) => ({ key, label }));
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
    migrationError = "",
    busy = false,
    serial = 0,
    activeId = null,
    mappings = [];
  const oldRender = render,
    oldAll = renderAll,
    oldConnections = openConnections,
    oldAuth = handleAuthedSession,
    oldSettings = openSettings;
  const record = (id) => records.find((r) => String(r.id) === String(id));
  const button = (text, action, id = "", extra = "") =>
    `<button class="btn ghost sm" data-sale-action="${action}" data-id="${esc(id)}" ${extra}>${esc(text)}</button>`;
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
    if (!response.ok) throw Error(data.error || "Request failed");
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
        button("Export report", "export") + button("Record ad spend", "spend"),
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
  function card(r) {
    const due = r.nextFollowUpAt && Date.parse(r.nextFollowUpAt) < Date.now();
    const age = M.leadTime(r);
    return `<article class="sale-card" draggable="true" data-record="${esc(r.id)}" tabindex="0" role="button" aria-label="Open ${esc(r.name)}"><div class="sale-card-top"><b>${esc(r.name || "Unnamed enquiry")}</b><span>${esc(money(r.total || r.opportunityValue || 0))}</span></div><p>${esc((r.requestedServices || []).map((x) => x.name || x).join(", ") || (r.services || []).map((x) => SERVICES[x.svc]?.label || x.svc).join(", ") || "Services to confirm")}</p><div class="sale-tags"><span>${esc(r.source || "Manual")}</span><span>${age ? Math.max(0, Math.floor((Date.now() - age) / 86400000)) + "d old" : "Age unknown"}</span></div><small>${esc(r.salespersonName || "Unassigned")}${r.nextFollowUpAt ? " · Follow-up " + esc(new Date(r.nextFollowUpAt).toLocaleDateString()) : ""}</small>${due ? '<strong class="sale-overdue">Follow-up overdue</strong>' : ""}<select data-sale-stage="${esc(r.id)}" aria-label="Sales stage">${options(
      stages.map((x) => [x.key, x.label]),
      M.stage(r),
    )}</select></article>`;
  }
  render = function () {
    if (typeof saveState === "function") saveState();
    document.getElementById("cnt-leads").textContent = records.filter(
      (r) => r.stage === "new",
    ).length;
    document.getElementById("view-pipeline").innerHTML =
      header(
        "Pipeline",
        "Move every enquiry toward a clear outcome.",
        button("+ New lead", "new") + button("Configure stages", "stages"),
      ) +
      `<div class="sale-kanban">${stages
        .map((s) => {
          const rs = records.filter((r) => M.stage(r) === s.key);
          return `<section class="sale-column" data-drop-stage="${esc(s.key)}"><header><h3>${esc(s.label)} <span>${rs.length}</span></h3><small>${esc(money(rs.reduce((n, x) => n + (Number(x.total || x.opportunityValue) || 0), 0)))}</small></header>${rs.map(card).join("") || empty("No opportunities")}</section>`;
        })
        .join("")}</div>`;
    renderLeads();
  };
  function renderLeads() {
    let rs = records.filter(
      (r) => !M.won(r) && !M.lost(r) && r.stage !== "cancelled",
    );
    if (search)
      rs = rs.filter((r) =>
        [r.name, r.email, r.phone, r.address, r.source]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
      );
    if (sourceFilter)
      rs = rs.filter((r) => (r.source || "Manual") === sourceFilter);
    if (stageFilter) rs = rs.filter((r) => M.stage(r) === stageFilter);
    const sources = [
      ...new Set(records.map((r) => r.source || "Manual")),
    ].sort();
    document.getElementById("view-leads").innerHTML =
      header(
        "Leads",
        "All open enquiries and qualified sales opportunities.",
        button("+ New lead", "new") + button("Import", "import"),
      ) +
      `<div class="sale-filters">${field("Search", `<input id="sale-search" type="search" value="${esc(search)}" placeholder="Name, email, phone or address">`)}${field("Source", `<select data-sale-filter="source">${options([["", "All sources"], ...sources.map((s) => [s, s])], sourceFilter)}</select>`)}${field("Stage", `<select data-sale-filter="stage">${options([["", "All open stages"], ...stages.filter((x) => !["won", "lost"].includes(x.key)).map((x) => [x.key, x.label])], stageFilter)}</select>`)}</div><div class="sale-lead-grid">${rs.map(card).join("") || empty("No matching enquiries. Add a lead, import contacts or connect a lead source.")}</div>`;
  }
  async function move(r, key) {
    if (!r) return;
    if (M.won(r) && key !== "won") {
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
      const reason = prompt("Why was this opportunity lost?");
      if (!reason?.trim()) return;
      r.lostReason = reason.trim().slice(0, 500);
      r.lostAt = at;
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
    const map = mappings.find(
      (m) => m.local_id === r.jobId && m.object_type === "job",
    );
    document.getElementById("view-detail").innerHTML =
      header(
        r.name || "Sales opportunity",
        r.address || "Property address not set",
        button("← Pipeline", "pipeline") +
          button(
            M.won(r) ? "New quote for this customer" : "Build / edit quote",
            "quote",
            r.id,
          ),
      ) +
      `<div class="sale-grid"><section class="sale-panel"><h3>Enquiry &amp; contact</h3><div class="sale-actions">${r.phone ? `<a class="btn ghost" href="tel:${esc(r.phone.replace(/[^+\d]/g, ""))}">Call</a>` : ""}${r.email ? `<a class="btn ghost" href="mailto:${esc(r.email)}">Email</a>` : ""}${button("Conversations", "inbox")}</div><dl class="sale-dl"><dt>Email</dt><dd>${esc(r.email || "Not set")}</dd><dt>Phone</dt><dd>${esc(r.phone || "Not set")}</dd><dt>Received</dt><dd>${esc(dates(M.leadTime(r)))}</dd><dt>Source</dt><dd>${esc(r.source || "Manual")}</dd></dl>${field(
        "Sales stage",
        `<select data-sale-stage="${esc(r.id)}">${options(
          stages.map((s) => [s.key, s.label]),
          M.stage(r),
        )}</select>`,
      )}${field("Estimated opportunity value", `<input id="sale-opportunity" type="number" min="0" step="0.01" value="${esc(r.opportunityValue || 0)}">`)}${field("Salesperson", `<select id="sale-assignee">${options([["", "Unassigned"], ...staff.map((x) => [x.id, x.name || x.email])], r.assignedSalespersonId || "")}</select>`)}${field("Next follow-up", `<input id="sale-followup" type="datetime-local" value="${r.nextFollowUpAt ? esc(localDateTime(r.nextFollowUpAt)) : ""}">`)}${field("Sales notes", `<textarea id="sale-notes" rows="4">${esc(r.salesNotes || r.jobNotes || "")}</textarea>`)}${button("Save sales details", "save-details", r.id)}</section><section class="sale-panel"><h3>Quote &amp; profitability</h3>${table(
        ["Metric", "Value"],
        [
          ["Customer quote (incl. GST)", money(r.total || 0)],
          ["Estimated delivery costs", moneySafe(r.estimatedCost)],
          [
            "Estimated margin",
            r.estimatedMarginPct == null
              ? "Unavailable"
              : r.estimatedMarginPct + "%",
          ],
          ["Quote sent", dates(r.quoteSentAt)],
          ["Sale won", dates(M.winTime(r))],
        ],
      )}<p>${esc((r.services || []).map((x) => SERVICES[x.svc]?.label || x.svc).join(", "))}</p>${r.quotePublicToken ? `<a class="btn ghost" target="_blank" rel="noopener" href="quote.html?t=${encodeURIComponent(r.quotePublicToken)}">Open customer quote</a>` : ""}${button("Quote history", "versions", r.id)}<h3>ServiceM8 handoff</h3><p>TurnKey owns the sale. ServiceM8 owns scheduling, delivery, invoices and payments.</p>${map ? `<a class="btn accent" target="_blank" rel="noopener" href="https://go.servicem8.com/OpenJob/${encodeURIComponent(map.external_uuid)}">Open in ServiceM8</a><p class="sale-muted">Last checked ${esc(dates(map.synced_at))}</p>` : button("Transfer approved sale", "handoff", r.id, M.won(r) ? "" : "disabled")}<div id="sale-versions"></div></section></div><section class="sale-panel"><h3>Sales history</h3>${
        (r.salesHistory || []).length
          ? (r.salesHistory || [])
              .slice()
              .reverse()
              .map(
                (e) =>
                  `<div class="sale-row"><div>${esc(e.label || e.to)}<small>${esc(dates(e.at))}</small></div></div>`,
              )
              .join("")
          : empty(
              "Historical stage timestamps are not available for this record.",
            )
      }</section>`;
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
      stages = defaults.map((d) => ({
        key: d.key,
        label: String(
          (Array.isArray(settings.pipeline) ? settings.pipeline : []).find(
            (s) => s.key === d.key,
          )?.label || d.label,
        ).slice(0, 50),
      }));
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
        ["Quote Builder", "quote-builder"],
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
  openConnections = function () {
    oldConnections();
    document.querySelectorAll("#conn-body .conn-card").forEach((c) => {
      if (
        /^Calendar|^Stripe/.test(
          c.querySelector(".conn-name")?.textContent || "",
        )
      )
        c.remove();
    });
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
      el.innerHTML = `<h3>ServiceM8 · operations handoff</h3><p>${s.connected ? "Connected to " + esc(s.accountName || s.accountUuid) : "Connect ServiceM8 to transfer approved work."}</p>${s.connected ? `<p>Pending: ${s.pending || 0} · Failed: ${s.failed || 0} · Last sync: ${esc(dates(s.lastSyncAt))}</p>${s.lastError ? `<p role="alert">${esc(s.lastError)}</p>` : ""}<label><input type="checkbox" data-sale-auto ${s.autoHandoff ? "checked" : ""}> Automatically transfer approved sales</label><div class="sale-actions">${button("Retry failed transfers", "retry")}${button("Refresh linked jobs", "refresh-jobs")}${button("Disconnect", "disconnect-sm8")}</div>` : `<div class="sale-actions">${button("Connect ServiceM8", "oauth-sm8", "", s.oauthConfigured ? "" : "disabled")}${s.privateEnabled ? button("Private API key (testing)", "private-sm8") : ""}</div><p>${s.oauthConfigured ? "Authorize access to your ServiceM8 account." : "ServiceM8 OAuth needs to be configured on the backend."}</p>`}`;
    } catch (e) {
      const el = document.getElementById("sale-sm8");
      if (el) el.textContent = "ServiceM8: " + e.message;
    }
  }
  openSettings = function () {
    oldSettings();
    const body = document.getElementById("settings-body");
    body.querySelectorAll(".more-group-label").forEach((label) => {
      if (
        ["Team", "Workflows", "Calendar", "Billing"].includes(
          label.textContent.trim(),
        )
      ) {
        let next = label.nextElementSibling;
        while (next && !next.classList.contains("more-group-label")) {
          const n = next.nextElementSibling;
          next.remove();
          next = n;
        }
        label.remove();
      }
    });
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
  // Secondary conversation links open the sales record, rather than an operational customer hub.
  openCustomerProfile = function (id) {
    const r = record(id) || records.find((x) => x.customerId === id);
    if (r) openDetail(r.id);
    else toast("Select an opportunity in Leads.");
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
  const oldSend = sendQuoteDoc;
  sendQuoteDoc = function () {
    const r = record(docPreview.recordId);
    if (!r || M.won(r)) {
      toast("Approved quote is locked.");
      return;
    }
    const firstQuoteSentAt = r.quoteSentAt;
    r.firstResponseAt = r.firstResponseAt || Date.now();
    r.salesHistory = [
      ...(r.salesHistory || []),
      { at: Date.now(), label: "Quote sent", to: "quoted" },
    ];
    r.nextFollowUpAt =
      r.nextFollowUpAt ||
      new Date(
        Date.now() + (settings.followup_days || 2) * 86400000,
      ).toISOString();
    oldSend();
    r.lastQuoteSentAt = r.quoteSentAt;
    r.quoteSentAt = firstQuoteSentAt || r.quoteSentAt;
    if (!["quoted", "followup"].includes(r.stage)) r.stage = "quoted";
    saveState();
    metrics = null;
    render();
    renderActive();
  };
  // Reminders never send customer messages automatically. Existing manual mail flow remains available.
  autoFollowUp = function () {};
  document.addEventListener("dragstart", (e) => {
    const c = e.target.closest("[data-record]");
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("[data-record]"))
      openDetail(record(e.target.dataset.record)?.id);
  });
  document.addEventListener("input", (e) => {
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
    if (e.target.dataset.saleStage) {
      await move(record(e.target.dataset.saleStage), e.target.value);
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
    const b = e.target.closest("[data-sale-action]");
    if (!b) {
      const c = e.target.closest("[data-record]");
      if (c && !e.target.closest("select"))
        openDetail(record(c.dataset.record)?.id);
      return;
    }
    const a = b.dataset.saleAction,
      r = record(b.dataset.id);
    try {
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
      if (a === "quote-home") switchView("quote-builder");
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
          openQuoteModal(n.id);
        } else openQuoteModal(r.id);
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
        toast("Sales details saved");
      }
      if (a === "versions") {
        const { data, error: err } = await sb
          .from("quote_versions")
          .select("id,created_at,snapshot")
          .eq("business_id", currentBusinessId)
          .eq("quote_id", r.quoteId)
          .order("created_at", { ascending: false });
        if (err) throw err;
        document.getElementById("sale-versions").innerHTML =
          "<h3>Saved quote versions</h3>" +
          table(
            ["Saved", "Quote amount"],
            (data || []).map((x) => [
              dates(x.created_at),
              money(x.snapshot.amount),
            ]),
          );
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
      if (a === "stages")
        modal(
          "Pipeline settings",
          `<form id="sale-stages-form"><p>Stage identities stay stable so historical records remain valid. Rename stages and set their win probability. Probabilities are assumptions, not confirmed revenue.</p>${stages.map((s) => `<div class="sale-settings-row"><b>${esc(s.key)}</b><input name="label-${esc(s.key)}" value="${esc(s.label)}" required maxlength="50"><input aria-label="${esc(s.label)} probability" name="prob-${esc(s.key)}" type="number" min="0" max="100" value="${Math.round((settings.probabilities?.[s.key] || 0) * 100)}"></div>`).join("")}${field("Quote follow-up reminder after days", `<input name="days" type="number" min="1" max="365" value="${settings.followup_days || 2}">`)}<button class="btn accent">Save settings</button></form>`,
        );
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
      if (a === "handoff") {
        if (!r.jobId) await syncRecordToSupabase(r);
        await api("/api/sales/servicem8/handoff", {
          method: "POST",
          body: JSON.stringify({ jobId: r.jobId }),
        });
        toast("Transfer queued. Check Connections for progress.");
      }
    } catch (err) {
      error(err);
    }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target;
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
    refresh: loadSales,
    report: currentReport,
    reset: () => {
      cloudGoals = [];
      spend = [];
      settings = {};
      metrics = null;
      mappings = [];
      migrationError = "";
      stages = defaults.map((x) => ({ ...x }));
    },
  };
})();
