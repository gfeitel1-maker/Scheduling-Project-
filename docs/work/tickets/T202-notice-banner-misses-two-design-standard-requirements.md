---
title: "The op-rejected notice banner is missing two things DESIGN_STANDARD §5c requires of a recoverable error"
document_type: ticket
status: open
created: 2026-09-17
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
depends_on: "None. Surfaced reviewing T200/T201 (PR #464, merged 2d49c55); both gaps predate that PR except where noted."
archive_when: "the notice banner in src/App.jsx renders the outline alert icon §5c requires, dismiss fades out over --motion-fast rather than removing the node synchronously, the existing dismiss test is updated to match the standard rather than the standard being read down to match the test, and `npm run verify` is green"
---

# T202 — the notice banner does not meet §5c

## Why this is filed rather than fixed

`docs/governance/GOVERNANCE_INDEX.md` §11.3: *"Does the code contradict a standard? **Report it and
stop.** Do not amend the standard to match the code, and do not amend the code to match a standard
without the human gate."* Both findings below are exactly that, so they are reported here for the
owner's decision instead of being quietly implemented.

## Confirmed against code at 2d49c55

`DESIGN_STANDARD.md` §5c ("Error — recoverable inline") specifies the container, **an outline alert
icon (16px, `var(--danger)`) + message + an inline retry/undo affordance (link-button,
`var(--primary)`)**, and motion: *"Slide + Fade — translateY -4px→0, opacity 0→1, `--motion-base`.
On dismiss/resolve, fade out `--motion-fast`."*

`OpRejectedNoticeBanner` in `src/App.jsx` now satisfies the container, the retry affordance, the
primary link-button colour, and the slide-fade entrance — T200/T201 added the last three. Two
requirements are still unmet:

### 1. No alert icon

The banner renders `<span>{notice}</span>` and two buttons. There is no 16px outline alert icon.
**Pre-existing** — the pre-T200 banner had no icon either; T200/T201 neither introduced nor fixed it.

### 2. Dismiss removes the node synchronously instead of fading out

§5c requires a `--motion-fast` fade on dismiss. The current `onDismiss` calls
`setOpRejectedNotice(null)`, unmounting immediately.

This one has a recorded reason, and it is the part worth the owner's attention: a comment on
`OpRejectedNoticeBanner` states dismiss stays synchronous because *"the existing 'dismiss removes the
banner' test asserts the alert is gone immediately after the click, which a delayed dismiss would
break."* That is a standard being shaped to fit a test. Per §11.3 the standard governs and the test
is the thing that should move. Flagged, not changed.

## Required work

Implement both, and update the dismiss test to assert the faded-out end state rather than immediate
removal. `prefers-reduced-motion: reduce` must degrade to instant per §8.

## Non-goals

- The notice queue. T12, T200 and T201 have each ruled it out of scope; this ticket does not reopen it.
- Any other §5c surface. Scoped to this banner.
