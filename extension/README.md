# TurnKey — Google Earth Instant Quote (Chrome extension)

A Manifest V3 Chrome extension that overlays a TurnKey quoting toolbar on
[Google Earth](https://earth.google.com), lets an operator trace a property's
driveway/roof/house/fence on a real geo-anchored map, prices it with the
business's own TurnKey rates, and creates the quote directly in TurnKey —
without leaving the browser tab.

It's a working prototype, not a mockup: every screen writes to and reads from
the real TurnKey Supabase project (`customers`, `quotes`, `jobs`,
`activity_log`, `attachments`), reuses TurnKey's actual pricing engine
byte-for-byte, and authenticates with the operator's real TurnKey login.

## Install (unpacked, for development)

1. `chrome://extensions` → enable **Developer mode** (top right).
2. **Load unpacked** → select this `extension/` folder.
3. Click the TurnKey icon in the toolbar → enter your TurnKey site's URL
   (the same address you use to log into the CRM, e.g.
   `https://yourbusiness.netlify.app`) → **Continue** → sign in with your
   normal TurnKey email/password.
4. Open [earth.google.com](https://earth.google.com), search for a property,
   and the TurnKey toolbar appears in the top-right.

The extension reads its Supabase connection details from your TurnKey site's
own public `config.js` at connect time (the same file `index.html`/
`booking.html`/`quote.html` already load) rather than shipping any
business's credentials inside the extension — see `api/turnkey-api.js`'s
`fetchSiteConfig()`. Nothing beyond the anon key and site URL (both already
public, by the app's own design — see the header comment in `config.js`) is
ever stored.

## How it reuses TurnKey rather than duplicating it

| Concern | Extension behaviour |
|---|---|
| Auth | Signs in via Supabase's password grant — the same call `index.html`'s `sb.auth.signInWithPassword()` makes. RLS (`current_business_id()`) scopes every read/write to the operator's own business automatically; no new auth system. |
| Pricing | `vendor/pricing-engine.js` is a byte-for-byte copy of the repo root's `pricing-engine.js` — the exact `TK_PRICING.SERVICES`/`quoteTotal()`/`gstFromInclusive()` every other TurnKey page uses. A quote priced here matches a quote priced in the CRM. |
| Customers/leads | Writes to `public.customers` with `source: 'Google Earth Extension'` — same table, same shape `index.html` writes. |
| Quotes | Writes `public.quotes` + `public.jobs` (with `details.areaPolys`/`details.services`) using the exact two-step pattern `index.html`'s `syncRecordToSupabase()` uses — no new tables, no new RPC. |
| Measurements | Stored as `job.details.areaPolys` — the same array shape (`{id, service, size, unit, points, geoPts}`) `booking.html`'s map-drawing tool already produces and `map-snapshot.js` already knows how to render. A quote built here shows up correctly in the CRM's existing property-map UI with zero CRM changes. |
| Screenshots | Uploaded to the same private `turnkey-uploads` bucket, same `{business_id}/quote_attachment/...` path convention, same `attachments` table `uploadAttachment()` uses in `index.html`. |
| Design | `content/panel/panel.css` copies `index.html`'s `:root` CSS variables verbatim (there's no shared theme file in this no-build-step codebase to import instead). |

No new database tables or columns were added for this feature.

## Known limitations (read before assuming full parity with the brief)

**Google Earth's 3D view can't be measured directly, and this is investigated,
not assumed.** Earth Web renders through a proprietary WebGL globe with no
public JS API for reading camera state, terrain elevation, or converting a
screen click into a real coordinate — there is nothing a content script can
hook into for that. The one thing Earth's page does expose is its own URL,
which encodes the camera's look-at point as the operator flies/searches
(`@lat,lng,...`); the extension reads that to know roughly where the
property is.

Rather than fake per-pixel accuracy on a tilted 3D view, **"Measure" opens a
small top-down tile view inside the TurnKey panel**, anchored at that
location, using the exact same technique `booking.html`'s own property-outline
tool already uses and TurnKey already trusts for real quotes: a Web Mercator
tile mosaic at a known zoom level (where meters-per-pixel is exact, unlike a
perspective 3D view) plus a local flat-earth projection for each traced
point (`content/panel/measurement.js` — see its header comment for the full
reasoning). Google Earth itself is never touched — panning/zooming/rotating/
searching all keep working exactly as normal, since the tracer is a separate
surface, not an overlay drawn onto Earth's own canvas.

Trade-off this creates: the trace happens on a flat top-down map, not on
Earth's cinematic 3D view, so there are two "map" experiences in the flow —
Earth for finding/orienting the property, the TurnKey tile view for actually
tracing it. That's a deliberate, disclosed choice, not an oversight; building
a second, less-accurate "click on the tilted 3D globe" measurement engine
would have been strictly worse and would have duplicated logic that already
exists correctly elsewhere in this codebase.

**Tile images use the free OpenStreetMap tile server, not Google's satellite
imagery**, so the extension needs no separate Maps API key of its own (avoids
having to manage a key/referrer-restriction inside an unpacked extension
bundle). If a business's TurnKey deployment has a Google Maps key configured,
a future pass could offer Static Maps satellite imagery here as well — not
done in this prototype.

**Page CSP risk, flagged rather than silently ignored:** the tracer's tile
images are inserted into Google Earth's own page DOM from a content script.
Modern Chrome generally exempts content-script-initiated resource loads from
the host page's Content-Security-Policy, but this hasn't been verified
against Earth's live, current CSP in an actual browser session (not
available in the environment this was built in). `measurement.js` detects
the failure case (every tile image erroring out) and shows a clear in-panel
message rather than a silently blank map — see `tk-tracer-tilefail` — but if
you hit this in testing, the fix is to move the tracer into a dedicated
extension popup window (`chrome.windows.create`) instead of the in-page
shadow DOM, since extension pages aren't subject to the host page's CSP at
all. The tracer/quote functions are already written as plain `(container,
ctx, actions)` renderers with no dependency on being inside a content
script, so that move is a plumbing change, not a rewrite.

**Screenshots capture the whole visible tab, not a pixel-composited
image.** `chrome.tabs.captureVisibleTab` is used (Chrome's own sanctioned
screenshot API) rather than drawing the OSM tile pixels onto an offscreen
`<canvas>` — `toDataURL()`/`toBlob()` on cross-origin tile images would taint
the canvas unless OpenStreetMap's tile server reliably sends
cross-origin-readable CORS headers for programmatic reproduction, which its
usage policy doesn't commit to. `captureVisibleTab` still captures the
TurnKey measurement overlay when the tracer is open, since that's real
on-screen DOM — see `content/panel/screenshot.js`'s header comment.

**Address detection is a best-effort guess, always editable.** Earth's URL
sometimes contains a `/search/<slug>/` segment reflecting the last search
query — that's decoded into the Property field as a starting point, but it's
just as often a place name, not a postal address, so it's never treated as
authoritative and the field is a plain editable text input (per the brief's
own §8 instruction not to build fragile scraping logic).

**Default measurement unit (m² vs ft², in the popup's Settings) is stored
but not yet wired into the pricing/measurement math** — TurnKey's rates are
all defined per-m² (`pricing-engine.js`), so converting the whole quoting
flow to imperial would mean reworking that shared rate model, not just a
display format. The toggle is present per the brief's settings list, but is
a placeholder for a real unit-conversion pass rather than functional today —
flagged here rather than left to be discovered by using it.

**"Create Quote" does not send an email.** It creates a real `quotes` row
(with a working `public_token` share link — the same link `quote.html`
resolves) and a real `jobs` row, exactly as if the operator had built and
"sent" the quote in the CRM's own Quote Builder — but it deliberately does
not call the CRM's `generateAndSendDoc()`/email-template/Gmail-connection
path, since that's a heavier operation this extension has no reason to
duplicate. "Copy Quote Link" / "Open in TurnKey" (shown on the confirmation
screen) are how the operator actually gets it to the customer.

## Structure

```
extension/
├── manifest.json
├── background/service-worker.js   # only job: chrome.tabs.captureVisibleTab (content scripts can't call it)
├── content/
│   ├── content.js                 # detects earth.google.com, mounts a Shadow DOM root, dynamic-imports the panel
│   └── panel/
│       ├── app.js                 # orchestrator: state, Earth URL polling, wiring
│       ├── toolbar.js             # the floating draggable/minimizable toolbar
│       ├── measurement.js         # geo-accurate tracer (area/distance) — see its header comment
│       ├── quote.js               # Instant Quote panel + "Quote Created" screen
│       └── screenshot.js          # capture + preview
├── api/
│   ├── turnkey-api.js             # hand-rolled Supabase REST client (same pattern quote.html already uses)
│   └── storage.js                 # chrome.storage.local wrapper shared by the popup and the panel
├── vendor/
│   └── pricing-engine.js          # byte-for-byte copy of /pricing-engine.js — see its header for why
├── popup/                         # toolbar-icon popup: connect flow + settings (brief §19-20)
└── icons/                         # resized from the repo's existing icon-512.png — no new brand assets
```
