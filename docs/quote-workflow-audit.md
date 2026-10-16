# Quote workflow audit — measurement import

Snapshot of what the quote-builder measurement import actually does today
(`measurement-import.js` + `chrome-extension/`), not an aspirational spec.
See `chrome-extension/README.md` for the full protocol and size/format limits.

## Measurements are manual, not automatic

There is no automatic property-boundary or roof/driveway detection anywhere
in this app. Every outline comes from one of two manual sources:

- Hand-drawing in the quote map editor, or
- Importing a file the operator already exported themselves from a mapping
  tool (Google Earth, My Maps, GPS software, etc.) as `.kml`/`.geojson`/`.json`,
  using the separate `chrome-extension/` popup.

The extension only parses a local file the user picked and only runs when
the TurnKey tab is active; it does not read Google Earth/Maps tab content,
call any Google or TurnKey API, or send anything until the user clicks
"Send". No claim is made here about Google's own terms for exporting your
own data — that's between the operator and Google; this app only consumes
whatever file they hand it.

Both paths produce a geodesic length/area calculated from straight-line
coordinates. That number **excludes** roof pitch, slope, obstructions and
surface condition — it is a flat ground measurement, not a survey, and the
import review dialog says so every time.

## Sizing/coordinate sanity limits

The receiver now rejects measurements above 50,000 m² (area) or 5,000 m
(length) per imported geometry — generous enough for a large commercial job,
but no longer the previous 100 ha / 100 km ceiling, which would have let an
accidental city-block-scale draw through unflagged. Coordinates are bounds-
checked (±180°/±90°) and re-derived from the geometry by both the extension
and the receiver independently; the imported unit is always normalized to
the service's own unit (m or m²), never the sender's chosen display unit.

One real protocol gap worth knowing about: a service measured by perimeter
on a closed building footprint (`housewash`, unit `m`) can only be imported
as a `LineString` path traced around the building, not as a closed `Polygon`
— the extension only offers area units for polygons, so there's currently no
way to import a perimeter measurement from a traced outline without manually
re-drawing it as a path.

## Accepted-quote lock

`quote-workspace.js`'s own lock (`isWon(r) || r.quoteStatus === 'accepted'`)
is now mirrored exactly in the import receiver, both on receipt and again
right before the "Add to this quote" button applies anything (session state
is re-checked a second time in case the active lead, business or overlay
changed while the review dialog was open). Before this pass, the receiver
only checked `isWon`, so a quote the customer had already accepted — but
that staff hadn't yet marked "won" — could still have measurements appended.

Cancelling the review dialog, switching leads, or closing the quote overlay
while it's open discards the import; nothing is written to the record until
"Add to this quote" is clicked under the original session.

## Roles and persistence

Quote editing uses the existing authenticated business context and database
policies. Integration configuration and handoff endpoints additionally require
owner/manager access; the importer does not grant additional permissions.

Imported outlines are added to the current in-memory record after review.
They then follow the existing local persistence and Supabase synchronization
flow; another save/render may persist them before the quote is sent. Importing
alone does not send a customer email or enqueue a ServiceM8 handoff. Use the
explicit quote-preview or ServiceM8 transfer action after checking quantities.
