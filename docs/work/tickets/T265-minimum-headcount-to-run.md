---
title: "Minimum headcount to run an elective offering"
document_type: ticket
status: open
created: 2026-09-25
task_class: scheduling-engine
archive_when: "an offering carries a two-part minimum (mode + value) where a NULL value is never coerced to 0 and 0 is rejected by a CHECK, the engine declines to run an offering below its minimum and cascades those campers to their next available ranked choice, a finding names each declined offering with its shortfall, a director can set and clear the minimum where capacity is already set, and a non-vacuity test proves the engine still places an offering that exactly MEETS its minimum"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
---

# T265 — Minimum headcount to run an elective offering

## Why

The owner listed the hard constraints as *"which activity happens during what period, min and max
numbers to run, total capacities."* **The minimum half was never built.** Verified 2026-09-25: seven
plausible column names (`min_campers`, `min_enrollment`, `min_headcount`, `min_to_run`,
`minimum_campers`, `min_participants`, `min_size`) return **zero matches repo-wide**, and the only
capacity columns carry maxima (`elective_set_activities.capacity_mode` / `capacity_limit`,
`locations.capacity`).

This is not a defect. It is a **constraint the owner believed was enforced and that does not exist**,
so an offering with two campers signed up runs today and nothing says otherwise.

**Owner ruling, 2026-09-25:** *"if a camp wants a minimum they should be able to set that. the min
could be 1, cannot be 0."*

## Scope decision, and the reasoning, so it can be overridden deliberately

**Electives only.** A minimum-to-run is meaningful where *individuals* choose, because that is where
you can end up with two signups. Elsewhere campers are placed by **group** — a bunk of twelve goes to
swim — so the group's size *is* the headcount and there is nothing to fall below. If the owner means
this for ordinary group activities too, that is a different and larger piece of work and should be
said explicitly rather than absorbed here.

## The data shape — follow D3, do not invent

The existing capacity design already solved the exact hazard this field has, and there is a live bug
in the tree from getting it wrong elsewhere. `electron/db/schema.sql` around line 1092 records D3:

> capacity becomes a two-part value so **"no limit" and "closed" are never the same value**.
> `capacity_mode` is the AUTHORITY: when it is 'unlimited', `capacity_limit` is ignored entirely —
> **never coerced, never compared against.**

Mirror that shape exactly:

- `min_mode TEXT NOT NULL DEFAULT 'none' CHECK (min_mode IN ('none','required'))` — the authority.
  When `'none'`, the value column is **ignored entirely, never coerced, never compared**.
- `min_to_run INTEGER CHECK (min_to_run IS NULL OR (typeof(min_to_run) = 'integer' AND min_to_run >= 1))`

**The `>= 1` is deliberately different from `capacity_limit`'s `>= 0`, and the asymmetry is the point.**
A capacity of 0 is a genuinely *closed* offering — a meaningful state. A minimum of 0 means nothing,
which is why the owner excluded it. Per-column CHECKs, not a cross-column CHECK, per the schema's own
note on why D3's CHECKs are shaped that way.

**Why this matters more than it looks.** The audit of 2026-09-25 found that a blank `'limited'`
capacity is coerced to `capacity: 0` in three layers and surfaces to the director as though the
offering were full, and `electron/main.js:1852` records that despite the schema naming
`INVALID_CAPACITY`, **no finding of that kind is emitted anywhere**. Building the minimum with a
single nullable integer would reproduce that bug by construction: a blank minimum would become `0`,
and depending on the comparison direction either do nothing or make the offering unrunnable forever.
The two-part shape is what prevents it.

## Engine behaviour when the minimum is not met

This is the owner's stage-4 question — *the rules for what happens when a constraint is not met.*
**Recommended, and implemented unless he says otherwise:**

1. The offering **does not run**.
2. Its campers **cascade to their next available ranked choice**, through the existing preference
   machinery — not dropped, not left unassigned where another choice was open to them.
3. A finding names each declined offering and its shortfall ("3 campers, minimum 5"), so the director
   can see what happened and why.
4. A director who disagrees **lowers or clears the minimum and re-runs**. No force-override control in
   this slice — that is new machinery for a case nobody has reported yet.

The reasoning: running an offering below its minimum defeats the purpose of setting one, and refusing
to produce a schedule at all is useless to a director in August. Cascading is the only outcome that
yields a runnable schedule while honouring the constraint.

**A cascade can itself drop another offering below its minimum.** Decide and document whether the
engine re-evaluates (and if so, bounded how) or evaluates minima once against the initial solve. Do
not leave this to emerge from the implementation — it is the interesting case, and an unbounded
re-evaluation loop is the obvious trap.

