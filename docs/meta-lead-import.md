# Existing Meta lead import

Connections → Meta → **Import existing leads** reads the connected Page's available forms and each form's lead pages. It uses the authenticated business's saved Page mapping and encrypted credential; no Page or business supplied by the browser is trusted.

- Each request imports at most 25 leads through the existing `storage.addLead` intake. Existing database `(business_id, source, external_id)` uniqueness makes webhook/import overlap and retries safe.
- Continuations are encrypted/authenticated with the existing backend token-encryption mechanism, bound to the business and Page, and valid for 24 hours. No credential is returned to the browser.
- Historical enquiry dates are preserved. Historical imports do not send the automatic new-lead customer email or owner email; the normal durable pending/ack flow adds them to Leads.
- Keep the app open until completion. If interrupted, start again: already-stored leads are skipped. Only leads still available through Meta and the account's granted permissions can be recovered.
- Expired/revoked credentials or denied permissions stop the import with an error. A partial failed batch can safely be retried. No success is reported for failed durable storage.

No new database migration or credential rotation is required for the import feature. Deploy the backend and frontend together. A valid Page token with lead access is required to run it.

## Token lifetime

Meta's official documentation states that default User and Page tokens are short-lived. Exchange a fresh User token for a long-lived User token server-side, then retrieve the Page token using that long-lived User token. Long-lived Page tokens have no scheduled expiration date but can still be invalidated. Existing expired tokens cannot be extended.

Source: https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived

Never paste tokens into chat or repository files. Enter replacement credentials only into the secure Connections form. Token lifetime conversion is not automatically performed by the current Page-token connection endpoint.
