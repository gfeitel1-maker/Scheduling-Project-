---
title: T94-roots-first-timer-orientation-caption
document_type: ticket
status: completed
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

## Resolution (2026-08-20, SHIPPED — Code Reviewer merge-ready, gate green)

Designer assessment: still needed after the dashboard rework — the rework raised the payoff of a node
click but not the node's own discoverability (roots render as plain unlabeled circles at rest; the
label/ring appear only on hover). Design spec `docs/work/specs/2026-08-20-t94-roots-firsttimer-caption.md`.
Shipped: a quiet under-canvas caption in inspect mode (ReconciliationScreen), existing tokens
(13px/--text-secondary), once/dismissible via a device-local localStorage flag
(`shoresh:rootsFirstTimerCaptionSeen`, T92 pattern), entrance-only fade with reduced-motion suppression,
dismiss button `aria-label`. Existing canvas aria-label untouched. Test-first (renders when flag absent,
gone when set, dismiss sets flag, never in import mode); full `npm run verify` green (214 files, 25/25).

**Copy is a PLACEHOLDER** pending the owner's `/didwemenshion` language pass — a one-line swap; the
structure/affordance ships now. Accepted cosmetic residual (Code Reviewer LOW): the caption's `transition:
opacity` property is present but inert under reduced motion (never triggers — entered starts true); left
as-is rather than a no-op round. Under-canvas placement can be eyeballed / screenshot on request. Pending
owner sign-off.
