# New-lead welcome messages

Local feature, off by default. No messages have been sent or historical leads queued.

## Behaviour

Settings → New lead welcome message lets an owner/manager select SMS or email, eligible intake sources, wording, and an Instagram/video HTTPS link. The current default is https://www.instagram.com/novaexterior/. The message supports `{customer_name}`, `{business_name}`, `{trust_link}`. Videos are linked, not attached or embedded in SMS.

Choose explicit channel consent (default), or enquiry recipients only when the business has documented permission to send this message. Accepting general terms is not treated as SMS consent. Explicit consent uses boolean `smsConsent`/`emailConsent` on the lead or customer payload, or exact form answers labelled SMS/Text consent or Email consent. A form that does not collect these answers will be skipped in explicit mode. Customer-level automatic-message opt-outs are respected.

The queue starts at lead insertion while enabled. It never backfills existing rows, excludes marked historical imports, and rejects submissions older than an hour at arrival. Outbox messages expire after 24 hours. Wix/Meta retries reuse the existing lead and cannot queue a second welcome. Booking widget submissions map to Booking. Manual refers to the backend lead-intake API, not customers created directly in the CRM.

Provider acceptance is shown as **accepted**, not proof of delivery. Unknown outcomes are held for inspection and never automatically resent. Do not resend an unknown result without checking the provider/mailbox first. Disabling the feature skips queued messages; an already submitted provider request cannot be recalled.

## Release

1. Apply `supabase/migrations/20261120223607_lead_welcome_messages.sql` before deploying the backend. It adds backend-only settings, outbox and suppression tables, an insert trigger, and an atomic queue claim function. Existing customer/job/quote rows are unchanged.
2. Deploy matching backend and frontend commits. The backend processes the durable queue every 15 seconds while running; no open CRM tab is required. A sleeping Render Free service can delay processing until it wakes. A database trigger queues work but does not wake Render itself.
3. Configure one delivery channel below, then save and enable it in Settings. Saving settings does not send a test or bulk message. Verify with a specifically consented synthetic lead; no live test was performed during implementation.

## SMS — requires an SMS provider

The current adapter is Twilio, scoped to one explicitly configured TurnKey business. No Twilio account has been created or paid service enabled for you.

Create a Twilio account, set up a Messaging Service with a suitable SMS sender for New Zealand, enable/configure its opt-out handling and verify STOP handling. Confirm NZ destination permissions and account/trial restrictions in Twilio. Only then set these **Render backend environment values**, keeping credentials private:

- `TWILIO_ACCOUNT_SID` — the Account SID (`AC…`).
- `TWILIO_AUTH_TOKEN` — the private Twilio auth token.
- `TWILIO_MESSAGING_SERVICE_SID` — the configured Messaging Service (`MG…`).
- `TWILIO_BUSINESS_ID` — the exact TurnKey company ID allowed to use this sender.
- `TWILIO_OPT_OUT_READY=true` — set only after opt-out handling is configured and tested.

SMS supports NZ mobile numbers; `021…` becomes `+6421…`. Landlines and other countries are excluded. The server adds “Reply STOP to opt out.” Twilio handles suppression for that Messaging Service. Long/Unicode messages may cost multiple segments. Charges and sender availability depend on the provider; no price is assumed.

Official references: [Twilio Messages](https://www.twilio.com/docs/messaging/api/message-resource), [New Zealand SMS guidelines](https://www.twilio.com/en-us/guidelines/nz/sms).

## Email — existing connected Gmail

Connect Gmail for the owner/manager who saves the settings, select Email, review wording/recipient rules, then enable. No SMTP account or Twilio subscription is needed for this channel.

Set `PUBLIC_BACKEND_URL` to the public backend origin if different from `https://turnkeynova.onrender.com`. Optional `LEAD_WELCOME_UNSUBSCRIBE_SECRET` provides a dedicated signing key; otherwise the existing backend service-role secret signs unsubscribe URLs. Secrets remain server-side. Emails include an unsubscribe link with a confirmation page to prevent link-preview scanners from unsubscribing customers accidentally.

Gmail sends appear in the connected mailbox and are picked up by existing email synchronisation. The welcome outcomes list records provider acceptance immediately. Delivery, open tracking, SMS replies and video analytics are not added by this feature.

## Focused validation

`node --test backend/src/leadWelcome.test.js tests/lead-welcome.test.cjs`

Covers migration repeatability and service-role grants, durable queue claims, duplicate prevention, historical exclusion, consent, tenant isolation, NZ numbers, provider failures, email/sender selection and configuration UI. Browser checks exercise the settings form without sending real messages.
