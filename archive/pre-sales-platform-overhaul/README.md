# Recovery archive

Baseline: git tag `archive/pre-sales-platform-overhaul-20261015`.
`application.tar` contains tracked application files at that tag; ignored credentials and local dependencies are excluded. Extract into a separate directory to inspect the old application.

Leads and opportunities share customers/jobs rows. Do not drop these tables. Quote rendering, document generation, record details, scheduling helpers and contact lookup have cross-view dependencies. This first navigation pass retains those implementations; it does not claim operational code has been fully removed.
