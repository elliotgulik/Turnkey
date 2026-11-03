# Pipeline, Dashboard and lead-alert usability

3 November 2026. Local changes only; no push or deployment.

- Pipeline list shows one selected stage at a time. Stage tabs switch the section
  directly; Completed/Cancelled remain available under Past jobs.
- Long sections show ten records per page with Previous/Next. Filters, original
  stage identities, totals, stage changes and the Board view remain available.
- Dashboard restores its metrics-first layout. Urgent/new/overdue/accepted-unscheduled
  records are accessible in a collapsed Urgent & next actions disclosure.
- Opening an individual alert removes it from the unread list and badges. Clear all
  marks only current recent unread alerts read. No customer/lead records are deleted.
  Merely opening the bell does not mark everything read. Read state remains scoped
  to business and signed-in user, and the existing three-day alert window remains.
- Automatic follow-up sending remains disabled.

Verification: 17 focused unit tests passed. Isolated synthetic browser checks passed
at 1440px and 390px for section switching, pagination, keyboard navigation, completed
jobs, urgent disclosure, individual alert opening and Clear all. No runtime errors
or document-width overflow were observed. Static build and syntax/diff checks passed.
No production customer records or provider credentials were used.

Analytics files are deliberately excluded from this patch. Cursor's uncommitted
metrics changes remain available for its separate review; no production-metric
accuracy claim is made by this UI verification.