## Non-vacuity

Test-first, and the required negative is as important as the positives:

- An offering **below** its minimum does not run, and its campers appear in their next ranked choice.
- An offering **exactly at** its minimum **does** run. A guard that is too eager would pass every
  "declines below minimum" test while silently refusing valid offerings.
- `min_mode = 'none'` with a non-NULL leftover value behaves as no minimum — the value is ignored,
  proving the authority column actually governs.
- A write of `min_to_run = 0` is **rejected**, and the rejection surfaces via `describeWriteFailure`
  rather than being swallowed.
- Migration: existing rows get `min_mode = 'none'`, and an existing offering's placement is
  **byte-identical** before and after the migration.

## Out of scope

- Minimums for ordinary group activities (see the scope decision above).
- The blank-capacity / `INVALID_CAPACITY` defect. Pre-existing, separately recorded, and cited here
  only as the reason for the two-part shape. Do not fix it in this ticket.
- Any force-override UI.

---

## 2026-09-26 — the minimum only means something inside a two-phase placement

A minimum is not a constraint the solver can honour while placing, the way a capacity is. You cannot
know an offering is short until everyone has been placed. **Owner ruling 2026-09-26:** placement
becomes two phases — place every camper from their preferences, *then* validate against the minimums,
*then* move the campers whose offering did not make its minimum.

**The loop terminates, and this is worth stating because it looks like it might not.** Campers only
ever move OUT of a cancelled offering and INTO a surviving one, so headcounts are monotonically
non-decreasing. Nothing that already passed its minimum can later fail it. Each round strictly
improves and the loop cannot oscillate.

### Cancellation order is load-bearing — owner ruling 2026-09-26

Order changes the answer. Two offerings, minimum 6: Archery has 4, Fishing has 5. Cancel Archery
first and one of its campers flows into Fishing, which reaches 6 and **runs**. Cancel Fishing first
and two of its campers flow into Archery, which reaches 6 and **runs instead**. Both outcomes are
legitimate; the engine must not pick arbitrarily.

**Ruling: cancel the offering furthest below its minimum first** (largest shortfall, measured as
`min_to_run - enrolled`). Ties broken by a stable identifier so the result is deterministic.

Rationale, for a later reader: the furthest-below offering is the least rescuable, so retiring it
first releases the most campers to rescue the offerings that are close. It is also explainable to a
director in one sentence — *"Archery had 4 of the 6 it needed, so it came off first, and those
campers moving to Fishing is what let Fishing run."*

**Test this explicitly.** The two-offering case above is the distinguishing fixture: an
implementation that cancels in id order, or in enrolled-count order without normalising by the
minimum, passes casual tests and fails this one. A minimum that differs BETWEEN the two offerings is
the case that separates "fewest enrolled" from "furthest below its own minimum" — e.g. Archery 4 of
6 (shortfall 2) versus Fishing 3 of 4 (shortfall 1): Fishing has fewer campers but Archery is
further below, so **Archery** is cancelled first. Pin that.

### Dependency

This ticket is now downstream of the per-cell preference model
([docs/adr/2026-09-26-per-cell-elective-preferences.md](../../adr/2026-09-26-per-cell-elective-preferences.md)).
The cascade "to their next available ranked choice" is only well-defined once a preference names the
cell it applies to — under the withdrawn global model a camper has one ranked list for the whole
week and "next choice in THIS period" cannot be read from it. Do not build the cascade first.

---

## The v78 migration is destructive by design, and its safety expires

Recorded here as well as in the code (`electron/db/localDb.js`, above the v78 block) because this is
the kind of condition that reads as settled once it is green and becomes false without anything in
the code changing.

The v78 migration **DROPs `elective_preferences` and recreates it.** `occurrence_id` is `NOT NULL`,
no valid default exists, and inventing one was forbidden — so every existing row is discarded. The
count is logged, never swallowed.

**That is acceptable for exactly one reason: there is no live camp data.** Not because the migration
is gentle, not because it is guarded, and not because the gate is green. The day a real camp's
database reaches this code, it destroys a director's collected preference forms.

**The question this migration dodges, which a data-preserving replacement must answer:** what
occurrence does an existing global-format preference belong to? Nothing in the row can say. That is
why no backfill was attempted rather than attempted badly — and it is the same fact that motivated
the whole per-cell change.

**Before real data exists anywhere, this must be replaced.** Inherit the condition, not the
conclusion.
