/* Read-only Meta reporting. No dependency on, or writes to, lead_sources/Page tokens. */
import crypto from "node:crypto";
import { DEFAULT_META_GRAPH_VERSION } from "./metaGraph.js";
const DAY = 86400000,
  MAX_ROWS = 10000;
const levels = ["campaign", "adset", "ad"];
const numeric = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "link_clicks",
  "leads",
];
export const CSV_COLUMNS = [
  "date",
  "level",
  "account_id",
  "currency",
  "timezone",
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  ...numeric,
];
const fail = (message, status = 400) =>
  Object.assign(new Error(message), { publicMessage: message, status });
const unwrap = async (q) => {
  const { data, error } = await q;
  if (error) throw error;
  return data;
};
const id = (v) => {
  if (typeof v !== "string" || !/^\d{1,30}$/.test(v))
    throw fail("Use numeric Meta IDs.");
  return v;
};
export function dateRange(since, until) {
  const valid = (v) =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if (
    !valid(since) ||
    !valid(until) ||
    since > until ||
    Date.parse(until) - Date.parse(since) > 365 * DAY
  )
    throw fail("Choose valid inclusive dates, at most 366 days.");
  return { since, until };
}
function dimensions(row) {
  if (!levels.includes(row.level)) throw fail("Choose campaign, adset or ad.");
  id(row.account_id);
  id(row.campaign_id);
  if (row.level !== "campaign") id(row.adset_id);
  if (row.level === "ad") id(row.ad_id);
  if (
    (row.level === "campaign" && (row.adset_id || row.ad_id)) ||
    (row.level === "adset" && row.ad_id)
  )
    throw fail("Higher-level rows must leave child entity IDs blank.");
  if (!/^[A-Z]{3}$/.test(row.currency || ""))
    throw fail("Use a three-letter account currency.");
  try {
    new Intl.DateTimeFormat("en", { timeZone: row.timezone }).format();
    if (!row.timezone) throw Error();
  } catch {
    throw fail("Use a valid account timezone.");
  }
}
export function normalizeRow(raw, context = {}) {
  const row = { ...raw, ...context };
  row.date = raw.date || raw.date_start;
  dateRange(row.date, row.date);
  if (raw.date_stop && raw.date_stop !== row.date)
    throw fail("Only daily rows can be imported.");
  dimensions(row);
  const out = Object.fromEntries(
    CSV_COLUMNS.filter((k) => !numeric.includes(k)).map((k) => [
      k,
      String(row[k] ?? ""),
    ]),
  );
  for (const k of numeric) {
    const v = row[k];
    if (v === null || v === undefined || v === "") {
      out[k] = null;
      continue;
    }
    if (
      !/^\d+(\.\d+)?$/.test(String(v)) ||
      !Number.isFinite(Number(v)) ||
      Number(v) > 1e15 ||
      (!["spend", "leads"].includes(k) && !Number.isSafeInteger(Number(v)))
    )
      throw fail(
        "Metrics must be non-negative numbers (whole numbers for delivery counts).",
      );
    out[k] = Number(v);
  }
  for (const k of ["campaign_name", "adset_name", "ad_name"])
    if (out[k].length > 500)
      throw fail("Names must be shorter than 501 characters.");
  return out;
}
export function metaRow(raw, context) {
  if (
    String(raw.account_id) !== context.account_id ||
    raw.account_currency !== context.currency
  )
    throw fail("Meta returned a different account or currency.", 502);
  // The aggregate lead action overlaps its subtypes. Never add them together.
  const lead = Array.isArray(raw.actions)
    ? raw.actions.find((a) => a.action_type === "lead")
    : null;
  return normalizeRow(
    { ...raw, link_clicks: raw.inline_link_clicks, leads: lead?.value ?? null },
    context,
  );
}
export function derive(rows) {
  const sums = Object.fromEntries(
    numeric.map((k) => [
      k,
      rows.length && rows.every((r) => r[k] != null)
        ? rows.reduce((s, r) => s + r[k], 0)
        : null,
    ]),
  );
  // Reach is unique people: summation across entities/dates is invalid.
  sums.reach = rows.length === 1 ? rows[0].reach : null;
  const ratio = (a, b, m = 1) => (a != null && b > 0 ? (a / b) * m : null);
  return {
    ...sums,
    ctr: ratio(sums.clicks, sums.impressions, 100),
    cpc: ratio(sums.spend, sums.clicks),
    cpm: ratio(sums.spend, sums.impressions, 1000),
    frequency: ratio(sums.impressions, sums.reach),
    cpl: ratio(sums.spend, sums.leads),
  };
}
// RFC4180 parser; reject ambiguous headers, unclosed quotes and oversized files.
export function parseCSV(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw fail("CSV limit is 4 MB.");
  text = text.replace(/^\uFEFF/, "");
  const records = [];
  let record = [],
    value = "",
    quoted = false,
    closed = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw fail("Unclosed CSV quote.");
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"') {
      if (value || closed) throw fail("Invalid CSV quote.");
      quoted = true;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r" || c === undefined) {
      record.push(value);
      value = "";
      closed = false;
      if (c !== ",") {
        if (record.some((v) => v !== "")) records.push(record);
        record = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (closed) throw fail("Unexpected text after CSV quote.");
      value += c;
    }
    if (records.length > MAX_ROWS + 1) throw fail("CSV limit is 10,000 rows.");
  }
  const header = records.shift();
  if (
    !header ||
    new Set(header).size !== header.length ||
    CSV_COLUMNS.some((k) => !header.includes(k)) ||
    header.some((k) => !CSV_COLUMNS.includes(k))
  )
    throw fail("Use the TurnKey CSV template headers.");
  if (!records.length) throw fail("CSV contains no daily rows.");
  const rows = records.map((r) => {
    if (r.length !== header.length)
      throw fail("CSV column count differs from its header.");
    return normalizeRow(Object.fromEntries(header.map((k, i) => [k, r[i]])));
  });
  uniqueRows(rows);
  return rows;
}
function uniqueRows(rows) {
  const keys = new Set();
  for (const r of rows) {
    const key = [r.date, r.level, r[r.level + "_id"]].join(":");
    if (keys.has(key)) throw fail("Duplicate daily entity row.");
    keys.add(key);
  }
}
export function exportCSV(rows) {
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+\-@\t\r]/, "'$&")
      .replace(/"/g, '""') +
    '"';
  return (
    CSV_COLUMNS.join(",") +
    "\r\n" +
    rows.map((r) => CSV_COLUMNS.map((k) => cell(r[k])).join(",")).join("\r\n")
  );
}
export function reportingKey(env) {
  if (env.MARKETING_TOKEN_KEY) {
    if (!/^[a-f\d]{64}$/i.test(env.MARKETING_TOKEN_KEY)) throw fail("MARKETING_TOKEN_KEY must contain 64 hex characters.",503);
    return env.MARKETING_TOKEN_KEY;
  }
  if (!env.EMAIL_TOKEN_KEY) throw fail("Configure a server-side reporting encryption key.",503);
  return crypto.createHash("sha256").update("turnkey:marketing:v1\0").update(env.EMAIL_TOKEN_KEY).digest("hex");
}
export function seal(token, business, account, key) {
  if (!/^[a-f\d]{64}$/i.test(key || ""))
    throw fail(
      "Configure MARKETING_TOKEN_KEY as 64 hex characters on the backend.",
      503,
    );
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  c.setAAD(Buffer.from(JSON.stringify([business, account])));
  const encrypted = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), encrypted]).toString("base64");
}
export function unseal(value, business, account, key) {
  if (!/^[a-f\d]{64}$/i.test(key || ""))
    throw fail("Reporting encryption key is unavailable.", 503);
  const b = Buffer.from(value, "base64"),
    c = crypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      b.subarray(0, 12),
    );
  c.setAAD(Buffer.from(JSON.stringify([business, account])));
  c.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([c.update(b.subarray(28)), c.final()]).toString("utf8");
}
export async function graphPages(
  path,
  params,
  {
    token,
    fetchImpl = fetch,
    env = process.env,
    deadline = Date.now() + 90000,
  },
) {
  const version = env.META_GRAPH_VERSION || DEFAULT_META_GRAPH_VERSION;
  if (!/^v[1-9]\d*\.0$/.test(version))
    throw fail("Invalid META_GRAPH_VERSION.", 503);
  const base = new URL(`https://graph.facebook.com/${version}/${path}`);
  for (const [k, v] of Object.entries(params))
    base.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  base.searchParams.set("limit", "500");
  const rows = [],
    seen = new Set();
  for (let page = 0; page < 100; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw fail(
        "Meta sync time limit reached. Saved reports are unchanged; use a shorter range.",
        504,
      );
    let response, body;
    try {
      response = await fetchImpl(base, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(20000, remaining)),
      });
      body = await response.json();
    } catch {
      throw fail(
        "Meta is unavailable or timed out. Saved reports are unchanged.",
        502,
      );
    }
    if (!response.ok || body.error)
      throw fail(
        response.status === 429 ||
          body.error?.code === 4 ||
          body.error?.code === 17
          ? "Meta rate limit reached. Retry later; saved reports are unchanged."
          : "Meta denied the reporting request. Check ads_read, account access and token expiry.",
        response.status === 429 ? 429 : 502,
      );
    if (!Array.isArray(body.data)) {
      if (page === 0 && body.id) return [body];
      throw fail("Invalid Meta response.", 502);
    }
    rows.push(...body.data);
    if (rows.length > MAX_ROWS)
      throw fail("Report exceeds 10,000 rows. Sync a shorter date range.", 413);
    if (!body.paging?.next) return rows;
    // Never follow a provider URL: it may include access_token or an untrusted host.
    const after = body.paging?.cursors?.after;
    if (typeof after !== "string" || after.length > 4096 || seen.has(after))
      throw fail(
        "Meta pagination did not complete. Saved reports are unchanged.",
        502,
      );
    seen.add(after);
    base.searchParams.set("after", after);
  }
  throw fail("Too many Meta pages. Sync a shorter date range.", 413);
}
export async function paged(
  db,
  table,
  business,
  columns = "*",
  filter = (q) => q,
  { pageSize = 500, onPage = () => {} } = {},
) {
  const rows = [];
  for (let offset = 0; offset <= 50000; offset += pageSize) {
    const page = await unwrap(
      filter(db.from(table).select(columns).eq("business_id", business))
        .order("id")
        .range(offset, offset + pageSize - 1),
    );
    if (!Array.isArray(page)) throw fail("Invalid stored report.", 503);
    onPage(page);
    rows.push(...page);
    if (rows.length > 50000)
      throw fail(
        "Too many records to report safely. Narrow the date range.",
        413,
      );
    if (page.length < pageSize) return rows;
  }
}
export function attribution(jobs, links, since, until, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const day = (v) => {
    if (!v) return null;
    const t = typeof v === "number" ? v : Date.parse(v);
    if (!Number.isFinite(t) || !Number.isFinite(new Date(t).getTime()))
      return null;
    const p = Object.fromEntries(
      fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day}`;
  };
  const cohort = jobs.filter((j) => {
    const d = [
      j.details?.requestSubmittedAt,
      j.details?.createdAt,
      j.created_at,
    ]
      .map(day)
      .find(Boolean);
    return d && d >= since && d <= until;
  });
  const mapped = new Map(links.map((l) => [l.job_id, l])),
    groups = new Map();
  let unknown = 0;
  for (const j of cohort) {
    const l = mapped.get(j.id);
    if (!l) {
      unknown++;
      continue;
    }
    const key = l.ad_id;
    const g = groups.get(key) || {
      adId: key,
      leads: 0,
      won: 0,
      manualLinks: 0,
    };
    g.leads++;
    g.manualLinks++;
    if (["won", "scheduled", "completed", "paid"].includes(j.status)) g.won++;
    groups.set(key, g);
  }
  return {
    cohortLeads: cohort.length,
    linkedLeads: cohort.length - unknown,
    unknownLeads: unknown,
    byAd: [...groups.values()],
    basis:
      "CRM opportunities arriving in selected account-local dates; current won stages; explicit owner/manager-reviewed links only. No name/source guessing. Meta lead totals are separate.",
  };
}
export function installMarketingRoutes(
  app,
  { db, requireBusiness, env = process.env, fetchImpl = fetch },
) {
  const wrap = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await fn(req, res);
    } catch (e) {
      res.status(e.status || 503).json({
        error:
          e.publicMessage ||
          "Marketing reporting failed. Saved data has not been replaced; retry or check the migration.",
      });
    }
  };
  const role = async (req, res, next) => {
    try {
      const u = await unwrap(
        db
          .from("users")
          .select("role")
          .eq("id", req.userId)
          .eq("business_id", req.businessId)
          .maybeSingle(),
      );
      if (!u || !["owner", "manager"].includes(u.role))
        return res
          .status(403)
          .json({ error: "Marketing reports require an owner or manager." });
      next();
    } catch {
      res
        .status(503)
        .json({ error: "Could not verify reporting permissions." });
    }
  };
  const route = (method, path, fn) =>
    app[method]("/api/marketing" + path, requireBusiness, role, wrap(fn));
  const connection = (b) =>
    unwrap(
      db
        .from("marketing_ad_connections")
        .select("*")
        .eq("business_id", b)
        .maybeSingle(),
    );
  const need = async (b) => {
    const c = await connection(b);
    if (!c) throw fail("Configure an Ads reporting account first.", 409);
    return c;
  };
  const safe = (c) =>
    c
      ? {
          configured: true,
          connected: !!c.token_enc,
          accountId: c.account_id,
          name: c.account_name,
          currency: c.currency,
          timezone: c.timezone,
          lastSyncAt: c.last_sync_at,
          lastImportAt: c.last_import_at,
        }
      : { configured: false, connected: false };
  const opts = (token) => ({ token, fetchImpl, env });
  const locks = new Set();
  const locked = async (b, fn) => {
    if (locks.has(b))
      throw fail("A reporting update is in progress. Retry shortly.", 409);
    locks.add(b);
    try {
      return await fn();
    } finally {
      locks.delete(b);
    }
  };
  route("get", "/connection", async (req, res) =>
    res.json(safe(await connection(req.businessId))),
  );
  route("post", "/connection", async (req, res) =>
    locked(req.businessId, async () => {
      const account = id(req.body.accountId),
        token = req.body.token;
      if (
        token != null &&
        (typeof token !== "string" ||
          token.length < 16 ||
          token.length > 4096 ||
          /[\r\n]/.test(token))
      )
        throw fail("Enter a valid reporting access token.");
      let name = "",
        currency = req.body.currency,
        timezone = req.body.timezone;
      if (token) {
        const permissions = await graphPages("me/permissions", {}, opts(token));
        if (
          !permissions.some(
            (p) => p.permission === "ads_read" && p.status === "granted",
          )
        )
          throw fail("The reporting token must have ads_read permission.", 403);
        const [a] = await graphPages(
          "act_" + account,
          { fields: "id,account_id,name,currency,timezone_name" },
          opts(token),
        );
        if (String(a?.account_id) !== account)
          throw fail("Meta account identity could not be verified.", 502);
        name = String(a.name || "").slice(0, 500);
        currency = a.currency;
        timezone = a.timezone_name;
      }
      dimensions({
        level: "campaign",
        account_id: account,
        campaign_id: "0",
        currency,
        timezone,
      });
      const prior = await connection(req.businessId);
      if (
        prior &&
        (prior.account_id !== account ||
          prior.currency !== currency ||
          prior.timezone !== timezone)
      )
        throw fail(
          "This business already has a different reporting account/currency/timezone. A deliberate data migration is required.",
          409,
        );
      const row = {
        business_id: req.businessId,
        account_id: account,
        account_name: name || prior?.account_name || "CSV account",
        currency,
        timezone,
        generation: crypto.randomUUID(),
        token_enc: token
          ? seal(token, req.businessId, account, reportingKey(env))
          : prior?.token_enc || null,
      };
      if (prior) {
        const changed = await unwrap(
          db
            .from("marketing_ad_connections")
            .update(row)
            .eq("business_id", req.businessId)
            .eq("generation", prior.generation)
            .select("business_id"),
        );
        if (!changed?.length)
          throw fail("Reporting connection changed. Retry.", 409);
      } else await unwrap(db.from("marketing_ad_connections").insert(row));
      res.json(safe(row));
    }),
  );
  route("delete", "/connection", async (req, res) =>
    locked(req.businessId, async () => {
      await unwrap(
        db
          .from("marketing_ad_connections")
          .update({ token_enc: null, generation: crypto.randomUUID() })
          .eq("business_id", req.businessId),
      );
      res.json({ ok: true });
    }),
  );
  async function publish(req, c, range, selected, rows, source) {
    uniqueRows(rows);
    await unwrap(
      db.rpc("marketing_publish", {
        p_business: req.businessId,
        p_generation: c.generation,
        p_revision: c.revision,
        p_since: range.since,
        p_until: range.until,
        p_levels: selected,
        p_rows: rows,
        p_source: source,
      }),
    );
  }
  route("post", "/sync", async (req, res) =>
    locked(req.businessId, async () => {
      const range = dateRange(req.body.since, req.body.until),
        c = await need(req.businessId);
      if (!c.token_enc)
        throw fail("Connect an ads_read reporting token or import CSV.", 409);
      const token = unseal(
          c.token_enc,
          req.businessId,
          c.account_id,
          reportingKey(env),
        ),
        rows = [];
      const deadline = Date.now() + 90000;
      for (const level of levels) {
        const fields = [
          "account_id",
          "account_currency",
          "date_start",
          "date_stop",
          "campaign_id",
          "campaign_name",
          "spend",
          "impressions",
          "reach",
          "clicks",
          "inline_link_clicks",
          "actions",
        ];
        if (level !== "campaign") fields.push("adset_id", "adset_name");
        if (level === "ad") fields.push("ad_id", "ad_name");
        const raw = await graphPages(
          "act_" + c.account_id + "/insights",
          {
            fields: fields.join(","),
            level,
            time_range: range,
            time_increment: 1,
            action_report_time: "impression",
            action_attribution_windows: ["7d_click", "1d_view"],
          },
          { ...opts(token), deadline },
        );
        rows.push(
          ...raw.map((r) =>
            metaRow(r, {
              level,
              account_id: c.account_id,
              currency: c.currency,
              timezone: c.timezone,
            }),
          ),
        );
        if (rows.length > MAX_ROWS)
          throw fail(
            "Sync limit is 10,000 rows. Use a shorter date range.",
            413,
          );
      }
      await publish(req, c, range, levels, rows, "meta");
      res.json({ ok: true, rows: rows.length, range });
    }),
  );
  route("post", "/import", async (req, res) =>
    locked(req.businessId, async () => {
      const rows = parseCSV(req.body.csv),
        c = await need(req.businessId),
        range = dateRange(req.body.since, req.body.until),
        selected = [req.body.level];
      if (!levels.includes(selected[0]))
        throw fail("Choose the CSV reporting level.");
      for (const r of rows)
        if (
          r.account_id !== c.account_id ||
          r.currency !== c.currency ||
          r.timezone !== c.timezone ||
          r.level !== selected[0] ||
          r.date < range.since ||
          r.date > range.until
        )
          throw fail(
            "Every CSV row must match the configured account, currency, timezone, selected level and replacement dates.",
          );
      await publish(req, c, range, selected, rows, "csv");
      res.json({ ok: true, rows: rows.length });
    }),
  );
  async function stored(req) {
    const range = dateRange(req.query.since, req.query.until),
      level = req.query.level || "campaign";
    if (!levels.includes(level)) throw fail("Invalid report level.");
    const c = await need(req.businessId);
    let rowCount = 0;
    const days = await paged(
      db,
      "marketing_daily_snapshots",
      req.businessId,
      "*",
      (q) =>
        q
          .eq("account_id", c.account_id)
          .eq("level", level)
          .gte("date", range.since)
          .lte("date", range.until),
      {
        pageSize: 5,
        onPage: (page) => {
          for (const d of page) {
            if (!Array.isArray(d.rows))
              throw fail("Invalid saved daily snapshot.", 503);
            rowCount += d.rows.length;
          }
          if (rowCount > 50000)
            throw fail("Report is too large. Choose a shorter range.", 413);
        },
      },
    );
    const rows = days
      .sort((a, b) => a.date.localeCompare(b.date))
      .flatMap((d) => d.rows);
    const current = await need(req.businessId);
    if (current.generation !== c.generation || current.revision !== c.revision)
      throw fail(
        "Saved reporting data changed while loading. Refresh the report.",
        409,
      );
    return { range, level, c, days, rows };
  }
  route("get", "/report", async (req, res) => {
    const { range, level, c, days, rows } = await stored(req);
    const page = Number(req.query.page ?? 0),
      limit = Number(req.query.limit ?? 100);
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page > 50000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw fail("Invalid report pagination.");
    const [jobs, links] = await Promise.all([
      paged(db, "jobs", req.businessId, "id,status,details,created_at"),
      paged(db, "marketing_attribution_links", req.businessId, "*", (q) =>
        q.eq("account_id", c.account_id),
      ),
    ]);
    const groups = new Map();
    for (const r of rows) {
      const key = r[level + "_id"];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const entities = (
      req.query.view === "daily"
        ? rows.map((r) => ({
            id: r[level + "_id"],
            date: r.date,
            name: r[level + "_name"],
            ...derive([r]),
          }))
        : [...groups].map(([entityId, rs]) => ({
            id: entityId,
            name: rs[rs.length - 1][level + "_name"],
            ...derive(rs),
          }))
    ).sort(
      (a, b) =>
        (a.date || "").localeCompare(b.date || "") ||
        String(a.id).localeCompare(String(b.id)),
    );
    const expected =
        (Date.parse(range.until) - Date.parse(range.since)) / DAY + 1,
      complete = days.length === expected;
    res.json({
      range,
      level,
      account: safe(c),
      coverage: {
        complete,
        days: days.length,
        expectedDays: expected,
        oldestRefresh: days.length
          ? days.map((d) => d.updated_at).sort()[0]
          : null,
        sources: [...new Set(days.map((d) => d.source))],
      },
      totals: complete ? derive(rows) : null,
      entities: entities.slice(page * limit, (page + 1) * limit),
      page,
      limit,
      total: entities.length,
      attribution: attribution(
        jobs,
        links,
        range.since,
        range.until,
        c.timezone,
      ),
      notes: [
        "Reach/frequency are available only for a single entity-day; daily unique reach cannot be summed.",
        "CTR uses all clicks. CPC uses all clicks. CPL uses only the aggregate Meta lead action; missing actions stay unknown.",
        "Meta sync uses impression reporting time, 7-day click + 1-day view. CSV must use the same settings.",
        "CRM links are manually reviewed evidence, not verified Meta conversion attribution. No revenue/ROAS is inferred.",
      ],
    });
  });
  route("get", "/export", async (req, res) => {
    const { rows } = await stored(req);
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        'attachment; filename="turnkey-marketing.csv"',
      )
      .send(exportCSV(rows));
  });
  route("get", "/template", async (req, res) =>
    res.type("text/csv").send(exportCSV([])),
  );
  route("post", "/attribution", async (req, res) => {
    const c = await need(req.businessId),
      jobId = req.body.jobId,
      adId = id(req.body.adId),
      evidence = req.body.evidence;
    if (
      typeof jobId !== "string" ||
      !/^[\da-f-]{36}$/i.test(jobId) ||
      typeof evidence !== "string" ||
      evidence.trim().length < 10 ||
      evidence.length > 1000
    )
      throw fail(
        "Provide a valid CRM job ID, ad ID and evidence (10–1,000 characters).",
      );
    const job = await unwrap(
      db
        .from("jobs")
        .select("id")
        .eq("id", jobId)
        .eq("business_id", req.businessId)
        .maybeSingle(),
    );
    if (!job) throw fail("CRM opportunity not found.", 404);
    await unwrap(
      db.from("marketing_attribution_links").upsert(
        {
          business_id: req.businessId,
          account_id: c.account_id,
          job_id: jobId,
          ad_id: adId,
          evidence: evidence.trim(),
          reviewed_by: req.userId,
          reviewed_at: new Date().toISOString(),
        },
        { onConflict: "business_id,account_id,job_id" },
      ),
    );
    res.json({ ok: true });
  });
  route("delete", "/attribution/:jobId", async (req, res) => {
    const c = await need(req.businessId);
    await unwrap(
      db
        .from("marketing_attribution_links")
        .delete()
        .eq("business_id", req.businessId)
        .eq("account_id", c.account_id)
        .eq("job_id", req.params.jobId),
    );
    res.json({ ok: true });
  });
  return {
    /* No scheduler or network calls on installation. Parent may schedule authenticated sync requests. */
  };
}
