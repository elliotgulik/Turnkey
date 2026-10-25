/* Parent loads this file + marketing-analytics.css and calls TK_MARKETING.open(). */
(function (root) {
  "use strict";
  let config = {},
    host = null,
    serial = 0,
    report = null,
    busy = false,
    returnFocus = null,
    tenantTimer = null,
    inlineSerial = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  const state = {
    since: new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10),
    until: today(),
    level: "campaign",
    page: 0,
    view: "entities",
  };
  const esc = (v) =>
    String(v ?? "").replace(
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
  const fmt = (v) =>
    v == null
      ? "—"
      : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  function tenant() {
    return config.getBusinessId
      ? config.getBusinessId()
      : typeof currentBusinessId !== "undefined"
        ? currentBusinessId
        : null;
  }
  async function request(path, options = {}, csv = false) {
    if (config.request)
      return config.request("/api/marketing" + path, options, { csv });
    const client = config.client || (typeof sb !== "undefined" ? sb : null);
    const base =
      config.backendUrl ||
      (typeof backendUrl === "function"
        ? backendUrl()
        : root.TURNKEY_CONFIG?.backendUrl);
    if (!client || !base)
      throw Error(
        "Connect the TurnKey backend and sign in to use marketing reports.",
      );
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw Error("Please sign in again.");
    const response = await fetch(
      base.replace(/\/$/, "") + "/api/marketing" + path,
      {
        ...options,
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + data.session.access_token,
        },
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Error(body.error || "Marketing request failed.");
    }
    return csv ? response.text() : response.json();
  }
  const query = () => "?" + new URLSearchParams({ ...state, limit: "100" });
  function message(text, error = false) {
    const el = host?.querySelector("[data-message]");
    if (el) {
      el.textContent = text;
      el.setAttribute("role", error ? "alert" : "status");
    }
  }
  function download(text, name) {
    const url = URL.createObjectURL(
        new Blob([text], { type: "text/csv;charset=utf-8" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearReport() {
    report = null;
    if (host) host.querySelector("[data-results]").replaceChildren();
  }
  function inlineRange(period) {
    const days = ({ "7d": 7, "30d": 30, "90d": 90 })[period] || 30;
    const until = new Date(), since = new Date(until);
    since.setDate(since.getDate() - days + 1);
    return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
  }
  async function renderInline(id, period = "30d", sync = false) {
    const target = document.getElementById(id);
    if (!target || !/^[-a-z0-9_]{1,80}$/i.test(id)) return;
    const business = tenant(), generation = ++inlineSerial;
    const periodButtons = ["7d", "30d", "90d"].map((p) =>
      `<button type="button" class="tkm-inline-period ${p === period ? "selected" : ""}" onclick="TK_MARKETING.renderInline('${id}','${p}')">${p}</button>`).join("");
    target.innerHTML = `<section class="tkm-inline"><header><div><h4>Meta ads · ${period} days</h4><p data-inline-status role="status">${sync ? "Refreshing from Meta…" : "Loading saved Meta data…"}</p></div><div class="tkm-inline-actions">${periodButtons}<button type="button" onclick="TK_MARKETING.refreshInline('${id}','${period}')">Refresh from Meta</button><button type="button" onclick="TK_MARKETING.open()">Campaign report</button></div></header><div data-inline-content></div></section>`;
    const update = (html, status) => {
      if (generation !== inlineSerial || !target.isConnected || business !== tenant()) return;
      target.querySelector("[data-inline-content]").innerHTML = html;
      target.querySelector("[data-inline-status]").textContent = status;
    };
    try {
      const connection = await request("/connection");
      if (!connection.configured) {
        update(`<p class="tkm-inline-empty">Use your saved Meta token to connect the ad account. TurnKey keeps the token on its backend and can find your account automatically.</p><button type="button" onclick="TK_MARKETING.connectSavedToken('${id}')">Connect using my Meta token</button>`, "Meta ads aren’t connected yet.");
        return;
      }
      const range = inlineRange(period);
      if (sync) await request("/sync", { method: "POST", body: JSON.stringify(range) });
      const data = await request("/report?" + new URLSearchParams({ ...range, level: "campaign", limit: "500", view: "entities" }));
      if (generation !== inlineSerial || !target.isConnected || business !== tenant()) return;
      const value = (v, decimals = 2) => v == null ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: decimals });
      const currency = data.account.currency, cash = (v) => v == null ? "—" : `${currency} ${value(v)}`;
      const metrics = [
        ["Spend", cash(data.totals?.spend)], ["Impressions", value(data.totals?.impressions, 0)],
        ["Reach¹", value(data.totals?.reach, 0)], ["All clicks", value(data.totals?.clicks, 0)],
        ["Link clicks", value(data.totals?.link_clicks, 0)], ["Meta leads²", value(data.totals?.leads, 0)],
        ["CTR", data.totals?.ctr == null ? "—" : `${value(data.totals.ctr)}%`],
        ["CPC", cash(data.totals?.cpc)], ["CPM", cash(data.totals?.cpm)],
        ["Frequency¹", value(data.totals?.frequency)], ["Cost per lead²", cash(data.totals?.cpl)],
      ];
      const summary = `<div class="tkm-inline-grid">${metrics.map(([label, v]) => `<article><span>${label}</span><strong>${v}</strong></article>`).join("")}</div><p class="tkm-inline-foot">${data.coverage.complete ? `Complete daily coverage · ${data.coverage.days} days` : `Incomplete coverage · ${data.coverage.days}/${data.coverage.expectedDays} days; totals are withheld until coverage is complete`} · ${currency} · ${esc(data.account.timezone)} · Oldest daily refresh ${esc(data.coverage.oldestRefresh || "not yet synced")}</p><p class="tkm-inline-foot">¹ Reach and frequency are not additive across days. ² Meta lead actions can differ from TurnKey CRM lead matches. Won quote value and ad-level breakdown are in the campaign report.</p>`;
      update(summary, `Meta ad account ${connection.accountId} · ${period} · saved report`);
    } catch (e) {
      update(`<p class="tkm-inline-empty" role="alert">${esc(e.message || "Meta metrics couldn’t be loaded.")}</p><button type="button" onclick="openMetaAdsAnalytics()">Open Meta reporting setup</button>`, "Meta data could not be loaded.");
    }
  }
  async function connectSavedToken(id, accountId = "") {
    if (!/^[-a-z0-9_]{1,80}$/i.test(id)) return;
    const target = document.getElementById(id);
    if (!target) return;
    const content = target.querySelector("[data-inline-content]");
    if (content) content.innerHTML = "<p>Connecting your saved Meta token…</p>";
    try {
      const result = await request("/connection", {
        method: "POST",
        body: JSON.stringify({ useConnectedLeadToken: true, ...(accountId ? { accountId } : {}) }),
      });
      if (result.requiresSelection) {
        const selectId = `${id}-meta-account`;
        target.querySelector("[data-inline-content]").innerHTML = `<p>Your token can access more than one ad account. Pick the one for this TurnKey business:</p><label class="tkm-inline-select">Ad account<select id="${selectId}">${result.accounts.map((a) => `<option value="${esc(a.accountId)}">${esc(a.name)} · ${esc(a.accountId)} · ${esc(a.currency)}</option>`).join("")}</select></label><button type="button" onclick="TK_MARKETING.connectSavedToken('${id}',document.getElementById('${selectId}').value)">Connect selected account</button>`;
        target.querySelector("[data-inline-status]").textContent = "Choose the correct Meta ad account.";
        return;
      }
      await renderInline(id, "30d", true);
    } catch (e) {
      const current = document.getElementById(id);
      if (current) {
        current.querySelector("[data-inline-content]").innerHTML = `<p class="tkm-inline-empty" role="alert">${esc(e.message || "Meta couldn’t connect.")}</p><button type="button" onclick="TK_MARKETING.open()">Open Meta reporting setup</button>`;
        current.querySelector("[data-inline-status]").textContent = "Meta connection needs attention.";
      }
    }
  }
  async function refreshInline(id, period = "30d") { return renderInline(id, period, true); }
  function close() {
    ++serial;
    clearInterval(tenantTimer);
    tenantTimer = null;
    host?.remove();
    host = null;
    report = null;
    busy = false;
    returnFocus?.focus();
  }
  function render(data) {
    const rootEl = host.querySelector("[data-results]"),
      c = data.coverage,
      currency = data.account.currency;
    const totals = data.totals;
    const cols = [
      ["spend", "Spend"],
      ["impressions", "Impressions"],
      ["reach", "Reach¹"],
      ["clicks", "All clicks"],
      ["link_clicks", "Link clicks"],
      ["leads", "Meta leads²"],
      ["ctr", "CTR %"],
      ["cpc", "CPC"],
      ["cpm", "CPM"],
      ["frequency", "Frequency¹"],
      ["cpl", "CPL²"],
    ];
    rootEl.innerHTML = `<p class="tkm-coverage ${c.complete ? "" : "tkm-warning"}">${c.complete ? "Saved coverage" : "Incomplete coverage — totals unavailable"}: ${c.days}/${c.expectedDays} days · ${esc(currency)} · ${esc(data.account.timezone)} · ${esc(c.sources.join(" / ") || "No saved data")}<br>Oldest daily refresh: ${esc(c.oldestRefresh || "Never")}. Saved data may lag Meta; refresh the selected dates to include revisions.</p>
      <div class="tkm-cards">${["spend", "impressions", "clicks", "leads", "cpl"].map((k) => `<article><span>${esc(cols.find((x) => x[0] === k)[1])}</span><strong>${fmt(totals?.[k])}</strong></article>`).join("")}</div>
      <div class="tkm-scroll"><table><caption>${state.view === "daily" ? "Daily entity metrics" : "Entity totals for selected dates"} · ${esc(currency)}. Dashes mean unavailable.</caption><thead><tr><th scope="col">${state.view === "daily" ? "Date / entity" : "Entity"}</th>${cols.map((x) => `<th scope="col">${x[1]}</th>`).join("")}</tr></thead><tbody>${data.entities.map((r) => `<tr><th scope="row">${esc(r.date ? r.date + " / " : "")}${esc(r.name || r.id)}<small>${esc(r.id)}</small></th>${cols.map(([k]) => `<td>${fmt(r[k])}</td>`).join("")}</tr>`).join("") || '<tr><td colspan="12">No saved delivery rows in this selection. Sync or import a CSV to establish coverage.</td></tr>'}</tbody></table></div>
      <div class="tkm-pages"><button data-action="previous" ${data.page === 0 ? "disabled" : ""}>Previous</button><span>Page ${data.page + 1} · ${data.total} rows</span><button data-action="next" ${(data.page + 1) * data.limit >= data.total ? "disabled" : ""}>Next</button></div>
      <section class="tkm-attribution"><h3>Ad leads → sales</h3><p>${data.attribution.linkedLeads} opportunities matched to an exact ad ID · ${data.attribution.unknownLeads} without an ad ID, out of ${data.attribution.cohortLeads} received in this period.</p><p>${esc(data.attribution.basis)}</p><ul>${data.attribution.byAd.map((a) => `<li>Ad ${esc(a.adId)}: ${a.leads} leads (${a.metaLeadMatches} matched from Meta, ${a.manualLinks} manually linked) → ${a.won} currently won · saved quote value ${esc(data.account.currency)} ${fmt(a.wonQuotedValue)}</li>`).join("") || "<li>No leads with exact ad IDs yet. Meta lead records will be matched automatically when that ID is present.</li>"}</ul></section>
      <ul class="tkm-notes">${data.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  }
  async function load() {
    const generation = ++serial,
      business = tenant();
    clearReport();
    message("Loading saved report…");
    try {
      const data = await request("/report" + query());
      if (generation !== serial || !host || business !== tenant()) return;
      report = data;
      render(data);
      message("Saved report loaded.");
    } catch (e) {
      if (generation === serial && host) message(e.message, true);
    }
  }
  async function act(action) {
    if (busy) return;
    if (action === "close") return close();
    if (action === "refresh") {
      state.page = 0;
      return load();
    }
    if (action === "previous" || action === "next") {
      state.page += action === "next" ? 1 : -1;
      return load();
    }
    busy = true;
    const generation = serial,
      business = tenant();
    const controls = [...host.querySelectorAll("button,input,select")];
    const disabled = controls.map((e) => e.disabled);
    controls.forEach((e) => (e.disabled = true));
    try {
      message("Working…");
      if (action === "connect") {
        const form = host.querySelector("[data-connection]"),
          token = form.elements.token.value;
        const body = {
          accountId: form.elements.accountId.value.trim(),
          currency: form.elements.currency.value.trim().toUpperCase(),
          timezone: form.elements.timezone.value.trim(),
        };
        if (token) body.token = token;
        form.elements.token.value = "";
        await request("/connection", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } else if (action === "connect-lead-token") {
        const form = host.querySelector("[data-connection]");
        await request("/connection", {
          method: "POST",
          body: JSON.stringify({
            accountId: form.elements.accountId.value.trim(),
            useConnectedLeadToken: true,
          }),
        });
      } else if (action === "disconnect")
        await request("/connection", { method: "DELETE" });
      else if (action === "sync")
        await request("/sync", {
          method: "POST",
          body: JSON.stringify({ since: state.since, until: state.until }),
        });
      else if (action === "import") {
        const file = host.querySelector("[data-file]").files[0];
        if (!file) throw Error("Choose a TurnKey-format CSV first.");
        if (file.size > 4 * 1024 * 1024) throw Error("CSV limit is 4 MB.");
        await request("/import", {
          method: "POST",
          body: JSON.stringify({
            csv: await file.text(),
            since: state.since,
            until: state.until,
            level: state.level,
          }),
        });
      } else if (action === "template" || action === "export") {
        const text = await request(
          action === "template" ? "/template" : "/export" + query(),
          {},
          true,
        );
        if (generation === serial && business === tenant() && host)
          download(
            text,
            action === "template"
              ? "turnkey-marketing-template.csv"
              : "turnkey-marketing.csv",
          );
        return;
      } else if (action === "link" || action === "unlink") {
        const f = host.querySelector("[data-attribution]");
        await request(
          action === "link"
            ? "/attribution"
            : "/attribution/" +
                encodeURIComponent(f.elements.jobId.value.trim()),
          {
            method: action === "link" ? "POST" : "DELETE",
            ...(action === "link"
              ? {
                  body: JSON.stringify({
                    jobId: f.elements.jobId.value.trim(),
                    adId: f.elements.adId.value.trim(),
                    evidence: f.elements.evidence.value.trim(),
                  }),
                }
              : {}),
          },
        );
      }
      if (generation === serial && host && business === tenant()) {
        message("Saved.");
        await status();
        await load();
      }
    } catch (e) {
      if (generation === serial && host && business === tenant())
        message(e.message, true);
    } finally {
      busy = false;
      controls.forEach((e, i) => {
        if (e.isConnected) e.disabled = disabled[i];
      });
    }
  }
  async function status() {
    const business = tenant(),
      generation = serial;
    const c = await request("/connection");
    if (!host || generation !== serial || business !== tenant()) return;
    host.querySelector("[data-status]").textContent = c.configured
      ? `${c.connected ? "Meta token connected" : "CSV mode"} · account ${c.accountId} · ${c.currency} · ${c.timezone}`
      : "No Ads reporting account configured.";
    if (c.configured) {
      const f = host.querySelector("[data-connection]");
      f.elements.accountId.value = c.accountId;
      f.elements.currency.value = c.currency;
      f.elements.timezone.value = c.timezone;
    }
  }
  function open() {
    if (host) {
      host.querySelector("[data-close]").focus();
      return;
    }
    returnFocus = document.activeElement;
    host = document.createElement("div");
    host.className = "tkm-overlay";
    host.innerHTML = `<section class="tkm-panel" role="dialog" aria-modal="true" aria-labelledby="tkm-title"><header><div><span>ANALYTICS / MARKETING REPORT</span><h2 id="tkm-title">Marketing performance</h2><p data-status>Checking reporting account…</p></div><button data-close data-action="close" aria-label="Close marketing report">Close</button></header>
      <div class="tkm-filters"><label>From<input data-filter="since" type="date" value="${state.since}"></label><label>Through<input data-filter="until" type="date" value="${state.until}"></label><label>Level<select data-filter="level"><option value="campaign">Campaigns</option><option value="adset">Ad sets</option><option value="ad">Ads</option></select></label><label>View<select data-filter="view"><option value="entities">Entity totals</option><option value="daily">Daily metrics</option></select></label><button data-action="refresh">Load saved</button><button data-action="sync">Sync Meta daily metrics</button><button data-action="export">Export daily CSV</button></div>
      <p data-message role="status" aria-live="polite"></p><div data-results></div>
      <details><summary>Reporting connection &amp; CSV fallback</summary><p>Owners and managers only. Add <code>ads_read</code> to the same no-expiry System User token used for Meta lead retrieval. Enter the ad account ID, then let TurnKey reuse its saved token, or enter a separate reporting token. Reports are read-only; TurnKey will not create or change ads. A CSV account needs currency and account timezone; Meta verifies these when a token is supplied.</p><form data-connection><label>Numeric ad account ID<input name="accountId" inputmode="numeric" autocomplete="off"></label><label>Optional reporting token<input name="token" type="password" autocomplete="new-password"></label><label>Currency<input name="currency" placeholder="NZD" maxlength="3"></label><label>Account timezone<input name="timezone" placeholder="Pacific/Auckland"></label><button type="button" data-action="connect-lead-token">Use connected Meta token</button><button type="button" data-action="connect">Save account / separate token</button><button type="button" data-action="disconnect">Remove reporting token</button></form><p>Import replaces every saved entity-day for the selected level and inclusive dates, including days omitted from the CSV. Export a backup first. Use daily rows with impression reporting time and 7-day click + 1-day view attribution. Blank metrics stay unknown. Different currencies/accounts cannot be mixed.</p><input data-file type="file" accept=".csv,text/csv" aria-label="Daily metrics CSV"><button data-action="template">Download CSV template</button><button data-action="import">Import &amp; replace selection</button></details>
      <details><summary>Review a CRM opportunity’s ad attribution</summary><p>Only link when you have evidence of an exact ad ID. These links are labelled manual; they are not inferred from campaign names, source labels or Meta totals.</p><form data-attribution><label>CRM job UUID<input name="jobId"></label><label>Meta ad ID<input name="adId" inputmode="numeric"></label><label>Evidence<textarea name="evidence" maxlength="1000" placeholder="Where the exact ad ID was recorded"></textarea></label><button type="button" data-action="link">Save reviewed link</button><button type="button" data-action="unlink">Remove job’s link</button></form></details></section>`;
    document.body.append(host);
    const openedBusiness = tenant();
    tenantTimer = setInterval(() => {
      if (tenant() !== openedBusiness) close();
    }, 250);
    host.querySelector('[data-filter="level"]').value = state.level;
    host.querySelector('[data-filter="view"]').value = state.view;
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-action]");
      if (b) act(b.dataset.action);
    });
    host.addEventListener("submit", (e) => e.preventDefault());
    host.addEventListener("change", (e) => {
      if (e.target.dataset.filter) {
        state[e.target.dataset.filter] = e.target.value;
        state.page = 0;
        load();
      }
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const focus = [
          ...host.querySelectorAll("button,input,select,textarea,summary"),
        ].filter((el) => !el.disabled && el.getClientRects().length);
        const first = focus[0],
          last = focus[focus.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    host.querySelector("[data-close]").focus();
    status()
      .then(() => {
        if (host) load();
      })
      .catch((e) => message(e.message, true));
  }
  root.TK_MARKETING = {
    open,
    close,
    renderInline,
    refreshInline,
    connectSavedToken,
    configure: (options) => {
      close();
      config = { ...options };
    },
  };
})(window);
