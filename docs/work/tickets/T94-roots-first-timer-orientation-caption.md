---
title: T94-roots-first-timer-orientation-caption
document_type: ticket
status: open
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
archive_when: the caption ships (or the roots-as-dashboard rework makes the affordance self-evident and the caption is judged unnecessary)
---

# T94 — Roots first-timer orientation caption (design audit #7)

**Raised:** 2026-08-19, emil/apple/impeccable design audit (item #7). **Held for owner review** during
the audit-response pass, then filed so it isn't lost. Owner is running a separate language skill on
Roots copy — this caption's wording should come from that pass.

## What

The Roots canvas (`src/components/reconciliation/RootMap.jsx`) renders a root-illustration PNG under
an SVG of nodes. For a first-time, non-technical director, nothing on first glance says the dots are
interactive or what the picture means — the only orientation is a screen-reader-only `aria-label`
("The root system — what Shoresh took in."). A first-timer may not realize a node is clickable.

Design audit suggestion: a single, quiet caption under the canvas — e.g. "Each part of your camp is
a root — click one to see what Shoresh found" — styled like the existing `understoodRow` (13px,
`--text-secondary`), shown once or dismissible. No new tokens.

## Why held / why now

- The exact wording is deferred to the owner's language skill (same follow-up as the Roots header
  copy — see the parked copy work). File the affordance; wording lands with that pass.
- It interacts with the **Roots-as-dashboard rework** (`docs/work/specs/2026-08-19-roots-dashboard-
  spine-design.md`): once nodes carry a loud "Manage {Area} →" panel and the dashboard framing, the
  affordance may read more obviously — so revisit whether the caption is still needed *after* that
  rework, and where it sits (dashboard header vs under-canvas).

## Definition of done

- A first-time director has a quiet, on-canvas (or under-canvas) cue that the roots are clickable and
  what they represent — copy from the owner's language pass, styled on existing tokens, non-intrusive
  (once/dismissible, never competing with the "quiet at first glance" principle).
- Reduced-motion / a11y respected; the existing `aria-label` stays.

## Related

- Design audit items #1 (shipped, PR #109), #2–#6 (shipped, PR #110), #8 heading font (parked with
  header copy).
- `docs/work/specs/2026-08-19-roots-dashboard-spine-design.md` (the rework this should be revisited
  against).
