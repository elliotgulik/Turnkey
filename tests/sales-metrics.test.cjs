const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  M = require("../sales-metrics.js");
const now = Date.UTC(2026, 9, 15, 12),
  at = now - 86400000,
  range = { start: at - 1, end: now + 1 };
const lead = { id: 1, createdAt: at, stage: "new", source: "Wix", total: 115 };
test("empty metrics are honest and not NaN", () => {
  const r = M.report([], { range, now });
  assert.equal(r.conversion, null);
  assert.equal(r.invoicedRevenue, null);
  assert.equal(r.estimatedProfit, null);
});
test("cohort conversion is separate from sales event revenue", () => {
  const r = M.report(
    [{ ...lead, createdAt: at - 864000000, wonAt: at, stage: "won" }],
    { range, now },
  );
  assert.equal(r.leads, 0);
  assert.equal(r.bookedSales, 115);
  assert.equal(r.conversion, null);
});
test("GST profit requires known historical cost and GST status", () => {
  const r = M.report(
    [
      {
        ...lead,
        stage: "won",
        wonAt: at,
        estimatedCost: 40,
        gstRegistered: true,
      },
    ],
    { range, now },
  );
  assert.ok(Math.abs(r.estimatedProfit - 60) < 1e-8);
  assert.ok(Math.abs(r.estimatedMargin - 0.6) < 1e-8);
});
test("legacy missing win dates never become invented revenue", () => {
  const r = M.report([{ ...lead, stage: "won" }], { range, now });
  assert.equal(r.bookedSales, 0);
  assert.equal(r.unknownWinDates, 1);
});
test("missing ad spend is unavailable rather than free", () => {
  const r = M.report([lead], { range, now });
  assert.equal(r.source[0].cpl, null);
});
test("forecast probabilities are bounded and not confirmed sales", () => {
  const r = M.report([lead], { range, now, probabilities: { new: 0.25 } });
  assert.equal(r.forecast, 28.75);
  assert.equal(r.bookedSales, 0);
});
test("CSV protects spreadsheet formula injection", () => {
  assert.match(M.csv([{ name: "=1+2" }]), /\'=1\+2/);
});
test("zero-denominator and previous period growth are unavailable", () => {
  assert.equal(M.comparison([lead], { range, now }).growth, null);
});

test("source and salesperson profit use saved ex-GST costs with coverage", () => {
 const r=M.report([{...lead,stage:'won',wonAt:at,estimatedCost:40,gstRegistered:true,salespersonName:'A'}],{range,now});
 assert.ok(Math.abs(r.salespeople[0].estimatedProfit-60)<1e-8);
 assert.ok(Math.abs(r.source[0].estimatedMargin-.6)<1e-8);
 assert.equal(r.salespeople[0].costCoverage,'1/1');
});
test("arbitrary source and service names cannot corrupt metric grouping", () => {
 const r=M.report([{...lead,source:'__proto__',stage:'won',wonAt:at,services:[{svc:'constructor',priceSnapshot:115}]}],{range,now});
 assert.equal(r.source[0].name,'__proto__');assert.equal(r.services[0].name,'constructor');
});
test("partially missing line snapshots remain unavailable regardless of record order", () => {
 const r=M.report([{...lead,stage:'won',wonAt:at,services:[{svc:'house'}]},{...lead,stage:'won',wonAt:at,services:[{svc:'house',priceSnapshot:115}]}],{range,now});
 assert.equal(r.services[0].revenue,null);
});

// The Completed UI group must continue contributing to won sales and revenue.
test("completed and paid jobs remain revenue wins", () => {
  const jobs = ['completed', 'paid'].map((stage, i) => ({
    ...lead, id: i + 1, stage, wonAt: at,
  }));
  assert.deepEqual(jobs.map(job => M.won(job)), [true, true]);
  const report = M.report(jobs, { range, now });
  assert.equal(report.bookedSales, 230);
  assert.equal(report.conversion, 1);
});

test("unknown totals do not dilute average sale as free jobs", () => {
  const r = M.report(
    [
      { ...lead, id: 1, stage: "won", wonAt: at, total: 200 },
      { ...lead, id: 2, stage: "won", wonAt: at, total: null },
    ],
    { range, now },
  );
  assert.equal(r.bookedSales, 200);
  assert.equal(r.averageSale, 200);
});

test("quoted value uses frozen line snapshots, not live ServiceM8 totals", () => {
  const r = M.report(
    [
      {
        ...lead,
        stage: "won",
        wonAt: at,
        quoteSentAt: at,
        total: 900,
        serviceM8Pricing: { total: 900 },
        estimatedCost: 200,
        gstRegistered: true,
        services: [
          { svc: "house", priceSnapshot: 500 },
          { svc: "drive", priceSnapshot: 75 },
        ],
      },
    ],
    { range, now },
  );
  assert.equal(r.quotedValue, 575);
  assert.equal(r.bookedSales, 900);
  assert.equal(r.estimatedProfit, null);
  assert.equal(r.costCoverage.known, 0);
});

test("zero ServiceM8 totals remain booked zeros and keep profit unavailable", () => {
  const r = M.report(
    [
      {
        ...lead,
        stage: "won",
        wonAt: at,
        total: 575,
        serviceM8Pricing: { total: 0 },
        estimatedCost: 200,
        gstRegistered: true,
      },
    ],
    { range, now },
  );
  assert.equal(r.bookedSales, 0);
  assert.equal(r.averageSale, 0);
  assert.equal(r.estimatedProfit, null);
});

test("cancelled never-won quotes count as lost; prior wins do not", () => {
  assert.equal(M.lost({ stage: "cancelled", total: 115 }), true);
  assert.equal(M.lost({ stage: "cancelled", wonAt: at, total: 115 }), false);
  assert.equal(M.lost({ stage: "lost", total: 115 }), true);
  const r = M.report(
    [
      {
        ...lead,
        id: 1,
        stage: "cancelled",
        quoteSentAt: at,
        total: 115,
        lostReason: "price",
      },
      {
        ...lead,
        id: 2,
        stage: "cancelled",
        wonAt: at - 1000,
        total: 200,
      },
    ],
    { range, now },
  );
  assert.equal(r.lostReasons.length, 1);
  assert.equal(r.lostReasons[0].leads, 1);
  assert.equal(r.bookedSales, 0);
  assert.equal(r.conversion, 0);
});

test("duplicate intake copies collapse to one lead", () => {
  const r = M.report(
    [
      {
        jobId: "a",
        businessId: "A",
        createdAt: at,
        stage: "new",
        total: 0,
        externalSource: "wix",
        externalId: "sub1",
        source: "Wix",
      },
      {
        jobId: "b",
        businessId: "A",
        createdAt: at,
        stage: "quoted",
        quoteSentAt: at,
        total: 465,
        externalSource: "wix",
        externalId: "sub1",
        source: "Wix",
      },
    ],
    { range, now },
  );
  assert.equal(r.leads, 1);
  assert.equal(r.quotes, 1);
  assert.equal(r.quotedValue, 465);
});

test("missing service costs stay unavailable rather than zero", () => {
  const r = M.report(
    [
      {
        ...lead,
        stage: "won",
        wonAt: at,
        services: [{ svc: "house", priceSnapshot: 115 }],
      },
    ],
    { range, now },
  );
  assert.equal(r.services[0].costKnown, false);
  assert.equal(r.services[0].cost, null);
});

test("duplicate dedup still works in the browser, where sales-metrics.js's own <script> tag loads before lead-identity.js's", () => {
  // index.html loads these as plain (non-module) <script> tags in this exact
  // order: sales-metrics.js, ..., lead-identity.js. Reproduce that ordering
  // with no CommonJS `module`/`require` in scope (unlike this test file's own
  // Node environment), so a regression that only resolves TK_LEAD_IDENTITY
  // once, at sales-metrics.js's own load time, can't hide behind require().
  const sandbox = { window: {}, console };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../sales-metrics.js"), "utf8"),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../lead-identity.js"), "utf8"),
    sandbox,
  );
  const browserM = sandbox.window.TK_METRICS;
  const r = browserM.report(
    [
      { jobId: "a", businessId: "A", createdAt: at, stage: "new", total: 0, externalSource: "wix", externalId: "sub1", source: "Wix" },
      { jobId: "b", businessId: "A", createdAt: at, stage: "quoted", quoteSentAt: at, total: 465, externalSource: "wix", externalId: "sub1", source: "Wix" },
    ],
    { range, now },
  );
  assert.equal(r.leads, 1);
  assert.equal(r.quotedValue, 465);
});


test("unquoted zero defaults retain estimates in pipeline and forecast", () => {
 const r=M.report([{...lead,total:0,opportunityValue:800}],{range,now,probabilities:{new:0.25}});
 assert.equal(r.openValue,800);assert.equal(r.pipeline[0].value,800);assert.equal(r.forecast,200);
});
test("verified ServiceM8 zero does not fall back to a stale opportunity estimate", () => {
 const r=M.report([{...lead,total:0,opportunityValue:800,serviceM8Pricing:{total:0}}],{range,now,probabilities:{new:0.25}});
 assert.equal(r.openValue,0);assert.equal(r.pipeline[0].value,0);assert.equal(r.forecast,0);
});
