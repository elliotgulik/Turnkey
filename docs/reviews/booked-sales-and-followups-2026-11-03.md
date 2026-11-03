# Booked-sales correction and automatic quote follow-ups

## Booked-sales investigation

Read-only production queries and a local replay of the company's current won/scheduled/completed jobs reproduced NZ$88,889.95 for the 30-day report. The sales_job_prepare database trigger stamps wonAt when historical jobs are inserted directly in a won stage. Import time was therefore being reported as a sale date. The first confirmed ServiceM8 subset accounted for NZ$83,934.95; the same issue also affected four generic/CSV imports. The current partial dated sum after both exclusions is NZ$2,694, with 126 jobs lacking an independently usable win date. This is not a certified reconciled revenue total: original sale dates need source evidence. No figures were hardcoded and no customer/job data was modified.

The shared metric now excludes insert-generated win stamps on imports, retains independently recorded approvals and later sale transitions, and parses legacy UTC database insertion timestamps consistently across browser timezones. Backend and browser hydration attach the authoritative database insertion timestamp. Existing historical jobs/prices remain intact. Dashboard and Analytics explain unknown-date coverage.

## Follow-up settings

Settings → Automatic quote follow-ups → Manage automatic follow-ups.

Owners/managers can save up to six steps, each with custom subject/body and days after quote sent. Placeholders: {customer_name}, {business_name}, {quote_link}. Enabling is explicit and applies only to quotes sent after activation; no historical backlog is sent. Sender is the saving owner/manager's connected Gmail account.

Durable tasks check customer opt-out, job/quote state, customer replies, sender membership and mailbox health before delivery. Repeated workers share a permanent send guard to prevent duplicate provider calls after ambiguous results. Unknown delivery requires review rather than blind resending. Replies or cancellation arriving after the final check can still overlap provider delivery. Existing legacy automatic email path stays disabled. Pricing updates preserve independently saved follow-up configuration using compare-and-swap.

Automatic scheduling runs in the backend, not the browser. Delivery depends on the backend running and Gmail access remaining valid; no exact send-time guarantee. No business was enabled and no customer email was sent during implementation. No new database migration is required by these changes; existing Conversations and durable-task tables are reused.

## Verification

- 73 focused frontend/shared tests passed.
- 131 backend tests passed (sales platform, Conversations, email sync).
- Follow-up editor browser tests cover desktop and mobile, error/retry, validation, retained drafts and company switching, using local mocks only.
- Production static build and whitespace checks pass.

Changes are saved locally for review. Production deployment and a real configured follow-up delivery have not been verified.
