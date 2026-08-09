---
title: T78-dev-only-shape-assertion-at-engine-id-list-inputs
document_type: ticket
status: closed
created: 2026-08-08
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T69-engine-still-tolerates-json-stringified-id-lists.md, docs/work/tickets/T71-dev-shape-assertion-at-engine-id-list-inputs.md]
related_adrs: []
archive_when: a DEV-only guard rejects a non-array id list at every engine input that consumes one, with a test proving it fires, and it is proven absent from the production build
---

# T78 — A DEV-only shape assertion at the engine's id-list inputs

**Superseded by T71** (`docs/work/tickets/T71-dev-shape-assertion-at-engine-id-list-inputs.md`,
shipped 7613216) — same scope, filed a second time under a duplicate number. This file is retained
for its problem-statement detail, not as a live ticket.

**Risk:** Low. Adds a development-time guard; no production behaviour.
**Task class:** scheduling-engine.

---

## Why this ticket exists

T69 deleted the engine's string tolerance for `activities.eligible_tier_ids`,
`activities.eligible_group_ids`, and `anchor_activities.group_ids`, on the verified finding that
normalization already happens at the IPC read boundary
(`src/utils/normalizeActivityEligibility.js`, applied at `src/screens/schedule/useScheduleData.js`
`:117` and `:122`). That was correct and it shipped green.

It left one acknowledged residual, raised by Red Hat and carried forward by Grader: **the engine
now depends on that boundary but does nothing to detect its absence.** T69's own "Out" section
excluded a runtime guard deliberately — a shape assertion is a decision, not a smuggled-in
replacement for the tolerance being deleted. This is that decision, taken on its own.

Recorded here so it does not vanish when T69 archives; it currently exists only inside T69's prose.

## Problem

If the boundary normalizer ever regresses — a removed `.map`, a new load path, a second screen that
feeds the engine — the two failure modes are both bad and neither is loud:

1. **Activities** (`useScheduleData.js:117`). A `'[]'` string is truthy with `.length === 2`, so the
   "no restriction" gate (`tierIds.length === 0 && groupIds.length === 0`) fails and
   `new Set('[]')` iterates the *characters* `[` and `]`. The activity becomes eligible for
   **nothing**. A camp director sees an almost-empty week full of UNFILLABLE cells and no
   explanation. Silent and wrong.
2. **Anchors** (`useScheduleData.js:122`). A string reaches `weekCatalog.js`, which calls `.every`
   on it — `String.prototype.every` does not exist — and throws. `resolveWeekCatalog` is called at
   `src/screens/schedule/useGeneration.js:66`, **outside** any `try` (the first is at `:88`) and
   **after** `setGenerating(true)` at `:52`, from a floating promise. The director gets a spinner
   that never resolves and no banner. Loud in the logs, invisible in the UI.

T69 pinned both in CI (`src/engine/buildSchedule.test.js`, `src/engine/weekCatalog.test.js`,
`src/screens/ScheduleScreenExclusions.test.jsx`). There is nothing at runtime.

A related seam that makes this more than theoretical: `useScheduleData.js:277-278` exposes a generic
`setActivities(updater)` that accepts a plain value, not only a function. Any future caller can push
un-normalized rows straight into `setupLists.activities` and onward to the engine. Today's only
caller (`useSlotMutations.js:205`) spreads an already-normalized row, so this is latent — but T69
made that seam load-bearing where it previously was not.

## Scope

**In:**

1. A DEV-only guard at each engine input that consumes an id list — the two in
   `src/engine/buildSchedule.js` (`scheduleCohort` eligibility, `computeFindings` eligibility) and
   the one in `src/engine/weekCatalog.js` — that throws a **named, specific** error when the value
   is neither an array nor nullish. The message must name the field, the offending type, and the
   boundary that was supposed to normalize it.
2. It must compile out of the production build. Confirm the mechanism actually works in this repo's
   Vite/Electron setup rather than assuming it (`import.meta.env.DEV` behaves differently in the
   renderer bundle and under vitest).
3. A test proving the guard fires on a string, and a test proving the normal array path is
   unaffected.
4. Verify the guard does not break the existing suite — several fixtures pass `null`/omitted
   eligibility deliberately, which must stay legal (`weekCatalog.test.js` null case,
   `buildSchedule.test.js` null/omitted cases added by T69).

**Out:**

- Re-introducing any string tolerance. The guard rejects; it does not parse. If this ticket ends
  with `JSON.parse` back in `src/engine/`, it has failed.
- Changing production behaviour. In a production build the engine must be byte-equivalent to what
  T69 shipped.
- Hardening `setActivities` — that is a separate call, noted above as context only.

## Open question for whoever picks this up

Is a throw the right response, or a `console.error` plus a visible banner? A throw in DEV surfaces
immediately during development, which is the point. But failure mode 2 above shows this codebase
already has a place where an engine throw becomes an invisible hang, so a guard that throws into the
same unguarded floating promise at `useGeneration.js:66` would reproduce the very symptom it is
meant to expose. Decide this before implementing; it may argue for fixing the missing `try` at
`useGeneration.js:66` first, or instead.

## Acceptance

- [ ] A string id list at any of the three engine inputs produces a named error in DEV, with a test
- [ ] `grep -rn "JSON.parse" src/engine/` still returns nothing
- [ ] Production build output contains no guard code (demonstrated, not asserted)
- [ ] `npm run lint`, `npm run check:governance`, `npm run build`, and
      `npx vitest run --no-file-parallelism` all pass
