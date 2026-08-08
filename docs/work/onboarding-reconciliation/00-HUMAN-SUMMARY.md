---
title: "Onboarding & Reconciliation — Human Summary"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Onboarding & Reconciliation — Human Summary

**Two pages, plain language. This is the product-owner-facing answer. The sibling docs carry the engineering detail.**

This is the synthesis of a current-state audit, a seven-lens independent team pass (Architect, Red Hat,
Security, Designer, Tester + two external-research sweeps), and product-owner decisions made 2026-08-08.
No production code has been written. This work stops here for your approval.

## The 12 questions the handoff asked

**1. What are we actually building?**
A *multi-source reconciler*. A returning camp brings the files it already keeps — last year's schedule, a
facility list, a staffing sheet — Shoresh proposes what it can recover, the director corrects the genuine
ambiguities, fills the remaining gaps in bulk, and re-importing a corrected file *updates* the setup instead
of duplicating or wiping it. The goal is to eliminate repetitive retyping without pretending a machine knows
why a director made every past decision.

**2. Why is this different from the importer Shoresh already has?**
Today's importer is genuinely good but single-source and one-directional: on a second import it either *skips*
name-matches (silently dropping your corrections) or *wipes the whole camp* and recreates it. It matches only
by name, has no memory across imports, discards location text, and knows nothing about staffing. This program
adds the missing spine: stable identity, safe field-level merge, a record of what's a guess vs confirmed, a
sense of *which value is newer*, plus Location and Staffing as real concepts and more than one source.

**3. What existing code/ideas survive?**
Most of the skeleton. The `read → propose → non-skippable preview → atomic commit` pipeline, the shared
grid-of-cells parser, the op-log commit (which already gives us undo, sync, and a clean boundary for future
tools), the inference the importer already does, and the per-screen "Download Template" spreadsheets you
already ship. This is a *generalization*, not a rewrite.

**4. What are the source families?**
Schedule, facility/map, location-config, staffing, and workbook/paste. Each is a small adapter that produces
the *same* kind of proposal; "not found in the schedule" means the source simply doesn't carry that concept —
not that the parser failed.

**5. What does Shoresh infer vs ask the director?**
It *infers* entities, frequency, and eligibility as reviewable proposals. It *asks* whenever a human must
decide: an ambiguous identity ("is 'Arts & Crafts' the same as your 'Art'?"), two sources disagreeing, an
older file about to overwrite a newer edit, a map label that might be an activity, a temporary staffing note,
and which Program something belongs to. It never silently merges two things that might be different.

**6. What role does Excel play?**
A pre-filled *enrichment workbook*, not a blank template — Shoresh exports what it already knows, you fill the
gaps or bulk-edit in the spreadsheet you're comfortable with, and re-import runs through the exact same
review-and-commit path as everything else. Not a separate back door.

**7. What role does the camp map play?**
It can *propose* a list of locations to confirm, rename, merge, or reject. That is the whole scope. Explicitly
**no** GIS, no walking-distances, no route optimization.

**8. What does staffing mean here?**
Three separate things kept distinct: a durable *requirement* ("Swim needs a lifeguard"), a seasonal
*assignment* ("Jamie this year" — replaceable, so people can change year to year), and a temporary
*availability* note ("out week 4"). One model serves both kinds of camp — those where staffing is a real
constraint and those where the activity runs regardless of who shows up. **Staffing never blocks the
scheduler**; when a requirement can't be met it flags the slot rather than refusing to place it, with a
per-activity option to make it strict.

**9. What decisions still require you?**
You've made the big ones (below). Remaining: the exact rule for detecting a "stale overwrite," the policy when
two devices confirm conflicting matches, and whether the three-look provenance styling becomes a design
standard. All are teed up for the ADRs, none block writing the docs.

**10. What is explicitly deferred?**
MCP/CLI, electives, special-event days, full staff *scheduling*, GIS, and — importantly — *turning on* the new
scheduling constraints in the engine. We model the data now; we enforce it later, deliberately, in its own
tested slice.

**11. What would the first usable version accomplish?**
You re-import a corrected schedule and every hand-edit you made survives, every field the file carries updates
(not duplicated, not wiped), and you *saw and approved* exactly that set of changes before anything was saved.

**12. Where does all the current work live in Git?** (see Repository Status below)

## Decisions you've already made (2026-08-08)

- PII is not a concern → staffing can live in the normal synced storage; the `SECURITY.md` note gets updated to
  record this.
- Both bulk surfaces — an in-app "Needs Attention" editor and the workbook round-trip — coexist behind **one**
  reconciliation layer, so the same task done two ways gives one result.
- The current per-screen templates are our prior art; we're not sourcing the old scheduler repo.
- The `replace`-mode footgun is fixed as its own standalone hardening ticket, independent of this program.
- Staffing enforcement: soft-flag by default, hard toggle per activity.
- Engine enforcement of the new constraints is deferred to its own slice; we model the shapes now (cheap and
  reversible) and turn on enforcement later.

## The one thing the review changed

The team's sharpest finding: our first design was *value-shaped* where it needs to be *time-shaped*. Knowing
*who* set a value isn't enough to protect a director — we also need to know whether an incoming value is
*newer or older* than what they already fixed, or a stale file quietly reverts a week of corrections while the
preview says "Updated: 14." The fix reuses machinery we already have (the op-log's per-field timestamps plus a
"which version was this file made from" stamp on exports); it doesn't add complexity. This is now a first-class
part of the plan.

## Repository status (plain language)

- **Main:** unchanged by this program and still your working baseline. (It did advance during this session from
  another line of work, and currently carries two unrelated modified test files — none of it touched here.)
- **Onboarding integration branch** `work/onboarding-reconciliation`: created off main as an isolated worktree
  at `~/dev/shoresh-onboarding`. It will hold *only* these synthesis documents until you approve the direction.
- **Active child worktrees:** none yet — implementation slices each get their own once we're past the gate.
- **Safe next action:** review these docs; nothing here changes how the app behaves.
- **Human Git action required:** NONE.

## What happens next

Per the handoff, **the program stops here for your approval** before any production code. When you're ready,
the first implementation move is the pre-S0 paper-design of the reconciliation plan's shape (against the
hardest cases), then S0 — a refactor proven to change nothing, guarded by a test that the imports you run today
produce byte-identical results. See `IMPLEMENTATION_SEQUENCE.md` for the full slice plan and `ONBOARDING_MODEL.md`
for the entry point into the rest.
