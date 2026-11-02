# Customer controls fixes — 3 November 2026

- Follow-up opt-out persists on the shared customer. Lead Manager now honours it
  in overdue indicators and hides scheduling actions; the pipeline detail date
  field/status updates without discarding unsaved notes. Saves verify the returned
  preference and have a bounded timeout. Automatic follow-up email remains paused.
- Customer Conversations is reachable from the pipeline customer action and the
  lead panel. The profile history includes the active user's own Gmail account,
  exact customer/email matches and messages in those threads. Existing inbox
  thread/compose controls are reused. Opening a thread refreshes saved mailbox
  data, not Gmail synchronization. History currently covers the latest 500 synced
  mailbox messages, explicitly labelled when that limit is reached.
- The live read-only audit found 19 jobs attached to blank-name profiles. Bulk
  autosave now skips incomplete profiles instead of repeatedly reporting those
  as connection failures. Genuine write failures remain visible. The job record
  shows a repair message, and a confirmed contact edit clears its incomplete flag
  while preserving its customer/job IDs. Those 19 missing identities have not
  been invented, deleted or automatically recovered in this patch.

Focused mocked checks cover follow-up off/on and reopening at desktop/mobile,
customer-history ownership and thread navigation, incomplete autosave isolation,
and confirmed contact repair. No real emails or customer-preference changes were
performed during testing. No schema change is required.
