# Mobile calendar and duplicate-intake pass — 3 November 2026

Prepared locally after release 5548e09; visual review is required before push.

## Mobile calendar

- Timetable appears before the job list. The latter collapses on phones.
- A new phone session starts in Day; saved Month/Week/Day/List preferences restore.
- Larger navigation and booking controls, readable date heading and staff chips.
- Connections/legend details are available without dominating the schedule.
- Search now also filters ServiceM8 bookings by customer, address, service or crew.
- Tap a date number in Month to open that day's schedule. Week uses readable
  columns with scrolling confined to the timetable and an explicit hint.
- Touch dragging uses a 650ms hold; short events retain a 32px minimum height.
- Booking dialogs have readable mobile form text, wrapping fields and sticky
  actions. Other mobile form text is at least 16px to avoid focus zoom.

## Duplicate leads

Read-only production audit: 832 unarchived job records, zero repeated ServiceM8
job UUIDs, and two repeated provider-submission groups. One Wix group has a saved
quoted record and a zero-value copy; the other is a repeated Meta test submission.

The shared lead-identity helper selects a representative for proven repeated
intake in hydrated/cached UI data and analytics, preferring saved quotes, linked
jobs and populated records. It does not delete, merge, archive or relink database
rows. Existing duplicate copies remain recoverable in the database.

Incoming submissions now carry their provider ID before rendering/saving and
return the actual created record. Redelivery uses that identity, rather than a
numeric UI ID or timestamp. Legacy queued submissions without an external ID use
their stable intake-row ID. Ambiguous matches are not acknowledged as resolved.

Different submissions, distinct ServiceM8 jobs and independently developed
quotes remain separate, even with the same contact details. Records without a
reliable ID are retained. Existing database-backed intake uniqueness/claim rules
remain unchanged; this is not a new global customer-contact uniqueness rule.

## Verification

- Real FullCalendar 6.1.15 booking/navigation regression passed, with intercepted
  traffic; phone disclosures are explicitly exercised.
- Eleven identity/intake/hydration tests and four selected analytics tests passed.
- Two bounded visual rounds across 1440/390/360px: Leads, Pipeline, customer detail,
  Settings, Inbox, Calendar and calendar Day/Week/Month/booking dialog. No page or
  visible-button overflow on phones, and no captured browser errors.
- Build and changed-script syntax/whitespace checks passed. No live booking or
  customer-email writes were performed; the data audit was read-only.
