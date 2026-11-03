# Account and sign-in audit — 3 November 2026

Local fixes only. No production account, password, token, email, schema or deployment changes.

## Fixed

- Late startup session results cannot resurrect an older account after a newer auth event. A null initial session reliably reveals sign-in instead of leaving the loading overlay open.
- Signing out of recovery clears recovery mode; subsequent staff/owner sign-ins can initialize normally.
- Company settings, staff/invites, Gmail status, calendar connections/bookings, email templates, inbox results and notification preferences ignore obsolete account responses. Account changes clear connection/template/inbox state. Default templates cannot be seeded into a newly selected company by an old lookup.
- Gmail status is explicitly scoped by company and user. Missing business profiles are provisioned only for owners, not staff during sign-in.
- MFA operations invalidate obsolete challenges/dialogs and ignore late verification results; abandoned enrollment cleanup allows a retry.
- Dedicated and inline password recovery ignore late results after an account/session change. Ordinary sessions cannot use the dedicated reset form without a recovery event or matching recovery marker.
- Backend session middleware rejects unusable company profiles and returns a controlled 503 when auth/profile services throw.
- Email customer/quote/invoice references are validated against the current company before provider calls. Payment invoice references are validated first and updates include the company filter.

## Evidence

- 53 focused frontend account/auth/MFA/recovery/session tests passed.
- 33 focused backend account/reference/invitation tests passed, including staff/manager/owner requests, stale membership, spoofed company identifiers, foreign/consumed invitations and existing-staff role preservation.
- Mocked password-reset browser flow passed: request, redirect, password matching, success, expiry, ordinary-session guard, mobile overflow and failure retry. No real emails or passwords used.
- Broad backend run: 481/482 passed; only failure was sandbox denial of a local test server. Its isolated 18-test suite passed outside the sandbox.
- Broad frontend run preceded the final integration fixes: 282/295 passed; one fixture lacked the newly required account-clear helper, corrected and covered by the final focused suite; 12 browser-launch sandbox failures passed in the isolated permitted rerun. This is not a claim of a final all-suite run.
- Static production build passed (82 public assets); whitespace checks passed.

## Verification limits

Production RLS/grants, actual Luca/owner mail delivery, invited-user first sign-in and real-device session persistence still need live verification. Local tests do not prove production configuration. No personal account access was used. Cursor's metrics edits are separate and excluded from this audit.
