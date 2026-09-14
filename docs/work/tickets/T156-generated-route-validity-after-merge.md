---
title: "Two offline edits can converge into a generated schedule nothing flags"
document_type: ticket
status: open
created: 2026-09-13
task_class: scheduling-engine
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-09-08-crdt-conflict-reconciliation.md]
archive_when: the product owner has decided whether the generated route surfaces a post-merge capacity clash, and the decision is recorded either way
---

# T156 — Two offline edits can converge into a generated schedule nothing flags

**Open deliberately. This is a product decision, not a defect to fix quietly.**

From the external architecture review of 2026-09-13 (item 4), which asked
whether CRDT convergence is being confused with schedule validity. Mostly it is
not, and the code is explicit about the difference — but there is one real
residue.

## What is already right

A merge runs `projectAll`, then `synthesizeOpEvents` emits `op-applied`, and
`ScheduleScreen` reloads for any event that is not from its own device. The
**manual** route's flags — `OVERLAP` and `WEEK_CLOSED` — are derived at render
time from the converged state and never persisted (`ScheduleScreen.jsx`), so
they appear and clear correctly on merged state, whatever produced it. CRDT
conflicts live in their own `conflicts` table with their own vocabulary, and
`projectAll` refuses a document carrying a conflict that was not recorded.

## The residue

The **generated** route's `UNFILLABLE` and the engine's `findings` are
generation-time artifacts, and `OVERLAP` is manual-only by explicit product
stance: *"the engine refuses clashes rather than making them."*

That stance was formed when a clash could only arrive by generation. It can now
arrive another way: two directors, both offline, each drag a group into the same
location in the same block. Both documents are individually valid, they merge
cleanly, nobody sees a conflict — and the generated route does not flag the
over-capacity result, because on that route a clash is something the engine was
supposed to have prevented.

## The decision to make

1. **Derive `OVERLAP` on both routes.** Cheapest, and consistent with the
   manual route already doing it. Costs the stance: the generated route would
   start displaying clash markers, which it currently treats as a category error.
2. **Recompute the generated route's flags after a merge.** Truer to the route's
   own model, but "recompute" means re-running the engine against converged
   state and reconciling that with the director's hand edits, which is a larger
   change than it sounds.
3. **Accept it and say so**, the way `SECURITY.md` records the role-enforcement
   tradeoff — on the grounds that a director who drags a group somewhere is
   looking at the cell.

Not chosen here. What this ticket records is that the stance now rests on an
assumption that stopped being true when sync stopped being mediated by a Host.

## Recommendation (2026-09-14), for the owner's decision

**Option 1 — derive `OVERLAP` on both routes.** A director reading a warning does
not care which route drew it, and the manual route already computes exactly this
from the same rendered slots. Option 2 is a substantially larger job: it has to
reconcile fresh engine output against hand edits without undoing them. Confidence
high. See `docs/work/architecture-reports/2026-09-14-open-decisions-brief.md`.
