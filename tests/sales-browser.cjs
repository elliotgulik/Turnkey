const { chromium } = require("playwright"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
(async () => {
  const server = http.createServer((req, res) => {
    const name =
      new URL(req.url, "http://localhost").pathname.replace(/^\//, "") ||
      "index.html";
    if (
      name.includes("..") ||
      ![".html", ".css", ".js", ".png", ".ico", ".webmanifest"].includes(
        path.extname(name),
      )
    ) {
      res.writeHead(404);
      return res.end();
    }
    const file = path.resolve(name);
    if (!file.startsWith(process.cwd() + path.sep)) {
      res.writeHead(404);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader(
        "Content-Type",
        { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[
          path.extname(file)
        ] || "application/octet-stream",
      );
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
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
  const errors = [], pipelineScopeErrors = [];
  try {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(base)) {
          if (url.endsWith("/config.js"))
            return route.fulfill({
              contentType: "text/javascript",
              body: "window.TURNKEY_CONFIG={};",
            });
          return route.continue();
        }
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: "",
        });
      });
      await page.goto(base + "/index.html");
      await page.waitForFunction(() => !!window.TK_SALES_PLATFORM && !!window.TK_PIPELINE && !!window.TK_QUOTE_WORKSPACE);
      await page.evaluate(() => {
        records = [
          newRecord({
            id: 1,
            name: "Browser test lead",
            email: "lead@example.test",
            source: "Wix",
            address: "Test property",
            createdAt: Date.now() - 86400000,
            stage: "new",
            opportunityValue: 400,
          }),
          newRecord({
            id: 2,
            name: "Browser test win",
            source: "Meta",
            stage: "won",
            wonAt: Date.now() - 3600000,
            createdAt: Date.now() - 86400000,
            total: 1150,
            estimatedCost: 400,
            gstRegistered: true,
            services: [
              {
                svc: "driveway",
                qty: 40,
                fixedPrice: 1150,
                priceSnapshot: 1150,
              },
            ],
          }),
        ];
        // Legacy identities must group correctly without being rewritten on render.
        records.push(...[
          {id:3,name:'Legacy qualified',stage:'qualified'},
          {id:4,name:'Legacy follow-up',stage:'followup',email:'followup@example.test',nextFollowUpAt:new Date(Date.now()-86400000).toISOString()},
          {id:5,name:'Scheduled operation',stage:'scheduled'},
          {id:6,name:'Completed operation',stage:'completed'},
          {id:7,name:'Paid operation',stage:'paid'},
          {id:8,name:'Lost enquiry',stage:'cancelled',lostAt:Date.now(),lostReason:'Timing'},
          {id:9,name:'Cancelled operation',stage:'cancelled'},
          {id:10,name:'Legacy lost',stage:'lost'}
        ].map(r=>newRecord({address:'Synthetic test property',createdAt:Date.now()-86400000,...r})));
        showApp();
        render();
        switchView("dashboard");
      });
      assert.match(
        await page.locator("#view-dashboard").innerText(),
        /Booked sales/,
      );
      assert.ok(
        (await page.locator("#view-dashboard .sale-kpi").count()) >= 11,
      );
      await page.evaluate(() => switchView("leads"));
      await page.locator("#sale-search").fill("does-not-exist");
      await page
        .getByText("No matching enquiries.", { exact: false })
        .waitFor();
      await page.locator("#sale-search").fill("Browser test lead");
      assert.equal(await page.locator("#view-leads .sale-card").count(), 1);
      await page
        .locator('#view-leads [data-sale-stage="1"]')
        .selectOption("contacted");
      await page.waitForFunction(() => records[0].stage === "contacted");
      await page.evaluate(() => {
        switchView("pipeline");
      });
      assert.deepEqual(await page.locator('#view-pipeline [data-drop-stage]').evaluateAll(els=>els.map(el=>el.dataset.dropStage)),['new','contacted','quoting','quoted']);
      const columnIds=async stage=>page.locator(`#pipeline-${stage} [data-record]`).evaluateAll(els=>els.map(el=>Number(el.dataset.record)).sort((a,b)=>a-b));
      assert.deepEqual(await columnIds('contacted'),[1,3]);
      assert.deepEqual(await columnIds('quoted'),[4]);
      assert.equal(await page.locator('#view-pipeline [data-record]').count(),3);
      assert.equal(await page.locator('#pipeline-contacted [data-sale-stage="3"]').inputValue(),'contacted');
      assert.equal(await page.locator('#pipeline-quoted [data-sale-stage="4"]').inputValue(),'quoted');
      assert.deepEqual(await page.evaluate(()=>records.filter(r=>[3,4,5,6,7,8,9,10].includes(r.id)).map(r=>r.stage)),['qualified','followup','scheduled','completed','paid','cancelled','cancelled','lost']);
      // Scope tabs are real filters, with terminal operational states grouped as confirmed.
      await page.locator('[data-sale-action="pipeline-scope"][data-id="won"]').click();
      assert.equal(await page.locator('#view-pipeline .sale-column').count(),1);
      assert.deepEqual(await columnIds('won'),[2,5,6,7]);
      await page.locator('#pipeline-won [data-sale-stage="5"]').selectOption('contacted');
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===5).stage),'scheduled','Won operational records must stay locked');
      await page.locator('[data-sale-action="pipeline-scope"][data-id="lost"]').click();
      assert.deepEqual(await columnIds('lost'),[8,10]);
      await page.locator('[data-sale-action="pipeline-scope"][data-id="all"]').click();
      assert.equal(await page.locator('#view-pipeline .sale-column').count(),6);
      const allExpected=await page.evaluate(()=>records.filter(r=>TK_PIPELINE.visible(r,'all')).map(r=>r.id).sort((a,b)=>a-b));
      const allActual=await page.locator('#view-pipeline [data-record]').evaluateAll(els=>els.map(el=>Number(el.dataset.record)).sort((a,b)=>a-b));
      if(JSON.stringify(allActual)!==JSON.stringify(allExpected))pipelineScopeErrors.push({width:viewport.width,expected:allExpected,actual:allActual,reason:'All scope must render exactly the records included by pipeline-model.visible'});
      assert.deepEqual(await columnIds('won'),[2,5,6,7]);
      await page.locator('[data-sale-action="pipeline-scope"][data-id="open"]').click();
      await page.locator('#pipeline-search').fill('Legacy qualified');
      assert.equal(await page.locator('#view-pipeline [data-record]').count(),1);
      assert.equal(await page.locator('#view-pipeline [data-record]').getAttribute('data-record'),'3');
      await page.locator('#pipeline-search').fill('');
      await page.locator('#pipeline-due').check();
      assert.deepEqual(await columnIds('quoted'),[4]);
      assert.equal(await page.locator('#view-pipeline [data-record]').count(),1);
      await page.locator('#pipeline-due').uncheck();
      // The mounted Conversations bridge guards contact actions in this offline session.
      // Preparation still opens the real quote workspace without sending anything.
      await page.locator('#pipeline-quoted [data-sale-action="contact"][data-id="4"]').click();
      await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Sign in and wait for your business'));
      assert.equal(await page.locator('#view-inbox .cv-composer').count(),0);
      await page.locator('#pipeline-contacted [data-sale-action="quote"][data-id="3"]').click();
      assert.equal(await page.locator('#qw-step-0').isVisible(),true);
      await page.evaluate(()=>closeModal('quote-overlay'));
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===3).stage),'qualified');
      if (viewport.width > 760) {
        const source=page.locator('#view-pipeline [data-record="1"]'),target=page.locator('[data-drop-stage="quoting"]');
        await source.scrollIntoViewIfNeeded();
        await page.locator('#view-pipeline').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
        const from=await source.boundingBox(),to=await target.boundingBox();
        await page.mouse.move(from.x+25,from.y+20);
        await page.mouse.down();
        await page.mouse.move(from.x+45,from.y+30,{steps:5});
        await page.mouse.move(to.x+35,to.y+35,{steps:20});
        await page.mouse.move(to.x+40,to.y+40,{steps:3});
        await page.mouse.up();
      }
      else
        await page
          .locator('#view-pipeline [data-sale-stage="1"]')
          .selectOption("quoting");
      try { await page.waitForFunction(() => records[0].stage === "quoting", null, {timeout:3000}); }
      catch(e) { fs.mkdirSync('.artifacts',{recursive:true}); await page.screenshot({path:'.artifacts/drag-failure.png',fullPage:true}); throw e; }
      assert.equal(await page.evaluate(()=>records[0].salesHistory.at(-1).to),'quoting');
      assert.deepEqual(await columnIds('quoting'),[1]);
      await page.locator('#pipeline-quoting [data-record="1"]').click();
      await page.locator("#sale-notes").fill("Browser-only note");
      await page.locator('#view-detail [data-sale-action="save-details"]').click();
      assert.equal(await page.evaluate(()=>records[0].salesNotes),'Browser-only note');
      assert.match(
        await page.locator("#view-detail").innerText(),
        /ServiceM8 handoff/,
      );
      await page.evaluate(() => switchView("sales"));
      assert.match(
        await page.locator("#view-sales").innerText(),
        /Unavailable/,
      );
      await page.evaluate(() => switchView("goals"));
      await page.evaluate(() => {
        currentBusinessId = "browser-test-business";
        localStorage.setItem(
          STORE_KEY + ":legacy-unassigned",
          JSON.stringify({
            goals: [{ id: 1, label: "Recovered test goal", target: 500 }],
          }),
        );
        renderGoals();
      });
      assert.doesNotMatch(
        await page.locator("#view-goals").innerText(),
        /Recovered test goal/,
      );
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator('[data-sale-action="recover-goals"]').click();
      assert.match(
        await page.locator("#view-goals").innerText(),
        /Recovered test goal/,
      );
      await page.locator('#view-goals [data-sale-action="goal-new"]').click();
      assert.equal(
        await page.locator("#sales-dialog").evaluate((el) => el.open),
        true,
      );
      await page
        .locator('#sales-dialog [data-sale-action="dialog-close"]')
        .click();
      await page.evaluate(() => switchView("quote-builder"));
      await page.locator("#quote-builder-lead").selectOption("1");
      await page.locator("#quote-builder-open").click();
      assert.match(
        await page.locator("#quote-overlay").getAttribute("class"),
        /open/,
      );
      assert.equal(await page.locator('#qw-step-0').isVisible(),true);
      await page.locator('#qw-next').click();
      assert.equal(await page.locator('#qw-step-1').isVisible(),true);
      await page.evaluate(() => closeModal("quote-overlay"));
      // Screenshots contain synthetic test records only.
      await page.evaluate(() => switchView("dashboard"));
      fs.mkdirSync(".artifacts", { recursive: true });
      await page.screenshot({
        path: ".artifacts/sales-" + viewport.width + ".png",
        fullPage: true,
        animations: "disabled",
      });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(
        overflow,
        false,
        "page has horizontal overflow at " + viewport.width,
      );
      await page.goto(base + "/booking.html");
      await page.waitForLoadState("domcontentloaded");
      assert.ok((await page.title()).length);
      await page.goto(base + "/quote.html");
      await page.waitForLoadState("domcontentloaded");
      assert.ok((await page.title()).length);
      await context.close();
      console.log("Completed desktop/mobile flows at " + viewport.width + "px");
    }
    assert.deepEqual(errors, [], "browser runtime errors");
    assert.deepEqual(pipelineScopeErrors, [], "Pipeline All scope disagrees with its model");
    console.log("PASS assembled sales browser workflows");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
