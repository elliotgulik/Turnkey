# Follow-up history and customer-facing window quantities

Release includes the previously local automatic follow-up settings and import-date analytics correction.

- Owner/manager-only Sent follow-ups button opens paginated automatic-send history with delivery status, customer, sent time, message and associated replies. Reply pagination is independent. History is company-scoped and excludes unrelated mailbox threads. Existing legacy drafts are recovered through their deterministic IDs.
- Preserve the opportunity ID when a follow-up draft is claimed for sending. Existing checks refresh Gmail and stop further steps after a received customer reply, including unlinked replies matched to the sender address. Customer opt-outs, closed/cancelled/accepted quotes and disabled settings also stop eligibility.
- Customer-facing PDF/HTML/email and public quote descriptions hide windows pane counts/unit rates. Internal counts and pricing data remain unchanged.

The planned enabled default is two steps, 2 and 5 days after quote sent, using the saving owner/manager's Gmail account. Only quotes sent after activation are eligible. No historic backlog is enrolled. Account activation is verified separately through the app after deployment; source code alone is not evidence of enabled live settings.

Backend history/reply checks: 114 sales-platform tests passed. Parent verified window display/public amounts and follow-up settings/safety tests, plus static build and whitespace checks. No synthetic customer email is sent as part of verification.
