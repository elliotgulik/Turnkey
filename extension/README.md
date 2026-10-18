# TurnKey — Google Earth Instant Quote (Chrome extension)

## Version 0.2.5: per-service chemical costs

Choose chemicals and concentrate usage per service in TurnKey → Pricing. Set your actual per-litre supplier prices there. Earth uses these saved settings; missing prices are flagged as incomplete. Update your unpacked extension to this folder and refresh Earth.

## Version 0.2.4: automatic signed-in account connection

Open TurnKey, sign in, then open the extension popup and choose **Connect to signed-in TurnKey** once. It adopts the verified session and business from the active TurnKey tab; it does not ask for a CRM URL, email, or password. After that, **Build quote** opens the saved customer address in Google Earth, and saving creates a new draft under that customer's file. Existing accepted quotes are preserved.

Download the versioned ZIP from TurnKey, unzip it, then select the folder containing `manifest.json` with **Load unpacked**. Disable older copies and refresh both TurnKey and Earth after updating.

After creating a quote, choose **Send to ServiceM8** to queue the saved draft for handoff. **Check transfer** shows its progress and opens the linked ServiceM8 job when complete. Queueing does not approve the quote or email the customer. A failed transfer leaves the TurnKey draft intact. Existing installations may need to open the extension popup and choose **Enable ServiceM8 transfers** to grant access to their configured TurnKey backend.

### Outline editing, expenses and editable pricing

- **2D:** drag a numbered corner. Click or drag a **+** handle to insert a corner between existing points.
- **Either view:** choose **Insert point** and an edge, then click its new position; or choose a corner and **Move corner**, then click the correct position. **Delete corner** and **Undo** also work.
- **3D:** move/insert points by clicking the loaded surface, so each edited point gets a real map coordinate and elevation. Roof surfaces use outline-only rendering; no filled sheet or extruded walls span the property.
- **Instant Quote:** the initial price uses the recommended target-margin price. Edit **Final customer price** or the quote's **Target gross margin**, or click **Use recommended price** again. Labour, chemicals, estimated travel/fuel, equipment, consumables and overheads appear separately with expected profit/margin. Internal costs do not appear on the customer quote.
- Travel uses an editable **round-trip kilometre estimate**, not a live route calculation. Costs are estimates from your business pricing settings, not actual job expenses.
- A successful empty database response no longer produces a false failed-save error. A failed activity note is reported separately from an already saved quote.

Install the updated extension folder and refresh Google Earth. Refresh any already-open measurement workspace to load the new editing controls.

A Manifest V3 Chrome extension that overlays a TurnKey quoting toolbar on
[Google Earth](https://earth.google.com), lets an operator measure a
property's roof/driveway/house/fence on an accurate satellite map, prices it
with the business's own TurnKey rates, and creates a draft quote directly in
TurnKey — without leaving the browser.

Every screen writes to and reads from the real TurnKey Supabase project
(`customers`, `quotes`, `jobs`, `activity_log`, `attachments`), reuses
TurnKey's actual pricing engine byte-for-byte, and authenticates with the
operator's real TurnKey login.

## Install / update (unpacked)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder (if you already had
   an older version loaded, click the reload icon on this extension's card
   instead — v0.2.0 changed its permissions, which Chrome will ask you to
   re-approve once).
3. Open TurnKey and sign in as usual. Click the extension icon and choose
   **Connect to signed-in TurnKey**. Chrome asks for access to TurnKey's
   production Supabase project; allow it to finish the connection. The
   extension validates the existing session with Supabase and reads the
   business from the authenticated user's `users` profile. It does not ask
   for a site URL or password.
4. Open [earth.google.com](https://earth.google.com), search for a property,
   and the TurnKey toolbar appears in the top-right.

The extension reads the public config from the active, allowlisted TurnKey
site and the existing session from that site's Supabase local-storage entry.
The session is passed only through Chrome's extension messaging channel (not
through page `postMessage` or a URL), then validated by Supabase's Auth API
before the extension stores it. The Supabase user id and business id are
derived from validated Auth and the user's RLS-protected profile; neither is
trusted from page-provided values. Only the production TurnKey CRM origin and
the repository's production Supabase project are accepted for automatic
connection. ServiceM8 backend access remains a separate optional permission.
Never paste service-role credentials into the extension. Tokens and customer
identifiers are not placed in Google Earth URLs.

