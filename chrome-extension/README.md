# TurnKey measurement import (Chrome MV3)

A small, local, user-controlled import bridge for **your own exported KML or
GeoJSON**. It imports individual polygons and paths, not all Google Earth data.
It does not scrape Google Earth imagery, tiles, DOM, accounts, or other tabs.
No server requests, background worker, storage, telemetry, or build step.

## Install unpacked

1. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select this `chrome-extension/` directory.
2. Open/reload `https://turnkeycrm.net/` or your localhost app after installing.
   Only the exact production hostname over HTTPS (default port) and HTTP/HTTPS
   `localhost` (any port) are allowed. Subdomains, IP literals, and other sites
   are excluded.
3. Click the extension, choose a `.kml`, `.geojson`, or `.json` file you exported.
4. Review every outline and expandable coordinate list. Explicitly enter the
   service name/ID for each geometry and select metres/feet or square metres/feet.
   These are identifiers for the parent receiver to resolve, not a claimed
   catalogue of existing TurnKey services.
5. With the intended TurnKey tab active, click **Send to active TurnKey tab**.
   Nothing is sent just by opening a file. Closing the popup discards its state.

The confirmation means the page message was dispatched, **not** that TurnKey
accepted it or saved a quote. The parent task must implement the receiver.
No existing app files are changed by this extension.

## Supported data and limits

- WGS84 `[longitude, latitude]` Polygon and LineString only. GeoJSON geometry,
  Feature, or FeatureCollection; KML individual polygons/paths in ordinary
  document/folder/placemark containers, including namespace prefixes.
- Polygon outer ring and holes; closed rings required. Altitude is validated
  if supplied, then discarded. Metadata, names, descriptions, filenames, and
  arbitrary properties never enter the wire payload.
- Maximum 1 MiB input, 50 geometries, 10,000 total coordinates, 100 rings per
  polygon; KML depth 64 and 20,000 elements. Finite numeric longitude ±180 and
  latitude ±90 required. Unsupported geometry rejects the entire import.
- Narrow KML subset: no KMZ, DTD/entities, NetworkLink, MultiGeometry, tracks,
  models, points, CDATA coordinate blocks, or remote references. Export
  individual polygons or paths, or convert your own data to GeoJSON first.
- Length uses haversine great-circle segments; area uses a spherical ring
  integral, subtracting holes, with mean Earth radius 6,371,008.8 m. Units are
  explicit; calculation values remain unrounded on the wire.
- Ground estimates exclude slope, elevation, roof pitch, obstructions, and
  surface condition. Area assumes ordinary simple rings with correctly nested
  holes. This is not a topology validator or survey tool: self intersections,
  overlapping/outside holes, polar/global shapes require correction upstream.
  Check antimeridian shapes using coordinates; the schematic is not a map and
  scales axes independently. Receiver/user should reject implausible job sizes.

## App receiver protocol (version 1)

The isolated content script accepts only this extension's popup message,
validates and recomputes measurements, strips unknown fields, then emits:

```js
window.postMessage({
  type: 'TK_MEASUREMENT_IMPORT',
  payload: {
    version: 1,
    measurements: [{
      service: 'driveway', // explicit user name/ID, 1–80 letters/digits/spaces/_/-
      kind: 'area',       // 'area' | 'length'
      unit: 'm2',         // area: m2 | ft2; length: m | ft
      value: 123.45,      // finite, positive, recalculated in selected unit
      geometry: {
        type: 'Polygon', // or LineString with one coordinate sequence
        coordinates: [[[174.0, -36.0], /* ... closed ring ... */]]
      }
    }]
  }
}, location.origin);
```

Example receiving boundary (integration deliberately not installed):

```js
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.type !== 'TK_MEASUREMENT_IMPORT') return;
  // Validate version/limits/coordinates/units and recalculate independently.
  // Resolve service against the current business catalogue; show a review UI.
  // Require user confirmation before applying measurements to the active quote.
});
```

Page messages are **untrusted input**, not extension-authenticated commands:
other same-origin scripts can emit the same protocol. Do not treat a message as
permission to save, charge, or choose a quote. Reject unknown versions and
services; never render incoming service text as HTML. There is no receiver ACK
or quote mutation in this protocol. The content-script response
`{dispatched:true}` is internal to the extension only.

## Tests

From the repo root: `node --test chrome-extension/tests/*.test.js`
(or `npm test --prefix chrome-extension`). No dependencies required.

Covers analytic length/area, antimeridian distance, holes/winding, GeoJSON
metadata/altitude stripping, KML namespaces and polygons/paths, invalid bounds,
unsupported/malformed input, size/count limits, and wire validation/tampering.

Manual Chrome checks before release: load unpacked; import both formats; inspect
coordinates and unit changes; confirm no send until clicked; try missing service,
an unrelated tab and a permitted localhost tab; inspect the page message with a
receiver; confirm the popup reports dispatch without claiming quote persistence.
Automated tests cover pure logic, not Chrome UI/permissions or live integration.
