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
      page.setDefaultTimeout(5000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith(base)) {
          // This suite exercises sales-platform's Leads UI, before the Nova replacement.
          if (new URL(url).pathname === '/nova-lead-manager.js')
            return route.fulfill({ contentType: 'text/javascript', body: '' });
          if (new URL(url).pathname === "/config.js")
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
      await page.getByRole('button',{name:'Build a quote'}).first().click();
      await page.locator('#sale-quote-search').fill('lead@example.test');
      assert.equal(await page.locator('#sale-quote-results [data-sale-action="quote-select"]').count(),1);
      await page.evaluate(() => {
        window.__earthQuoteScope={biz:currentBusinessId,user:currentUserId,ready:businessStateReady,customer:records[0].customerId};
        currentBusinessId='earth-browser-test';currentUserId='earth-browser-user';businessStateReady=true;
        records.forEach(r=>recordBusinesses.set(r,currentBusinessId));
        records[0].customerId='11111111-1111-4111-8111-111111111111';
        window.__earthLaunch=null;
        window.__earthAck=(e)=>{if(e.source===window&&e.data?.source==='turnkey-crm-page'&&e.data.type==='TK_LAUNCH'){
          window.__earthLaunch=e.data;
          window.postMessage({source:'turnkey-customer-launch',type:'TK_LAUNCH_ACK',nonce:e.data.nonce},location.origin);
        }};
        window.addEventListener('message',window.__earthAck);
        window.postMessage({source:'turnkey-customer-launch',type:'TK_READY'},location.origin);
      });
      await page.locator('#sale-quote-results [data-sale-action="quote-select"]').click();
      await page.waitForFunction(()=>window.__earthLaunch?.recordId===1);
      assert.equal(await page.locator('#sales-dialog').evaluate(el=>el.open),false);
      assert.equal(await page.locator('#quote-overlay').evaluate(el=>el.classList.contains('active')),false,'customer selection must not open the in-site quote builder');
      await page.evaluate(()=>{
        window.removeEventListener('message',window.__earthAck);
        currentBusinessId=window.__earthQuoteScope.biz;currentUserId=window.__earthQuoteScope.user;businessStateReady=window.__earthQuoteScope.ready;
        records[0].customerId=window.__earthQuoteScope.customer;records.forEach(r=>recordBusinesses.set(r,currentBusinessId));
      });
      await page.getByRole('button',{name:'Build a quote'}).first().click();
      await page.locator('#sale-quote-search').fill('no-such-customer');
      assert.match(await page.locator('#sale-quote-results').innerText(),/No matching opportunities/);
      await page.locator('#sale-quote-new input[name="name"]').fill('New quote customer');
      await page.getByRole('button',{name:'Close'}).click();
      await page.evaluate(() => switchView("leads"));
      // Name sort is timing-independent (unlike newest/oldest, which can tie on fixtures
      // created within the same millisecond), so it is a stable way to check lead sorting.
      await page
        .locator('#view-leads [data-sale-filter="sort"]')
        .selectOption("name");
      assert.deepEqual(
        await page
          .locator("#view-leads .sale-card")
          .evaluateAll((els) => els.map((el) => Number(el.dataset.record))),
        [1, 4, 3],
        "Leads sort by name must be alphabetical",
      );
      await page
        .locator('#view-leads [data-sale-filter="sort"]')
        .selectOption("newest");
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
      assert.deepEqual(await page.locator('#view-pipeline [data-drop-stage]').evaluateAll(els=>els.map(el=>el.dataset.dropStage)),['new','contacted','quoted','won','lost']);
      const columnIds=async stage=>page.locator(`#pipeline-${stage} [data-record]`).evaluateAll(els=>els.map(el=>Number(el.dataset.record)).sort((a,b)=>a-b));
      assert.deepEqual(await columnIds('contacted'),[1,3]);
      assert.deepEqual(await columnIds('quoted'),[4]);
      assert.deepEqual(await columnIds('completed'),[6,7]);
      assert.match(await page.locator('[data-sale-action="pipeline-scope"][data-id="completed"]').innerText(), /Completed\s+2/);
      assert.match(await page.locator('[data-sale-action="pipeline-scope"][data-id="won"]').innerText(), /Quote confirmed\s+2/);
      assert.equal(await page.locator('#view-pipeline [data-record]').count(),10);
      assert.equal(await page.locator('#pipeline-contacted [data-sale-stage="3"]').inputValue(),'contacted');
      assert.equal(await page.locator('#pipeline-quoted [data-sale-stage="4"]').inputValue(),'quoted');
      assert.deepEqual(await page.evaluate(()=>records.filter(r=>[3,4,5,6,7,8,9,10].includes(r.id)).map(r=>r.stage)),['qualified','followup','scheduled','completed','paid','cancelled','cancelled','lost']);
      // Scope tabs are real filters, with completed work separated from confirmed quotes.
      await page.locator('[data-sale-action="pipeline-scope"][data-id="won"]').click();
      assert.equal(await page.locator('#view-pipeline .sale-column').count(),1);
      assert.deepEqual(await columnIds('won'),[2,5]);
      await page.locator('#pipeline-won [data-sale-stage="5"]').selectOption('contacted');
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===5).stage),'scheduled','Won operational records must stay locked');
      await page.locator('[data-sale-action="pipeline-scope"][data-id="completed"]').click();
      assert.deepEqual(await columnIds('completed'), [6,7]);
      assert.match(await page.locator('#view-pipeline .sale-results').innerText(), /Completed/);
      assert.equal(await page.locator('#pipeline-completed').getAttribute('data-drop-stage'), null);
      for (const id of [6,7]) {
        const completed = page.locator(`#pipeline-completed [data-record="${id}"]`);
        assert.equal(await completed.locator('[data-sale-state="completed"]').innerText(), 'Completed');
        assert.equal(await completed.locator('[data-sale-state="won"]').count(), 0);
        assert.equal(await completed.locator('[data-sale-stage]').count(), 0);
        assert.equal(await completed.getAttribute('draggable'), 'false');
      }
      assert.equal(await page.locator('#pipeline-completed [data-record="7"] .sale-state-operation').innerText(), 'Paid');
      assert.deepEqual(await page.evaluate(() => records.filter(r => [6,7].includes(r.id)).map(r => TK_METRICS.won(r))), [true,true]);
      await page.locator('[data-sale-action="pipeline-scope"][data-id="lost"]').click();
      assert.deepEqual(await columnIds('lost'),[8,9,10]);
      await page.locator('[data-sale-action="pipeline-scope"][data-id="all"]').click();
      assert.equal(await page.locator('#view-pipeline .sale-column').count(),6);
      const allExpected=await page.evaluate(()=>records.filter(r=>TK_PIPELINE.visible(r,'all')).map(r=>r.id).sort((a,b)=>a-b));
      const allActual=await page.locator('#view-pipeline [data-record]').evaluateAll(els=>els.map(el=>Number(el.dataset.record)).sort((a,b)=>a-b));
      if(JSON.stringify(allActual)!==JSON.stringify(allExpected))pipelineScopeErrors.push({width:viewport.width,expected:allExpected,actual:allActual,reason:'All scope must render exactly the records included by pipeline-model.visible'});
      assert.deepEqual(await columnIds('won'),[2,5]);
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
      // An offline/unscoped session cannot fall through to the old quote editor.
      await page.locator('#pipeline-quoted [data-sale-action="contact"][data-id="4"]').click();
      await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Sign in and wait for your business'));
      assert.equal(await page.locator('#view-inbox .cv-composer').count(),0);
      await page.locator('#pipeline-contacted [data-sale-action="quote"][data-id="3"]').click();
      assert.equal(await page.locator('#qw-step-0').isVisible(),false);
      assert.match(await page.locator('#toast').innerText(),/account is still loading/);
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===3).stage),'qualified');
      if (viewport.width > 760) {
        const source=page.locator('#view-pipeline [data-record="1"]'),target=page.locator('[data-drop-stage="contacted"]');
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
          .selectOption("contacted");
      try { await page.waitForFunction(() => records[0].stage === "contacted", null, {timeout:3000}); }
      catch(e) { fs.mkdirSync('.artifacts',{recursive:true}); await page.screenshot({path:'.artifacts/drag-failure.png',fullPage:true}); throw e; }
      assert.equal(await page.evaluate(()=>records[0].salesHistory.at(-1).to),'contacted');
      assert.deepEqual(await columnIds('contacted'),[1,3]);
      await page.locator('#pipeline-contacted [data-record="1"] .sale-record-open').click();
      await page.locator("#sale-notes").fill("Browser-only note");
      await page.locator('#view-detail [data-sale-action="save-details"]').click();
      assert.equal(await page.evaluate(()=>records[0].salesNotes),'Browser-only note');
      assert.match(
        await page.locator("#view-detail").innerText(),
        /ServiceM8 handoff/,
      );
      // A record that never moved stages must show the history empty-state, not a blank panel.
      await page.evaluate(() => openDetail(9));
      assert.match(
        await page.locator("#view-detail").innerText(),
        /Historical stage timestamps are not available for this record\./,
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
      await page.evaluate(() => switchView("dashboard"));
      // Existing quote review/editing remains local. A fresh Build quote uses
      // Earth (verified above) and must not be used to test this editor.
      await page.evaluate(()=>{const r=records.find(r=>r.id===1);r.stage='quoting';r.services=[{svc:'driveway',qty:10}];r.total=100;r.quoteSentAt=null;openDetail(r.id);});
      await page.locator('#view-detail').getByRole('button',{name:'Edit saved quote',exact:true}).click();
      assert.match(
        await page.locator("#quote-overlay").getAttribute("class"),
        /open/,
      );
      assert.equal(await page.locator('#qw-step-0').isVisible(),true);
      await page.locator('#qw-next').click();
      assert.equal(await page.locator('#qw-step-1').isVisible(),true);
      // User-owned measurement imports require review and never send a quote.
      await page.evaluate(async()=>{const {measure}=await import('/chrome-extension/measurement.js');const geometry={type:'Polygon',coordinates:[[[174.75,-36.76],[174.7501,-36.76],[174.7501,-36.7601],[174.75,-36.7601],[174.75,-36.76]]]};window.postMessage({type:'TK_MEASUREMENT_IMPORT',payload:{version:1,measurements:[{service:'driveway',kind:'area',unit:'m2',value:measure(geometry).siValue,geometry}]}},location.origin);});
      await page.getByRole('heading',{name:'Review imported measurements'}).waitFor();
      await page.getByRole('button',{name:'Add to this quote'}).click();
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===1).areaPolys.some(a=>a.id.startsWith('import-'))),true);
      assert.equal(await page.evaluate(()=>records.find(r=>r.id===1).quoteSentAt),null);
      // Cancelling the review dialog must leave the quote exactly as it was — no partial add.
      const areaPolysBeforeCancel = await page.evaluate(() => records.find(r => r.id === 1).areaPolys.length);
      await page.evaluate(async () => {
        const { measure } = await import('/chrome-extension/measurement.js');
        const geometry = { type: 'LineString', coordinates: [[174.76, -36.77], [174.7601, -36.7701]] };
        window.postMessage({ type: 'TK_MEASUREMENT_IMPORT', payload: { version: 1, measurements: [{ service: 'fence', kind: 'length', unit: 'm', value: measure(geometry).siValue, geometry }] } }, location.origin);
      });
      await page.getByRole('heading', { name: 'Review imported measurements' }).waitFor();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.locator('.measurement-review').waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate(() => records.find(r => r.id === 1).areaPolys.length),
        areaPolysBeforeCancel,
        'Cancelling the measurement review must not add measurements',
      );
      await page.evaluate(() => closeModal("quote-overlay"));
      // Exercise the mounted independent workspace, including its real create-job bridge.
      await page.evaluate(() => { currentUserId='operations-browser-owner';currentUserRole='owner';businessStateReady=true;records.forEach(r=>recordBusinesses.set(r,currentBusinessId));switchView('operations'); TK_OPERATIONS.open('jobs'); });
      assert.match(await page.locator('#view-operations').innerText(), /Scheduled operation/);
      await page.locator('#view-operations [data-action="createJob"]').click();
      assert.equal(await page.locator('#lead-overlay').evaluate(el=>el.classList.contains('open')),true);
      await page.evaluate(() => closeModal('lead-overlay'));
      await page.evaluate(() => TK_OPERATIONS.open('invoices'));
      assert.match(await page.locator('#view-operations').innerText(), /Invoices/);
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
