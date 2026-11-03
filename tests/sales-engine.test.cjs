const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm");

const sandbox = { window: {}, console };
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, "../sales-engine.js"), "utf8"),
  sandbox,
);
const S = sandbox.window.TK_SALES;
const now = Date.UTC(2026, 9, 15, 12),
  at = now - 86400000;

test("lost includes explicit lost stage and never-won cancellations", () => {
  assert.equal(S.isLostR({ stage: "lost", total: 100 }), true);
  assert.equal(S.isLostR({ stage: "cancelled", total: 100 }), true);
  assert.equal(S.isLostR({ stage: "cancelled", lostAt: at, total: 100 }), true);
  assert.equal(
    S.isLostR({ stage: "cancelled", wonAt: at, total: 100 }),
    false,
  );
  assert.equal(S.isWonR({ stage: "completed" }), true);
});

test("cohort funnel counts ServiceM8 unsuccessful as lost, not open", () => {
  const rep = S.report(
    [
      {
        createdAt: at,
        stage: "lost",
        total: 200,
        quoteSentAt: at,
        source: "Website",
        lostReason: "price",
      },
      {
        createdAt: at,
        stage: "cancelled",
        wonAt: at - 1000,
        total: 300,
        source: "Website",
      },
    ],
    { period: "90d", now },
  );
  assert.equal(rep.totals.lost, 1);
  assert.equal(rep.totals.won, 0);
  assert.equal(rep.totals.lostValue, 200);
  assert.equal(rep.lost[0].count, 1);
});