## How measuring actually works (read this before the "known limitations")

Google Earth Web renders through a proprietary WebGL globe with no public JS
API for reading camera state, terrain elevation, or converting a screen
click into a real coordinate — there's nothing a content script can hook
into for that, and the previous version of this extension's workaround (an
in-page OpenStreetMap tile tracer stretched onto a fixed-size canvas) had
real bugs: it requested a zoom level OSM doesn't serve, could render a blank
map if Earth's page CSP blocked the tile images, and applied one fixed
pixel-to-metre scale to a canvas whose on-screen size didn't match that
scale — producing a wrong number instead of an obviously-broken one.

**"Outline"/"Distance" now opens a dedicated TurnKey-hosted workspace tab**
(`measure.html`, served from your own TurnKey site, e.g.
`https://turnkeycrm.net/measure.html`) instead of tracing inside the Earth
page. That page:

- Loads the real Google Maps JavaScript SDK directly (your TurnKey site's
  own `config.js` → `mapsKey`), giving you an actual 2D satellite top-down
  view with native click → lat/lng, polygon/polyline drawing, pan/zoom, and
  Undo/Clear/Finish — not a stretched image mosaic.
- Offers **"3D inspect"** where available (`google.maps.maps3d.Map3DElement`
  — current Google Maps JS API; the old `tilt: 45` imagery API is
  decommissioned and isn't used here) with heading/tilt/range camera
  controls, so you can walk around a roof from multiple angles. Points
  collected in 3D carry a real altitude; points collected in 2D don't, and
  are never guessed.
- Lets you explicitly choose **Ground** (always available) vs **3D
  surface/3D distance** (only selectable while in 3D inspect) — this is
  never auto-detected from whether a point happens to have an altitude.
  Switching back to 2D forces the mode back to Ground, since 2D clicks
  can't supply a real elevation.
- Shows a live preview using **the exact same math** as the final,
  authoritative calculation (`extension/geometry.js`, copied to this site's
  own `/geometry.js` at build time by `scripts/build-static.js`) — not a
  second, merely-similar implementation.

No extension code or remotely-hosted script runs inside Google Earth's page
to do this — see "The secure bridge" below for how the result actually gets
back to Earth.

### House vs Roof/Driveway/Deck: area vs perimeter

"House" traces the same closed-outline interaction as Roof/Driveway/Deck,
but is priced by **perimeter** (metres of wall, matching the `housewash`
service's `shape:'closed', unit:'m', basis:'perimeter'`), not area. The
service picker filters candidate services by BOTH click-shape and unit so a
perimeter measurement can never be assigned to an m²-priced service by
mistake (see `quote.js`'s `renderServiceOptions()`).

### The secure bridge (how a measurement gets back to Google Earth)

1. The Earth content script asks the **background service worker** to open
   the workspace (`TK_OPEN_WORKSPACE`). The worker checks the connected
   site's origin against a small allowlist it can actually inject into
   (`https://turnkeycrm.net` + local dev origins — see
   `BRIDGE_ALLOWED_ORIGINS` in `background/service-worker.js`, kept in sync
   with `manifest.json`'s `web_accessible_resources` for `geometry.js`); a
   self-hosted site outside that list gets a clear error up front instead of
   a tab that can never finish.
2. The worker creates a random `requestId`, opens `measure.html?requestId=…`
   in a new tab, and records `{earthTabId, workspaceTabId, category, kind,
   createdAt}` in `chrome.storage.session` — **not just an in-memory Map**.
   MV3 service workers are killed after ~30s idle and can restart between
   any two messages; a multi-minute 3D trace will outlive several such
   restarts, so the pending-request registry is rehydrated from
   `chrome.storage.session` on each access rather than assumed to still be
   in memory.
3. Once that tab loads, the worker injects
   `content/bridge/measure-bridge.js` into it via `chrome.scripting.executeScript`
   (no static content-script match for arbitrary sites — this requires the
   host permission the operator already granted when connecting).
4. When you click **Finish**, `measure.js` `postMessage`s the raw points +
   your explicit `kind`/`mode` choice to itself; the injected bridge script
   validates the message (exact origin/source, payload size/shape, no
   duplicate Finish for the same `requestId`), runs the **authoritative**
   `geometry.js` calculation, and sends the result to the background worker.
5. The worker checks the result came from the exact workspace tab it opened
   for that `requestId`, hasn't already been completed, then forwards it to
   the original Earth tab and tells the bridge to show "Sent ✓".

A spoofed origin, a stale/replayed `requestId`, a message from the wrong
tab, or a duplicate Finish are all rejected — see
`extension/tests/background-bridge.test.cjs` and
`extension/tests/measure-bridge.test.cjs`.

## How it reuses TurnKey rather than duplicating it

| Concern | Extension behaviour |
|---|---|
| Auth | Reuses the active TurnKey tab's Supabase session through a private extension message, validates it with Supabase Auth, then derives the tenant from the authenticated user's RLS-protected profile. No password is collected by the extension. |
| Pricing | `vendor/pricing-engine.js` is a byte-for-byte copy of the repo root's `pricing-engine.js`. |
| Measurement math | `extension/geometry.js` (geodesic ground area/length, ECEF-triangulated 3D surface area, closed-form validation) is the one implementation used by both the hosted workspace's live preview and the bridge's authoritative calculation. |
| Customers/leads | Writes to `public.customers` with `source: 'Google Earth Extension'`. |
| Quotes | Creates a **DRAFT** `quotes` row (`status: 'draft'`) + a `jobs` row — it never marks a quote `sent` or stamps a fake `quoteSentAt`, since nothing has actually been emailed to the customer at this point. |
| Measurements | Stored as `job.details.areaPolys`, same shape `booking.html`'s tool produces (`{id, service, size, unit, points, geoPts}`). `geoPts` (real lat/lng, with altitude for 3D-surface traces) is the source of truth; `points` is a same-length local-projection placeholder index.html's own Quote Editor immediately recomputes from `geoPts` — never used for measurement math itself. |
| Screenshots | Uploaded to the same private `turnkey-uploads` bucket/`attachments` table convention `index.html` uses. |

No new database tables or columns were added for this feature.

## API calls: why they go through the background worker

`turnkey-api.js`'s `TurnKeyClient`/`fetchSiteConfig()` only ever run in the
**background service worker** now (`background/service-worker.js`), not in
the Earth content script. Two independent reasons converged on the same
fix:

- **CSP/CORS**: `fetch()`ing Supabase directly from a script execution
  context tied to `earth.google.com` is subject to that page's CSP and
  cross-origin posture, neither of which this extension controls or can
  rely on. A background service worker has its own `extension_pages` CSP
  instead.
- **Blast radius**: the content script (and popup) now only ever reach a
  small, explicit allowlist of named operations (`TK_API` messages — see
  `API_ACTIONS` in `background/service-worker.js`), not an arbitrary
  "fetch this Supabase path" proxy. A compromised/malicious page script
  running anywhere a content script of this extension runs can't use this
  channel to read/write tables beyond what the extension's own UI already
  does.

`api/client-bridge.js` is the thin messaging client both the content panel
and the popup use instead of talking to Supabase directly.

## Idempotent quote creation

`content/panel/quote-create.js`'s `createQuoteDraft()` persists
which steps (customer/quote/job/screenshot/activity-log) already
succeeded in a `progress` object scoped to the current quote-panel session,
business-bound: if the connected business changes between attempts (e.g.
disconnect → reconnect a different TurnKey account while the panel is still
open), or a step's returned row doesn't actually belong to the current
business, its id is **not** adopted — see
`extension/tests/quote-create.test.cjs`. Retrying after a partial failure
reuses already-created ids instead of creating a second customer/quote/job
for the same intent.

## Known limitations

**Self-hosted TurnKey sites outside the bridge allowlist can't use the
measurement workspace yet.** `web_accessible_resources` (needed for the
bridge to `import()` `geometry.js` on the workspace tab's own origin) is a
static manifest list — unlike `host_permissions`, it can't be extended at
runtime when an operator types in a custom site URL. Opening the workspace
on an unlisted origin fails with a clear message rather than opening a tab
that can never complete. Production (`https://turnkeycrm.net`) and common
local-dev origins are covered; extending this to arbitrary self-hosted
sites would need either a build step that regenerates the manifest per
deployment, or `externally_connectable`-style trust of arbitrary sites,
which this extension deliberately avoids.

**3D inspect can be unavailable** (no WebGL, no 3D imagery for this
location, or the Maps API key doesn't have 3D enabled) — the workspace
shows a visible banner explaining this and the 2D satellite view keeps
working normally; it never pretends 3D succeeded.

**3D surface area is an aerial estimate, not a survey measurement** — it
triangulates the exact points you clicked in 3D space and says so in the
UI ("3D surface estimate — trace each flat face separately for best
accuracy"). It cannot see hidden features (chimneys, valleys, overhangs)
you didn't click.

**Default measurement unit (m² vs ft², in the popup's Settings) is stored
but not yet wired into the pricing/measurement math** — TurnKey's rates are
all defined per-m², so converting the whole quoting flow to imperial would
mean reworking that shared rate model, not just a display format.

**"Create Quote" does not send an email.** It creates a real DRAFT `quotes`
row (with a working `public_token` share link) and a real `jobs` row, but
deliberately does not call the CRM's `generateAndSendDoc()`/email-template
path. "Copy Quote Link" / "Open in TurnKey" (which now deep-links to the
exact job it just created) are how the operator gets it to the customer or
reviews/sends it for real.

## Structure

```
extension/
├── manifest.json
├── geometry.js                      # measurement math source of truth — also copied to the site root (scripts/build-static.js) for measure.html's live preview
├── background/service-worker.js     # screenshot capture, workspace bridge (open tab, durable pending registry, routing), scoped TK_API proxy
├── content/
│   ├── content.js                   # detects earth.google.com, mounts a Shadow DOM root, dynamic-imports the panel
│   ├── bridge/measure-bridge.js     # injected into the measure.html workspace tab — validates + computes + relays the finished measurement
│   └── panel/
│       ├── app.js                   # orchestrator: state, Earth URL polling, wiring, measurement-complete handling
│       ├── toolbar.js               # the floating draggable/minimizable toolbar
│       ├── quote.js                 # Instant Quote panel + "Quote Created" screen
│       ├── quote-create.js          # idempotent, business-bound quote/job creation (unit-testable without chrome/DOM)
│       └── screenshot.js            # capture + preview
├── api/
│   ├── turnkey-api.js               # hand-rolled Supabase REST client — background-worker-only now
│   ├── client-bridge.js             # thin TK_API messaging client used by the popup + content panel
│   └── storage.js                   # chrome.storage.local wrapper shared by the popup and the panel
├── vendor/pricing-engine.js         # byte-for-byte copy of /pricing-engine.js
├── popup/                           # toolbar-icon popup: connect flow + settings
├── icons/
└── tests/                           # node --test unit tests — no real browser/network/DB required; see each file's header

measure.html / measure.js / measure.css   # the hosted workspace itself (repo root — served by this site, not the extension)
```

## Running the extension's tests

```
node --test extension/tests/*.test.cjs extension/tests/*.test.mjs
```

All of them are unit tests against plain Node — no Chrome, no network, no
database. They cover: the config.js parser (no `eval`/`new Function`, even
against a deliberately malicious payload), the measurement bridge's
origin/payload/dedupe validation and its use of the real `geometry.js`, the
background worker's request-bridging security checks (wrong tab, spoofed
origin, expiry, duplicate Finish, allowlist rejection, and surviving a
simulated service-worker restart via `chrome.storage.session`), and
idempotent/business-bound quote-draft creation.
