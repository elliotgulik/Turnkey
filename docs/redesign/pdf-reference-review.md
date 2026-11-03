# PDF reference review

3 November 2026. Local review branch: codex/pdf-reference-redesign.
Reference: /Users/elliotgulik/Desktop/Turnkey redesign.pdf (six pages).

The supplied reference supersedes the previous CSS-only composition restriction.
Dashboard now opens with a real-data headline and actionable rows, followed by a
compact KPI band and sales reports. Pipeline defaults to grouped rows; Board,
stage controls, filters and past-job scopes remain available. Leads Manager has
a desktop list and selected-customer preview, with a detail sheet on smaller
screens. A/B/C/review grade row tints and badges remain explicit. Mobile navigation
is Today, Leads, Pipeline, Calendar, More; Conversations remains in More.

Existing data sources, quotation calculations, intake integrations, permissions
and automatic-email safeguards remain unchanged. Reference example customers,
financial totals, travel predictions and email-open claims are not production
facts and were not copied into live data.

Verification: 31 focused lead, pipeline, priority and tenant tests passed; syntax,
static asset build and diff checks passed. Six main-view captures at 1440 and
390px plus selected-lead captures showed no document-width overflow or uncaught
JavaScript errors. Desktop row selection and mobile detail opening were exercised;
four grade backgrounds were distinct. These checks used synthetic preview data,
not live provider connections. No backend changes or provider calls were made.

Preview: http://127.0.0.1:8879/demo (synthetic customers; writes disabled).
Screenshots: .design-shots/pdf-reference/.
The latest in-app review capture is .local-ui-preview/pdf-redesign-leads-review.png.

No push or deployment has been performed for this revision.
