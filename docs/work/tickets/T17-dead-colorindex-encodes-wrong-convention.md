---
title: T17-dead-colorindex-encodes-wrong-convention
document_type: ticket
status: completed
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
archive_when: resolved
---

> **RESOLVED 2026-07-29.** The three `findIndex`-derived `colorIdx` values were deleted; the
> only remaining uses are `actMap`'s, which carry the activity's stable id as the seed. A test
> pins that an id and an array index are different seeds, so the wrong convention cannot be
> reintroduced quietly.
>
> Superseded in part by the T18 colour work: `activityColor()` now consults an assignment
> registered from the whole activity set rather than hashing each id independently, which also
> removes the divergence risk this ticket described — every surface reads one assignment.

# T17 — A dead `colorIdx` field encodes the wrong colour convention

**Risk:** Low today — nothing renders from it. It is filed because it is a **trap**, not
because it is currently visible.
**Found:** 2026-07-28, by Designer during the grid colour audit. Designer reported it as a
live defect; that part did not survive verification. See "What is actually true" below.

---

## The rule it gets wrong

`activityColor()` ([slotCellConstants.js:48](../../../src/components/schedule/slotCellConstants.js))
hashes whatever it is given:

```js
export function activityColor(activityId) {
  return ACTIVITY_COLORS[djb2(String(activityId)) % ACTIVITY_COLORS.length]
}
```

It is keyed on the activity's **stable persisted id**, deliberately, so a hue survives
reordering and additions. The comment above it says so, and
[ScheduleScreen.jsx:1236-1239](../../../src/screens/ScheduleScreen.jsx) repeats the reasoning:

```js
// colorIdx carries the activity's stable id (not array position) so activityColor()
// can derive a djb2-stable hue that survives reordering/additions
const actMap = new Map(activities.map(a => [a.id, { ...a, colorIdx: a.id }]))
```

Because the argument is an opaque hash seed, feeding it an **array index** instead of an
**id** yields a different colour for the same activity — `djb2("3")` and
`djb2("a1b2-…")` are unrelated.

## Where the wrong convention is written

Three places build displaced-item entries using array position:

- [ScheduleScreen.jsx:140](../../../src/screens/ScheduleScreen.jsx) — `const actIdx = activities.findIndex(...)`, then `colorIdx: actIdx >= 0 ? actIdx : 0`
- [ScheduleScreen.jsx:985](../../../src/screens/ScheduleScreen.jsx) — `const colorIdx = activities.findIndex(a => a.id === tailActivityId)`
- [ScheduleScreen.jsx:1106](../../../src/screens/ScheduleScreen.jsx) — same, for `displacedActivityId`

All three fall back to `0` when the activity is not found, which is a second wrong answer:
`0` is not "no colour", it is *the colour of whatever hashes to index 0*.

## What is actually true — the reported defect does not reproduce

Designer reported that "the same activity can render a different dot colour in the main grid
versus a displaced-item chip." **It cannot, today.** Verified by reading the consumer:

[DisplacedPalette.jsx:5-6](../../../src/components/schedule/DisplacedPalette.jsx) destructures
`{ activityId, activityName, fromBlockName, dayLabel }` — **`colorIdx` is never read** — and
colours the chip with `activityColor(activityId)`, the same stable-id convention the grid uses.

So the three `colorIdx` values are **computed, stored in React state, threaded through props,
and never consumed.** The colours agree. The field is dead.

## Why file it anyway

Dead data that looks load-bearing is worse than absent data. The field is named exactly like
the one the grid uses, is carried on the same objects, and sits one destructure away from the
component that would render it. The obvious future change — "the chip should use the colorIdx
it is already being given" — silently introduces the divergence Designer thought was already
there. The trap is baited and pointing at the next person.

## Proposal

Confirm before implementing; either direction closes it.

1. **Delete it** (preferred). Remove `colorIdx` from all three construction sites and from the
   displaced-item shape. Nothing reads it. This is the smallest change and removes the trap
   outright.
2. Or **correct it** — pass `activityId` as the seed, matching `actMap` — if there is a
   near-term intent to render from it that is not visible in the code today.

Whichever is chosen, drop the `>= 0 ? … : 0` fallbacks: a missing activity should not silently
acquire a real colour.

## Completion evidence

1. No code path computes a colour seed from `activities.findIndex(...)`.
2. An activity's dot colour is identical in the grid and in the displaced palette — and a test
   asserts it, so the convention cannot silently fork again.
3. No `colorIdx` remains that is written and never read.
