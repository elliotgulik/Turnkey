# Mobile and customer workflow release

Status: completed local patch, pending preview approval and deployment. No ad requested.

## Changes
- Mobile bottom navigation prioritises Leads, Pipeline, Calendar, Inbox and More with safe-area spacing.
- Persistent browser-local per-user/per-business NEW, read and unread state; three-day alert lifetime remains separate.
- Wix multi-select service and urgency normalization; ASAP grading excludes a single-service enquiry explicitly outside the preferred North Shore/Central area. Unknown locations are not assumed outside.
- Routine notification/push events are suppressed; replies/questions, acceptance and payments remain. Quote public-link views are displayed in customer Quotes history.
- Exact generated PDF preview/download reuse the attachment bytes. The draft-preparation race is fixed; clean drafts are not repeatedly saved.
- Email font choices (Arial, Georgia, System) persist and produce safely escaped HTML plus a plain-text alternative.
- Customer Conversations uses the current user's connected Gmail account, tenant guards and text-only rendering; covers the latest 500 synced mailbox messages.
- Existing invoice PDF/composer flow remains available, with a customer-profile Create invoice action for completed/paid jobs with saved service lines.
- Optional explanation text moves into keyboard-accessible question-mark popovers; errors and warnings stay visible.
- Extension 0.2.11 closes the measuring tab and focuses Earth only after successful measurement acceptance.
- Direct edited area/perimeter line prices automatically provide advisory learning by comparable service, storeys and access. Excluded discounts/extra work and accepted quotes remain protected.
- Full ServiceM8 import queues durably, imports supported active statuses and keeps subsequent reconciliation in full mode. Stable IDs and uniqueness prevent duplicates. Ambiguous identities are skipped and reported.
- Analytics uses current verified linked ServiceM8 totals, including zero, without overwriting accepted quotes or implying unknown GST/costs. Unknown historical dates remain unknown.

## Verification
Focused mobile/read-state fixtures passed at 1440, 390 and 360 pixels. Wix, notification policy, email routes, full-import/analytics, learning and extension tests passed. The assembled Conversations check now passes, including the former attachment-persistence failure. Static build, syntax, shared-engine ZIP and whitespace checks passed. No real customer emails or ServiceM8 jobs were created during checks.

## Release steps
1. Review http://127.0.0.1:8877/demo and approve publication.
2. Push the release to main; verify the matching Netlify and Render deployments.
3. Use Connections → ServiceM8 → Full import from ServiceM8 (owner/manager). The first full import has NOT been queued against production.
4. Check completed import counts and any skipped identity warnings. Do not delete existing CRM data to reset analytics.
5. Install /assets/turnkey-earth-extension-0.2.11.zip in Chrome and refresh Earth and TurnKey.

No new migration or credentials are required. Actual provider sending latency, production import completion and real-device/browser extension behavior remain live verification steps. PDFs attached only by a previously saved attachment ID do not yet expose preview bytes in the composer; newly generated quote/invoice PDFs do. Read/unread state is not yet synchronized between devices. Public quote views do not prove a PDF attachment or email was opened.
