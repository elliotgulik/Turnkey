# Compact UI release notes

The user approved publishing this UI pass to main after reviewing the local preview. Deployment status must be verified separately.

Completed changes:
- Restore TurnKey's existing colours, typography and navigation icons.
- Replace oversized Lead Manager cards with compact, aligned customer rows.
- Keep search and recent/all scopes visible; group source, grade, area and sort filters.
- Put assignment, stage editing, follow-up preferences and notes in the customer drawer.
- Simplify pipeline cards to one next action, with secondary controls under Manage.
- Preserve original received timestamps, requested-service text and ServiceM8 prices.
- Keep automatic customer follow-ups disabled.

Verification: production-index interaction fixture passed at 1440, 390 and 360 pixels; static build and whitespace checks passed. Screenshot and interactive previews use synthetic customers. The local interactive preview blocks external requests and live writes.

Review: http://127.0.0.1:8877/demo (server must remain running).
Comparison images: http://127.0.0.1:8877/.
Preview-only server and screenshots are ignored under .local-ui-preview/ and excluded from deployment.

Separate limitation found during the previous preview: conversations-assembled-browser.cjs fails its draft attachment persistence assertion. No compose/send implementation was changed in this UI pass, and that issue is not claimed fixed. Calendar and Inbox were not redesigned in this revision.

Supplied designer bundle: 111 skills installed without overwrites. ServiceM8 reference informed compact layout and hierarchy; the rejected green palette was removed. Impeccable's CLI engine was unavailable, so no automated detector findings or persisted critique snapshot are claimed.
