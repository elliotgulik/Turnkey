# Local redesign implementation

## Step 4: stage rail skipped

The existing pipeline has New lead, Contacted, Quote sent, Quote confirmed and
Cancelled. Cancelled is an alternative outcome, not a later sequential stage.
The sales UI adds Completed while the core model groups scheduled/completed/paid
under won. These do not form a single ordered sequence. The brief explicitly
requires skipping the rail in this situation. No stage, grouping or label changed.
