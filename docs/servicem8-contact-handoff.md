# Contact details on quote transfer

Quote handoff reads the current customer profile using the job's business ID and customer ID. The frozen quote remains the source for commercial amounts, line items and its original PDF. Updating an operational email or phone does not rewrite accepted pricing.

A successful handoff fills the ServiceM8 client's name, address and billing address, plus explicit JOB and BILLING company/job contacts with name, email, phone and mobile. TurnKey currently has one primary customer contact; that person is used for both contact roles. The customer phone is also used as mobile when no separate mobile value exists. Missing TurnKey fields do not erase existing ServiceM8 contact data.

Existing contact mappings and uniquely identifiable active contacts are reused. Ambiguous multiple contacts produce an actionable failure instead of overwriting an arbitrary person or silently creating another contact. Retries keep the same remote identifiers, and contact permission/storage failures remain failed handoffs.

The queue identity includes a fingerprint of the current contact profile, so an explicit retransmission after a contact correction is processed even when the quote version is unchanged. This is transfer-time synchronisation, not a background overwrite of all historical ServiceM8 contacts.

The connected private API-key path needs no additional setup. New OAuth connections request `read_job_contacts` and `manage_job_contacts` as well as the existing customer-contact permissions. Existing OAuth connections lacking these permissions must reconnect before the contact handoff can succeed.

Official resource definitions: [Company contacts](https://developer.servicem8.com/reference/createcompanycontacts), [Job contacts](https://developer.servicem8.com/reference/createjobcontacts). Job-contact email/phone/mobile fields populate the corresponding job/billing contact fields used by ServiceM8.
