# TurnKey interface contract

The existing teal palette and navigation icons are retained. The working app is
plain HTML/JS. `workspace-design.css` supplies the shared responsive treatment;
feature styles remain in their existing modules.

- Primary tasks stay visible: customer contact, requested services, stage and
  Build quote. Secondary settings and detailed provider data use disclosure.
- Mobile cards stack identity, address/contact, services, metadata and actions.
  Flex/grid children must shrink with `min-width: 0`; long content wraps rather
  than widening the page. Buttons grow vertically with their labels.
- Touch actions are at least 44px high. Desktop controls remain compact.
  Bottom navigation clears device safe areas and must not cover the last record.
- Settings Overview presents categories and common shortcuts. Existing form DOM
  nodes are moved, never cloned or replaced during category/search changes.
  Website embeds, pricing, operations and every integration remain accessible.
- Cached calendar and conversation content appears before remote refresh.
  Refreshes must not replace user-entered credentials or reset active controls.
- New owner accounts receive a resumable setup checklist derived from actual
  saved data. Existing accounts can open it from Settings without repeated nags.
- Original form question labels and readable answers remain visible together.
  A missing answer is not inferred from an unrelated contact or job.

Reviewed at 1440px desktop and 390px/360px mobile with synthetic contacts across
Leads, Pipeline, customer detail, Settings, Conversations and Calendar. Two bounded
visual passes were used; no full product redesign or ServiceM8 feature parity is
claimed by this release.
