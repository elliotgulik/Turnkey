# Ten additional bugs — 3 November 2026

Scope: ten independently evidenced functional defects beyond account/sign-in audit e977a86. Local code only; no live customer records, credentials, migrations, messages or deployments changed. Cursor metrics changes remain excluded.

| # | Bug and trigger | Fix | Regression evidence |
|---|---|---|---|
| 1 | Notification preferences always displayed success after database errors and could save only part of the selected settings. | One bulk upsert; show success only after confirmed returned rows; preserve local preferences on failure. | Failed write and bulk payload test in settings-save-audit. Bulk upsert uses the documented Supabase API. |
| 2 | A changed address/region retained its previous coordinates when geocoding returned no result, affecting travel estimates/location. | Clear old coordinates for changed addresses before geocoding; retain coordinates for unchanged addresses; ignore obsolete session results. | Changed address/region with null geocoder response and company-switch tests. |
| 3 | Switching companies during logo upload could attach the old company's logo URL to the newly active company. | Capture company scope before upload; stop after a scope change; persist against captured company. | Delayed upload completed after company switch performs no profile write. |
| 4 | Customer-note saves could leave the button disabled on network rejection and report success for an update that affected no record. | Catch rejections, restore button in finally, scope by company, require returned customer ID before local edits/activity. | Rejected request, missing returned row and valid confirmed save tests. |
| 5 | Lead Manager retained a previous company's filters/editor state, hiding valid leads in the next company. | Reset company-specific filters and open editor selection when business changes. | Company-switch regression in nova-lead-manager tests. |
| 6 | Commercial intake answers stored in normalized form answers/notes were ignored for property classification, grading and filters. | Read the explicit residential/commercial/property-type answers. | Commercial submitted-answer regression in nova-lead-manager tests. |
| 7 | An invalid preferred arrival date blocked valid fallback dates, breaking chronological sorting; timestamp zero was discarded. | Select the first valid timestamp instead of first truthy value. | Invalid-date fallback and timestamp-zero regression in lead-priority tests. |
| 8 | Opening an existing booking through the calendar API preselected today rather than the job's actual booked date. | Let the booking modal derive the saved date unless a reschedule date was explicitly supplied. | Existing versus explicit-date regression in calendar-operations-audit. |
| 9 | Overnight jobs disappeared from later days or from the whole visible fallback agenda when they started before the range. | Include a job on each day its interval overlaps, with an exclusive midnight end. | Overnight, range boundary, midnight and staff-filter regression. |
| 10 | Opening Completed before hydration attempted a ServiceM8 request without a ready signed-in business, causing unnecessary failures/loading. | Wait for ready company/user context before starting the request. | Unready, ready and signed-out context regression. |

Validation: 84 focused tests passed across settings, account hydration, authentication, recovery, leads, priority sorting, staff/calendar navigation and operations. Static build passed with 82 public assets. Whitespace check passed. No claim of production verification; this release has not been pushed.

Supabase bulk-upsert contract: https://supabase.com/docs/reference/javascript/upsert
