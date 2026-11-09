# Editable quote service names

Each quote line has a quote-specific display name. The original service key still determines measurement units, base rates, costs, margin and learning. Default names remain unchanged; clearing a UI custom name uses the normal service name. Names are bounded to 120 characters and escaped for HTML.

- Earth Instant Quote: measured and manual line names can be edited and survive repricing. Saved labels are restored by measurement identity or unique service/quantity matching, avoiding ambiguous matches. New manual lines carry explicit provenance so they can be restored without duplicating measured services.
- TurnKey line editor: Quote name field is saved with the service; existing accepted-quote locks remain enforced.
- PDF, HTML preview, email, public quote and existing ServiceM8 line-item transfer use the custom name. Window quantities remain hidden in customer-facing documents.
- Older manual non-window extension lines without provenance cannot reliably be distinguished from measured lines. They are not automatically reconstructed if doing so would guess or duplicate geometry; the saved TurnKey quote retains its labels.

Extension 0.2.12 package: assets/turnkey-earth-extension-0.2.12.zip. Unzip and reload that folder in Chrome Extensions, then refresh Earth and TurnKey. Packaging refreshed the vendored shared engine. The website download link now targets 0.2.12 when this release is published.

Verification: 68 combined quote, cost, GST, hydration, extension save/learning/handoff tests passed. The isolated extension browser test also passed, including editable measured/manual names, escaping, cleared-name fallback, saved/reopened names and new manual-line provenance. Static build and whitespace checks passed. No real quote, email, accepted record or ServiceM8 job was changed. Not pushed without user approval.
