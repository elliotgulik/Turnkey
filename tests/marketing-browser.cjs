/* Offline UI checks: only fixture responses, all network requests blocked. */
const { chromium } = require("playwright"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
(async () => {
  const cached = path.join(
    require("node:os").homedir(),
    "Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
  const browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(chromium.executablePath())
      ? {}
      : { executablePath: cached }),
  });
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (r) => r.abort());
      await page.setContent(
        '<!doctype html><button id="launch">Marketing report</button>',
      );
      await page.addStyleTag({ path: path.resolve("marketing-analytics.css") });
      await page.addScriptTag({ path: path.resolve("marketing-analytics.js") });
      await page.evaluate(() => {
        window.fixture = { business: "a", failure: false, calls: [] };
        const metric = {
          spend: 25,
          impressions: 1000,
          reach: null,
          clicks: 50,
          link_clicks: 40,
          leads: null,
          ctr: 5,
          cpc: 0.5,
          cpm: 25,
          frequency: null,
          cpl: null,
        };
        window.TK_MARKETING.configure({
          getBusinessId: () => fixture.business,
          request: async (path, options) => {
            fixture.calls.push({ path, options });
            if (fixture.failure)
              throw Error(
                "Meta rate limit reached. Saved reports are unchanged.",
              );
            if (path.endsWith("/connection"))
              return {
                configured: true,
                connected: false,
                accountId: "123",
                currency: "NZD",
                timezone: "Pacific/Auckland",
              };
            if (path.includes("/report?"))
              return {
                coverage: {
                  complete: true,
                  days: 30,
                  expectedDays: 30,
                  sources: ["csv"],
                  oldestRefresh: "2026-10-01",
                },
                account: { currency: "NZD", timezone: "Pacific/Auckland" },
                totals: metric,
                entities: [
                  {
                    id: "3",
                    name: '<img src=x onerror="window.injected=true">',
                    ...metric,
                  },
                ],
                page: 0,
                limit: 100,
                total: 1,
                attribution: {
                  linkedLeads: 0,
                  unknownLeads: 2,
                  cohortLeads: 2,
                  basis: "Fixture CRM opportunities",
                  byAd: [],
                },
                notes: ["Reach cannot be summed."],
              };
            if (path.includes("/sync")) return { ok: true };
            return "date,level";
          },
        });
        document.querySelector("#launch").onclick = () => TK_MARKETING.open();
      });
      await page.click("#launch");
      await page.getByText("Saved report loaded.", { exact: true }).waitFor();
      assert.equal(await page.locator("[role=dialog]").count(), 1);
      assert.equal(await page.locator("[data-results] img").count(), 0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      assert.ok(
        (await page.locator("[data-results]").innerText()).includes(
          "0 explicitly linked opportunities · 2 unknown",
        ),
      );
      assert.equal(await page.locator("[data-action=next]").isDisabled(), true);
      await page.locator("[data-filter=view]").selectOption("daily");
      await page.getByText("Saved report loaded.", { exact: true }).waitFor();
      assert.ok(
        await page.evaluate(() =>
          fixture.calls.some((c) => c.path.includes("view=daily")),
        ),
      );
      await page.locator("summary").first().click();
      assert.equal(
        await page.locator("[name=token]").getAttribute("type"),
        "password",
      );
      await page
        .locator("[name=token]")
        .fill("token-must-be-cleared-immediately");
      await page.click("[data-action=connect]");
      await page.getByText("Saved report loaded.", { exact: true }).waitFor();
      assert.equal(await page.locator("[name=token]").inputValue(), "");
      await page.evaluate(() => (fixture.failure = true));
      await page.click("[data-action=sync]");
      await page.getByRole("alert").waitFor();
      assert.match(await page.getByRole("alert").innerText(), /rate limit/);
      assert.equal(
        await page.locator("[data-action=sync]").isDisabled(),
        false,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: "/tmp/turnkey-marketing-" + viewport.width + ".png",
      });
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("[role=dialog]").count(), 0);
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        "launch",
      );
      await page.evaluate(() => {
        fixture.failure = false;
        TK_MARKETING.open();
      });
      await page.getByText("Saved report loaded.", { exact: true }).waitFor();
      await page.evaluate(() => (fixture.business = "b"));
      await page.locator("[role=dialog]").waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      await page.close();
      console.log("Marketing UI passed at " + viewport.width + "px");
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
