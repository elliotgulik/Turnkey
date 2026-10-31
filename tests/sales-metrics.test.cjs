const { test } = require("node:test"),
  assert = require("node:assert/strict"),
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
