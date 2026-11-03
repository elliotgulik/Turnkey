# Local redesign implementation

## Step 4: stage rail skipped

The existing pipeline has New lead, Contacted, Quote sent, Quote confirmed and
Cancelled. Cancelled is an alternative outcome, not a later sequential stage.
The sales UI adds Completed while the core model groups scheduled/completed/paid
under won. These do not form a single ordered sequence. The brief explicitly
requires skipping the rail in this situation. No stage, grouping or label changed.

## Step 6: wording and behaviour preserved

Application JavaScript, event handlers, identifiers, pipeline logic and templates
are unchanged from fix/full-audit-2026-11. HTML changes add stylesheet links only
(and explicit head/body containers to the previously implicit 404 document).
Case differences in screenshot text come from removing CSS text-transform;
literal copy and separators are unchanged. The extension changes are CSS only.
