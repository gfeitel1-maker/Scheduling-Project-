---
title: T102-devmock-is-span-head-default-fidelity
document_type: ticket
status: open
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md]
archive_when: the dev mock's freshly-placed manual slot defaults is_span_head the same way the real ensureExists path does (NULL, not 0/false), so a placed single-block activity renders in the browser-mock the same as in the real app, OR the divergence is documented as an accepted mock limitation
---

# T102 — Dev-mock is_span_head default diverges from real ensureExists (browser-mock only)

**Surfaced during T92 visual verification (2026-08-20).** Browser-mock only; NOT a real-app bug.

## What it is

In the REAL app, `template_slots.ensureExists` (`electron/ops/projections.js`) creates a freshly-touched
slot row with only `(id, template_id)` — so `is_span_head` is NULL. `normalizeSlots.toSlotBool(NULL)`
returns NULL, and `isActivityTail` (`slot.is_span_head === false`) is false → the placed cell renders
correctly (confirmed for T99). But the browser dev-mock (`src/localClient.mock.js`) defaults a
freshly-placed manual slot's `is_span_head` to `0`/`false` (or a string that coerces to false), so
after T99's tail-skip, a single-block activity placed on a BLANK manual week in `npm run dev` renders
as `{ kind: 'skip' }` and disappears. This blocked a dev-server screenshot during T92 (worked around by
screenshotting the seeded demo, whose slots are is_span_head:1).

## Why it matters

Purely a dev/test-fidelity gap (`localhost:5200` is "adequate for layout only" per TESTING_STANDARD),
but it makes the mock misrepresent a core manual-route interaction (place → cell vanishes), which will
mislead future visual verification of any manual-route work.

## Definition of done

- The dev mock defaults a freshly-created slot's `is_span_head` the way real `ensureExists` does (NULL),
  so a placed single-block manual activity renders in the browser mock, OR the divergence is explicitly
  documented as an accepted mock limitation with a note at the mock's slot-write path.

## Related

- T99 (skip-render span tails) — introduced the tail-skip that makes this mock default visible.
- T92 (merge discoverability) — where it blocked the dev-server screenshot.
