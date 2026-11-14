# Employee portal and Nova Exterior post-job checklist

This release is local until approved for deployment. It does not create staff accounts, change anyone's role, or send customer messages.

## Setup

Apply these migrations in timestamp order before deploying the matching backend/frontend:

1. `supabase/migrations/20261112235542_employee_post_job_checklist.sql`
2. `supabase/migrations/20261114060619_employee_portal_isolation.sql`

The first creates checklist settings, draft/audit storage, validated completion and technician completion protections. The second restricts employee access to private CRM data and exposes assigned work through the trusted backend. Existing owners/managers retain their company access. The Post Office keeps its separate workspace.

Deploy the matching Express backend to Render and static release to Netlify. The static build includes `employee.html`, both employee/checklist modules, their stylesheets, and the locally vendored QR library. No new provider credentials or paid services are required.

## Access

Company members with the existing `technician` role are redirected to `/employee.html` before the full CRM loads its records. Owners/managers keep the normal CRM; Settings → Job close-out includes an employee portal link for reviewing their own assigned work.

The portal shows assigned jobs, customer contact/address, services, crew names, work instructions, work-hour logging and job photos. It does not load sales, pricing/cost engines, quotes, invoices, mailbox, analytics or connection settings. Backend authorization and restrictive database policies enforce the boundary independently of the interface. A verified ServiceM8 staff identity mapping connects an employee's login to their dispatch assignments; names alone do not authorize access.

My Schedule has date navigation and a week selector. Assigned work is saved locally per employee/company/date after authenticated access, refreshed in the background while visible, and cleared on sign-out. Updates depend on the existing ServiceM8 sync; this release does not claim an instant push subscription.

## Checklist and hours

Open an assigned job and choose **Post-job checklist / complete job**. The employee must answer whether the customer was home and complete all four equipment/site checks. A customer walkthrough is required when the customer was home. A scanned review QR is optional and is never checked automatically. Upcoming-work and repeat-service questions can be recorded without blocking completion.

Progress saves locally and to the server. Opening the QR or logging hours preserves it. The completion record stores the authenticated employee, job, completion time and answers. Management can review saved responses in the job's checklist card. Repeated completion requests preserve the original audit rather than rewriting it.

For ServiceM8-linked jobs, field checklist completion is recorded in TurnKey; ServiceM8 remains authoritative for operational job status. Unlinked jobs can be completed atomically with the saved checklist.

Work-hour submission records the full shift and travel separately. Equipment runtime excludes travel, using the existing work-log system.

## Review QR

Settings → Job close-out → Post-job checklist controls the requirement and editable HTTPS review URL. Nova Exterior's initial link is seeded only when a value has not already been configured:

`https://g.page/r/CbDFAxFaaWMUEBM/review`

The QR is generated locally using MIT-licensed `qrcode-generator` 2.0.4. It uses the configured business logo when available and otherwise the business name. It does not send data to a QR-generation service.

## Verification

Focused unit, SQL/authorization and fixture browser checks cover validation, optional review, draft restoration, account isolation, hours and desktop/mobile layout. These checks do not complete real jobs or send real emails. Deployment still requires the migrations, matching backend/frontend releases and an authorized employee smoke check against the company's actual assignments.
