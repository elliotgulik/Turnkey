---
name: Turnkey
description: Sales, quoting and job tool for a small NZ exterior-cleaning crew. Calm and exact, like a well-kept job sheet.
colors: { ground: "#f3f5f5", surface: "#ffffff", ink: "#0a1c2b", muted: "#53626c", line: "#d5dde1", rule: "#e6ebee", signal: "#0f7d6b", signal-deep: "#0b5f52", tint: "#e2f0ec", rail-current: "#8fc4ba", alert: "#a3462a" }
typography: { display: "Barlow Semi Condensed 600", body: "Barlow 400/500/600, 15px/1.5", scale: [12,13,15,17,22,28,34], figures: tabular }
rounded: { control: 6px, surface: 10px, sheet: 14px }
spacing: [4,8,12,16,24,32,48]
---
Rules: teal (signal) marks only the primary action, progress and the selected nav item; never decoration or background washes. Text on tint uses signal-deep. Alert is text only ("Overdue 3 days"), never a coloured block or chip. Sentence case everywhere. No all-caps labels, no letter-spaced eyebrows, no " · " joined meta strings (use commas or separate lines), no arrows in button text, no coloured left borders, no icon-in-a-tinted-square, no gradients. Lists are rows on one white surface with 1px rule dividers, not grids of identical cards; boxes only for things that float (price panel, menus, sticky bars, modals). Shadows only on floating things. One primary button per screen area. Hover: slight darken; focus: 2px teal ring offset 2px; pressed: 1px nudge; respect prefers-reduced-motion.
Signature: the stage rail. Six 4px segments (Lead, Quoted, Accepted, Booked, Done, Paid): done = signal, current = rail-current, todo = rule; role="img" with aria-label "Stage N of 6: <name>". A purely visual indicator of the job's EXISTING stage; it adds no new stage, label or button.
Desktop: 232px white sidebar (border-right line), content left-aligned in a 1200px column, 32px/40px padding. Page headers keep their existing content; restyle only: h1 in display 34px, existing subtitle in muted text, existing actions on the right.
Phone (≤760px): no sidebar; the existing bottom tab bar keeps its current tabs, labels and order, restyled to 84px tall incl. safe area, icons with labels, active = signal-deep; page title top-left (display 28px); primary actions full width, 48px tall; touch targets ≥44px.
Don't change: brand navy #0a1c2b, teal #0f7d6b, the Turnkey mark.


## PDF reference revision, 3 November 2026

The user replaced the previous presentation brief with Desktop/Turnkey redesign.pdf.
Its six pages govern desktop/mobile Dashboard, Leads and Pipeline composition:
readable 15px body text, restrained navigation, an actionable job-sheet dashboard,
compact list-first pipeline with the existing board still available, and a desktop
lead list beside a customer preview. Mobile uses ruled rows with clear next actions
and a stable bottom bar. Existing records, grades, statuses and metric definitions
remain authoritative; mock names, totals and inferred tracking in the PDF are not data.

The user explicitly requires grade-coloured leads. This overrides the earlier
neutral-only badge rule: A uses green, B blue, C purple, review amber, with readable
tints and written grade labels. No coloured accent stripes are needed. Changes are
kept local for review; publishing requires fresh approval.
