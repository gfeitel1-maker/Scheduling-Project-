---
title: "Flag system review — diagnosis and recommendations"
document_type: spec
status: active
created: 2026-07-31
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs:
  - docs/adr/2026-07-28-schedule-flag-findings-reshape.md
  - docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md
archive_when: R1 and R2 are merged and Verifier PASS recorded
---

# Flag system review — diagnosis and recommendations

Commissioned to answer: *are the per-cell marks on the schedule grid and the
alerts at the top duplicative, and can they be merged?*

Companion: `2026-07-31-flag-rail-scope-clarity-design.md` (Designer's visual
spec) and `prototypes/2026-07-31-flag-rail-scope-clarity-prototype.html`.
Where this document and that one disagree, this one governs — the
disagreements are in §6.

## 1. Answer

**Yes, there is real duplication. No, the two surfaces should not be merged.**

The duplication is not the dots-versus-rail split. That split is
`docs/adr/2026-07-28-schedule-flag-findings-reshape.md`'s deliberate fix for a
measured defect, and it works. The duplication is **one flag kind, `OVERLAP`,
which was added after that ADR and never had the ADR's rule applied to it.**

`OVERLAP` appears **zero times** in the reshape ADR (verified by grep). It
postdates it. And `src/utils/computeOverlaps.js:41` does precisely what the ADR
exists to abolish:

```js
for (const r of rows) overlapping.set(r.id, reason)
```

One clash — four groups booked into a pool holding two — stamps the **same
reason string** onto four slots. `ScheduleScreen.jsx:1435` counts those slots
for the header tile ("Overlapping: 4") and `:1474-1481` maps them 1:1 into four
rail rows, keyed `overlap-${s.id}`, all reading *"4 groups booked into Pool — it
holds 2."*

That is verbatim the defect the ADR's Consequences section names — *"a single
understaffing problem can show as '5 flags'"* — fixed for `UNDERSERVED` and
`DISTRIBUTION` on 2026-07-28, and live again in the kind that shipped after.

**Merging the two surfaces would treat the symptom and destroy a distinction
that is load-bearing.** The grid is *view*-scoped: 42 cells in group view. The
rail is *camp*-scoped: a rail row is the only way to learn about a problem in a
group you are not currently looking at. Aggregate findings are computed once per
`(groupId, activityId)` (`buildSchedule.js:370`) and have no principled cell to
pin to — any per-cell rendering of them must either pick an arbitrary slot or
stamp all matching slots, which is the original bug.

## 2. Evidence

Source-verified, all four investigations concurring:

| Claim | Evidence |
|---|---|
| `OVERLAP` postdates the ADR | grep: 0 occurrences in the ADR |
| One clash → N cells, N rail rows, tile reads N | `computeOverlaps.js:41`; `ScheduleScreen.jsx:1435`, `:1474-1481` |
| Aggregate findings have no cell presence | `slotCellConstants.js:56-58` |
| Findings are never persisted | `ScheduleScreen.jsx:124`; recomputed `:396` |
| `OVERLAP` never persisted, stripped on write | `normalizeSlots.js:47-50` |
| `UNFILLABLE` persisted, passed through on read | `normalizeSlots.js:35-46` |
| Route exclusivity holds | `ScheduleScreen.jsx:177`, `:1433-1435`, `:1020` |
| `WEATHER_RISK` fully removed from engine | grep clean; `buildSchedule.test.js:30-34` |
| Old snapshots still stripped correctly | `normalizeSlots.js:42`; `normalizeSlots.test.js:74-84` |

### `UNFILLABLE` renders eight ways for one cell-level fact

4px danger bar, 6% background tint, outline alert glyph, the literal word
"Unfillable" as cell text, a glyph `title`, a `<td>` `title`, a header tile, a
rail row — plus a standing legend entry. Four of the eight are on the cell
itself. Not wrong (they are one fact in one place plus an index), but it is why
the screen reads as louder than it is.

## 3. Recommendations, cheapest first

### R1 — One clash, one line *(recommended, high confidence)*

`OVERLAP` becomes one finding per `(day, block, activity)`, not one per
participating slot.

The bronze mark **stays on every clashing cell** — a director must see *which*
cells clash. What changes is the count and the rail: the tile reads
`Overlapping: 1` and the rail shows one row — *"4 groups booked into Pool at
Tuesday, Block 3 — it holds 2"* — with the four group names as its locator.

