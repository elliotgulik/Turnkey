# Wix form webhook field contract

The webhook must send **the full submitted form values**, not only mapped
contact information. Name/email/phone alone cannot convey requested services,
window type, urgency, address, messages, cleaning frequency, referral answers,
consents or other custom questions. TurnKey cannot recover answers omitted by
the sender. The active NZ Nova Exterior automation was inspected on 3 November
2026. Its existing POST action sends **All automation data**, nested under
`data`, to the existing TurnKey Wix webhook. Its request preview exposes
`data.submissions` entries with `label` and `value`, plus `submissionId` and
`submissionTime`. The updated parser supports that exact envelope. No Wix
configuration, credentials or customer-email automations were changed. The
preview is Wix's sample schema, not proof of a fresh end-to-end delivery.

## Supported intake shapes

`POST /api/leads/wix/:token` accepts JSON with flat recognized customer/question
keys, or labelled answers in `submissions`, `fields` or `answers`. Those
containers can be arrays of `{ label, value }` / `{ label, answer }` /
`{ label, values }`, or maps from question/target to submitted value. Maps can
also contain `{ label, value }` field records keyed by an opaque field ID.
`name` and `key` are supported field-label fallbacks in arrays. Containers may
appear under nested `data`, `payload` and `submission` wrappers. A `contact`
object supplies fallback customer fields, including `name: { first, last }`.

Wix documents native submission maps keyed by field **targets**, with selected
values rather than option labels; multi-selects are arrays and addresses may be
objects. See [Wix submission values](https://dev.wix.com/docs/api-reference/crm/forms/form-submissions/about-submission-values).
TurnKey preserves scalar custom target answers in `formAnswers`, but cannot infer
what an opaque target or service ID means. Map opaque fields to a recognized
label, and send human-readable selected service names when needed. The parser
never looks up a form schema or resolves Wix service IDs remotely.

A synthetic example (all contact details are fake):

```json
{
  "data": {
    "submissionId": "unique-form-submission-id",
    "submissions": [
      { "label": "Full name", "value": "Avery Fixture" },
      { "label": "Email", "value": "avery@example.test" },
      { "label": "Phone", "value": "0210000003" },
      { "label": "Job Address", "value": {
        "addressLine": "12 Example Road", "addressLine2": "Unit 4",
        "city": "Auckland", "postalCode": "0000", "country": "NZ"
      } },
      { "label": "Select Services", "value": ["House Clean", "Roof Treatment"] },
      { "label": "Urgency", "value": "As soon as possible" },
      { "label": "Message", "value": "Please include the back steps." },
      { "label": "How'd you find us", "value": "Neighbour" },
      { "label": "Marketing consent", "value": false }
    ]
  }
}
```

Use the existing authorized webhook URL in Wix's HTTP request action, and pass
actual submitted dynamic values. A field label such as `Full name` is a question,
not its answer. Do not replace answers with static question text. Wix offers all
trigger data or a customized payload; check that a customized payload retains
every submitted question. See [Wix HTTP request action](https://support.wix.com/en/article/the-new-automation-builder-sending-data-via-webhook).

## Mapping and retention rules

- Labels match without case, spaces or punctuation. Name/full name/contact name/
  your name and first/last name aliases populate customer identity. Email/email
  address, phone/phone number/mobile number populate contact details. Submitted
  names and fields take precedence over fallback contact snapshots.
- Address/street address/property address/select an address/job address accept
  text or a structured address, including formatted/formattedAddress,
  addressLine/addressLine1, addressLine2, city, subdivision, postalCode and country.
  Separate streetNumber/streetName or streetAddress `{ number, name }` are joined.
  Supported components are rendered into both the customer address and answer
  text; arbitrary object contents are not serialized.
- Service/services/requested services/services required/select services/select
  services required and the existing service-question aliases accumulate all
  submitted selections. Arrays, repeated fields and comma/semicolon/newline
  lists work. An option `{ label: "House Clean", value: "choice-id" }` uses its
  selected display label. Field envelopes `{ label: "Select services", value: ... }`
  unwrap their answers. Offered options and explicitly unselected choices are
  excluded. Unknown questions never become services.
- Urgency/timing/timeframe and supported “how soon”, “when do you need” and
  “when would you like” questions populate both `urgency` and `customer.timing`.
  Nested `value`, `values` and `answer` envelopes are supported. Explicit urgency
  takes priority over timing aliases.
- Select Window Cleaning Type/window cleaning type/windowType can infer a window
  service when no explicit services exist: Both/Inside & Outside/Inside and
  Outside, Outside Only or Inside Only. The original answer remains in
  `formAnswers`. Explicit service selections retain precedence.
- `formAnswers` retains submitted labels and normalized answer text in encounter
  order, including custom labelled questions, frequency, referrals, messages,
  numeric answers and booleans (`Checked`/`Unchecked`). It is not a raw JSON
  archive. Existing answer limits still apply: 100 scanned form entries across
  containers/flat fields, 4,000 characters per retained answer, bounded wrapper
  and answer depth. Services are limited to 100 entries of 500 characters.
  Unsupported arbitrary nested objects and nested arrays are ignored; custom
  structured fields should be sent as readable text. Flat transport payloads
  retain only recognized questions/consent aliases; put custom questions inside
  a labelled container to preserve them.
- Tokens, secrets, tenant IDs, contact IDs, metadata and offered-choice definitions
  are excluded from retained answers. Tenant selection always comes from the
  hashed webhook-token lookup, never a supplied business ID. Validation rejects
  missing names and malformed contact values before storage.
- Send a stable **submission** ID unique to each form submission. Explicit
  `submissionId`/`submission_id` outranks generic envelope IDs; nested
  `submission.id`/`submission._id` outranks an outer event ID. Generic wrapper
  `id`/`_id` remains a legacy fallback, so do not put reusable form/site IDs there.
  A contact's `id`/`_id` is never used as the dedupe ID. Missing IDs remain null;
  repeated deliveries then have no submission deduplication guarantee. Storage
  deduplication remains scoped to business, provider and external ID.

## Local verification

Run `node --test backend/src/wixLeads.test.js` from the repository root.
Fixtures use fake contacts and injected storage/source lookup; the existing
concurrency test uses a fake database client. The tests cover labelled arrays,
field/target maps, flat envelopes, nested aliases, structured addresses, all
selected services, window inference, original readable answers, unique submission
IDs, tenant isolation, validation and bounded scans. No real contact is created.
A successful local test does not prove the live Wix Automation sends all fields.
