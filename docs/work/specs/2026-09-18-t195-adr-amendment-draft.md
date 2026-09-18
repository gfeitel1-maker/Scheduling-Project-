---
title: "ACCEPTED (superseded) — proposed amendment to docs/adr/2026-09-17-individual-elective-scheduling.md, landed as D14"
document_type: spec
status: superseded
created: 2026-09-18
archive_when: "superseded — the owner accepted this amendment on 2026-09-18 and it is landed as D14 of docs/adr/2026-09-17-individual-elective-scheduling.md"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T195-preference-import-service.md, docs/work/tickets/T196-assignment-engine.md, docs/work/tickets/T218-elective-export-third-party-adapter.md, docs/work/tickets/T219-multi-day-catalog-linkage.md]
---

# ACCEPTED 2026-09-18 — landed as D14. This file is superseded and kept as the record of the proposal.

> **The owner accepted this amendment on 2026-09-18.** It is now **D14** of
> `docs/adr/2026-09-17-individual-elective-scheduling.md`, which is the normative text — read that,
> not this. This file is retained unedited below as the record of what was put to him, so the
> proposal and the decision can be compared.
>
> One thing the landed D14 states that the proposal below did not, and which matters: the artifacts
> examined were **blank forms and catalog sheets, not completed camper responses**, and the real
> submissions arrive through a third-party portal export nobody has seen. The evidence is enough to
> **retire** the ranked-per-occurrence premise and **not** enough to establish a replacement.

## Original proposal, as put to the owner

**This was NOT an ADR edit when written. It was a proposal for the owner to accept, reject, or amend.**

**The ADR itself (`docs/adr/2026-09-17-individual-elective-scheduling.md`) has not been touched by
this work.** This file exists so the owner has a concrete, reviewable amendment to react to, per
`CONSTITUTION.md` Art. IV (a standard is not overridden by code — a gap between the accepted ADR and
what real evidence now shows is reported here, not silently reconciled by editing either one).

## What changed since the ADR was accepted

The ADR's Slice 3 (T195, the preference import service) assumed camper elective preferences arrive
as **ranked choices per occurrence** — a director maps sheet columns to camper/group/activity/rank,
and a linked multi-period choice is declared explicitly on the mapping screen. Round 1 of T195 built
exactly that (preserved in git history at commit `d140614`, not on the tip).

Real camp artifacts, examined **outside this repo** (never copied or reproduced into it — see the
handling discipline in T195's ticket), contradict that premise on two points:

1. **Camper preferences are not ranked-per-occurrence.** The evidence shows either (a) a global
   1–25 ranked list — a camper ranks every elective they'd consider once for the whole session, not
   once per time slot they could take it — or (b) a chosen-schedule-plus-alternates planner — a
   camper (or their family) picks a specific schedule and names alternates if a choice is full.
   Neither matches "rank these N choices for THIS occurrence" repeated per slot.
2. **Multi-day/double-period linkage is an offering-catalog property, not a camper expression.**
   The camp's chugim/activity catalog itself declares that "Water Ski" spans two periods, or repeats
   Monday/Wednesday/Friday — it is not something a camper indicates when ranking their preferences.

Neither the real preference format nor the real linkage convention arrived as an artifact this repo
can read directly — see T195's ticket for the "no real camp artifacts in this repo" handling rule and
T218/T219 for where the still-unknown pieces (the actual third-party export format; the actual
linkage glyph/delimiter convention) are tracked as open, unscoped follow-ups.

## What this means for T195 (already re-scoped on this branch)

T195 is re-scoped to **offering-grid import only**: a day × period grid of elective OFFERINGS
(the camp's catalog), never a camper's preferences. No campers, no ranks, no identity, no
assignment. See the rewritten `docs/work/tickets/T195-preference-import-service.md` for the shipped
scope. The round-1 preference-import code is removed from the tip (parked, recoverable from git
history at `d140614`) — not deleted from history, and not silently reused for a purpose it was never
validated against.

## What this means for T196 (the elective solver — NOT yet built, flagging a spec risk)

T196's spec, as accepted, assumes "for each independent occurrence, run a deterministic min-cost
max-flow assignment." **That decomposition does not hold** if the real preference format is a global
1–25 ranked list: placing a camper into "Water Ski" on Monday period 1 consumes that camper's
Water-Ski preference for the **entire week**, not just that one occurrence — occurrences of the same
activity are not independent when the underlying preference is global-per-activity rather than
per-slot. A chosen-schedule-plus-alternates planner has the same problem from a different angle: the
"choice" IS a whole schedule, not a per-occurrence rank, so decomposing it into independent
per-occurrence min-cost max-flow sub-problems would need to first explode a bundled choice into
occurrence-level preferences — and it is not obvious that decomposition preserves what a director or
family actually meant by the bundled choice.

**This is flagged, not resolved, here.** T196 has not been built; no solver code exists yet that
this amendment would need to change. The purpose of this section is to put the risk in front of the
owner before T196 is scoped, so the solver's actual input shape gets designed against the REAL
preference format rather than inheriting T195 round 1's now-rejected premise by default.

## Proposed amendment (for owner acceptance)

1. Strike or heavily caveat the ADR's Slice 3 description of a ranked-per-occurrence preference
   pipeline; replace with a reference to the offering-grid import T195 actually shipped, and an
   explicit "preference import is not yet built — the real format is a global rank list or a
   chosen-schedule-plus-alternates planner, and no importer for either has been designed" statement.
2. Add a note to Slice 4 (T196, wherever its design work begins) that the "independent occurrence"
   assumption in its current spec must be revisited against whichever real preference format is
   confirmed before implementation starts.
3. Record linkage as a **catalog** property (T219) rather than a preference-import property, and
   record the still-unconfirmed third-party export format as its own tracked gap (T218) rather than
   an assumption embedded in any accepted design.

~~**Do not edit the ADR itself. This is a proposal awaiting the owner's decision.**~~ *(Superseded: accepted 2026-09-18, landed as D14.)*