This does not supersede the ADR. It **completes** it, applying the ADR's own
§Decision 1 rule to a kind written after it.

**Verifiable success criterion.** Build a manual week with 4 groups in one
capacity-2 activity in one block. The tile reads `1`; the rail contains exactly
one row; four cells carry the mark. Unit-testable on `computeOverlaps` returning
a findings array of length 1.

**Cost.** Confined to `computeOverlaps.js` (return findings alongside the
per-slot map) and ~2 lines of `ScheduleScreen.jsx`. **Nothing persisted** —
`OVERLAP` is derived at render, never written to `template_slots.flags`, never
an op, never in a snapshot. No engine change. At 100 groups the rail gets
*shorter*.

### R2 — A filled dot means "what", an outline glyph means "wrong" *(recommended)*

Reserve filled circles for activity identity. Every mark meaning "act on this"
becomes an outline glyph.

Today the identity chip is a 6px filled circle and the `OVERLAP` mark is a 7px
filled circle — the same shape, 1px apart, in the same cell, one meaning "which
activity" and the other "problem." The decolorization spec §6 already set this
rule; `OVERLAP` was added afterwards as a dot and reopened the door that
decision closed. Make it a bronze outline glyph mirroring `UnfillableIcon`'s
construction.

**Verifiable success criterion.** `borderRadius: '50%'` appears on exactly one
persistent cell mark — `cellIdentityChip`. A filled, problem-free cell renders
exactly two marks: chip, and structural bar if applicable.

**Cost.** Render layer only, ~15 lines. Nothing persisted, no ops, no engine
change.

### R2b — Outdoor icon behind the weather toggle *(medium confidence — verify first)*

Governor proposes the persistent outdoor sun icon render only when the existing
`weatherMode` toggle is on, arguing it currently fires on a large fraction of
filled cells and is `WEATHER_RISK` returning through the icon door.

**Do not act on this without measuring.** The base rate is an estimate from
`is_outdoor` semantics, not a measurement. Query a real camp: if the outdoor
share of activities is under ~20%, the icon is discriminating and this should be
dropped. Also worth knowing whether directors use `weatherMode` at all before
relocating a signal into it.

### R3 — The legend tells the truth, next to the grid *(follow-on)*

Move the legend from page-bottom (~800 render lines below the grid, under two
modals) to directly under the stat tiles. Render every swatch from the same
component the cell uses. Add an "Activity colour" entry — the most common mark
on screen is currently undocumented. Collapse the three near-identical `OVERLAP`
reason strings (cell tooltip, legend, rail row) into one exported constant.

**Verifiable success criterion.** Every `LEGEND_ENTRIES` swatch renders from the
cell's own component; zero reason strings duplicated across files.

*Note:* Governor reports the legend renders `UNFILLABLE` as a filled dot swatch
while the cell shows an outline glyph. **Unverified in this review** — confirm
against `slotCellConstants.js` `LEGEND_ENTRIES` and `legend.test.js:50` (which
asserts over `shape` values) before relying on it.

### R4 — Rail knows what you can already see *(hold)*

Split rail rows into "in this view" (collapsed to a count) and "elsewhere in the
camp" (shown in full).

**Hold this until R1–R3 are in front of a director.** If R1 removes the
duplicate rows and R3 explains the marks, the residual "I'm reading the same
thing twice" feeling may already be gone, and R4 would then be machinery for a
solved problem. It is also the only proposal that adds a concept, and it needs a
threshold so it degrades to a flat list at small camp sizes.

## 4. Bugs found in passing — worth tickets regardless

1. **Dismissed findings silently reappear.** `dismissFinding` state is
   session-only, and `loadAll()` resets `dismissedByRoute` for **both** routes on
   every applied remote op. A director dismisses three findings, any device
   pushes any unrelated op, all three return with no error or indication. The
   plural-routes ADR named this defect class for `loadAll`'s other resets; the
   dismissal reset was not fixed. **Highest-severity item in this document.**
2. **A dismiss control that does nothing.** `FindingsRail.jsx:53-60` renders an
   `×` on every row; `dismissFindingsRow` (`ScheduleScreen.jsx:1491-1497`)
   deliberately no-ops for `OVERLAP`. Either hide the control on those rows or
   make it explain why it cannot act.
3. **The rail's locate action is half-built.** `locateFindingsRow`
   (`:1500-1504`) sets view, selects the group, and **closes the rail** — losing
   the list to inspect one item. The decolorization spec specified
   `scrollIntoView` plus a 1200ms severity pulse; `grep` finds neither anywhere
   in `src/`. This is the missing thread that would make the rail read as an
   index rather than a rival system, and is likely a direct contributor to the
   "duplicative" perception.
4. **Dead motion stub.** `FindingsRail.jsx:20-24` computes a `reduced` branch
   whose arms are functionally identical, so the specified Slide+Fade never
   shipped.
5. **`is_outdoor` + `OVERLAP` + locked can collide in bronze.** The locked bar
   and `OVERLAP` dot are both `var(--accent)`, separated only by shape. R2
   resolves this incidentally.
6. **ADR metadata discrepancy.** Front-matter says `status: accepted`,
   `implementation_state: shipped`; the body heading says `**Status:**
   proposed`. Recorded, not resolved.
7. **Suspicion, unconfirmed.** Whether `dismissFlag`'s write path is a per-key
   merge or a whole-object replace of `flags`. If it is a replace, two devices
   dismissing different flags on the same slot could clobber each other. Verify
   against `electron/ops/operations.js` before extending `flags` with more keys.

## 5. Explicitly rejected

- **Merging the per-cell and aggregate data models.** Reverts an accepted ADR
  and re-creates its defect. Any proposal rendering `UNDERSERVED`/`DISTRIBUTION`
  per cell — including "just in the group's row header" — is the original bug
  with new paint.
- **Persisting findings, or a `dismissed_findings` table.** A schema change for
  a UI convenience. The ADR considered and rejected it; nothing has changed.
- **One status colour per cell.** Destroys activity identity — the primary thing
  the grid is scanned for — and makes colour the sole carrier of "problem".
- **Reverting to one aggregate header badge.** The four-tile layout is a
  documented, Tester-driven deviation (`ScheduleScreen.jsx:127-132`). Per-kind
  counts in camp language ("Still needed", "Spread across the week") are worth
  more than badge minimalism. Re-litigating costs more than it returns.
- **Filtering the rail by which tile was clicked.** Tempting, but the recorded
  rationale for the deviation is specifically that one click shows everything.
  Would need the director's own input to overturn.
- **A camp-scale heat strip above the grid.** Interesting at 100 groups; a new
  surface for a problem nobody has reported. Parked, not killed.

## 6. Where this overrides Designer's spec

Designer's diagnosis rests on the badge counts being *"a legitimate live tally —
like a to-do list's '3 remaining' beside three unchecked boxes."* **That premise
is false for `OVERLAP`** (§1): the rail rows are one-per-cell, so the tally
counts one problem N times.

Its recommendations — a two-part rail heading ("On this grid" / "This week
overall"), sorting `findingsRows` by `[scope, severity]`, and reusing the cell's
exact glyph in the badge — are sound and correctly restrained, and should be
adopted **after R1**. Applied alone they would make a miscount look more
authoritative.

Designer also describes the rail's locate action as "working"; it is half-built
(§4.3).

## 7. Constraint checks

**Non-canonical schedules.** No recommendation merges or reorders the routes.
`UNFILLABLE` stays generated-only, `OVERLAP` manual-only; R1 changes only how
`OVERLAP` is counted within the manual route. No count spans both routes. Nothing
implies the manual week is less validated for lacking a generated-only signal.

**Decolorization intent.** R2 restores a rule that spec set and `OVERLAP`
violated. R3 repairs drift against `slotCellConstants.js`'s own stated rule that
*"shape is not decoration."* Colour remains never the sole carrier — R2 improves
this by giving `OVERLAP` a shape.

**Persistence.** R1, R2, R3 touch no persisted shape, add no ops, change no
engine output, and are indifferent to camp size.

## 8. What would change the recommendation

- A director pointing at what they actually meant by "duplicative." Every
  conclusion here is inferred from code, not observed in use. If they mean the
  header tiles specifically, R1 still stands but R2/R3 may be beside the point.
- A measurement of the `is_outdoor` ratio on a real camp (gates R2b).
- Evidence that directors use `weatherMode` (gates R2b).
