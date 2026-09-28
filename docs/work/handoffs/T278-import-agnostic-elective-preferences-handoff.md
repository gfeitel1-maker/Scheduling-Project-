---
task: T278-import-agnostic-elective-preferences
title: "Handoff: T278/T279/T285 import-agnostic elective preferences"
document_type: handoff
status: active
created: 2026-09-28
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md, docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md, docs/work/tickets/T285-preference-shape-adapters.md]
task_class: database-sync
archive_when: "PR #579 is merged and the identity-key and import-screen slices named in this handoff are closed, or a later handoff supersedes it"
---

# Handoff — import-agnostic elective preferences

Branch `claude/nice-wilson-d48dc8`, PR #579 (OPEN, **do not merge yet**, conflicts with main on two doc files only).
Worktree `.claude/worktrees/peaceful-keller-404ba9`. Schema **v79** (five columns) is allocated to this branch.

## The goal, in the owner's words

"i want this to be import agnostic... every camp will have their own form of imported material. our task is to
reduce the friction between that import and getting to a schedule."

Standing rulings, all normative, none to be re-litigated:

- **We read their data; we do not choose the format.** Never ask the owner which format to support.
- **Shape is not a reason to refuse ingest. Land it, then resolve it.** A question about what a shape MEANS is
  answered by landing the data and reporting the uncertainty — never by refusing, never by dropping the
  unreadable half, never by escalating the shape question to the owner.
- **Never say no at the machine interface.** The CLI/MCP bridge exists so an agent can drive the software; a
  refusal there is the bridge failing. Corollary the owner did NOT state but accepted: **accept anything from
  outside, be strict at internal seams** — a malformed internal call throws.
- **A planner grid is ONE CAMPER'S OWN SHEET.** It has no name column because identity comes from the
  submission. "No camper named" means one subject, not zero.
- **Electives are a schedule within a schedule.** Day/period structure already exists before an elective import;
  fixed/recurring events (Lunch, Instructional Swim, Shabbat) can never be electives. Electives may be nearly a
  camper's whole day.
- Pre-production: no users, no live data. Design the clean shape; no back-compat shims, no migration paths.
- Learning layer DEFERRED until the decision journal shows what is worth remembering. Not a trained model.
- Unattributed campers surface in the **attention surface**, not a bespoke screen. No banners.

## Where it stands

Design: `docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md` (proposed,
6 rounds, reviewed twice by Red Hat + once by Code Reviewer).
Tickets: T278 umbrella, T279 ETL spine, T285 adapters (both substantially implemented), T280/T281/T282 open and
unstarted.

**Done and verified:**
- Five resolvers under one rule: *never write a value you could not resolve without saying so.*
- 7 measured silent data losses → 0. 14 wrongful refusals → 0. Corpus: 35 committed / 5 loud / 0 silent.
- Coordinate stored as the child wrote it, separate from any one schedule's occurrence.
- Solver fix (`134551de`): coordinates resolve to occurrences at solve time; both scopes fold to BEST rank.
  Placement is now true — the reported `preference_rank` matches what the camper actually asked for in that cell.
- Schema v79: `campers.division_label`, `campers.is_unattributed`, `elective_preferences.rank_kind`,
  `.coordinate_day_label`, `.coordinate_period_label`.

**Open blockers, in owner-set order:**

1. **Identity key (NEXT).** An unattributed grid subject is keyed on the FILENAME STEM, so two children's
   planners both named `planner.csv` merge into ONE camper holding both children's contradictory choices — the
   one case the ADR says must always refuse, happening silently. Converse: the same child's file renamed forks
   them. Intended fix: key the provisional subject per-submission (content hash), and make attribution a
   **rekey** to the name-derived id so naming the child later does not fork them. Today `is_unattributed` has
   ZERO readers — no CLI arg, no MCP tool, no screen — so "resolvable later without re-import" is false as
   built. Surface unattributed subjects in the attention surface (owner ruling).
2. **Wire the import screen.** `src/screens/elective/assignment/AssignmentPanel.jsx` parse-side is UNTOUCHED by
   this branch: it still calls `inferPreferenceMapping(fileRows[0])` and `parsePreferenceSheet(rows, {campId,
   mapping})` with no catalog, no grid, no subject. **The director's real import path received none of the seven
   slices.** Every number above was measured through `scripts/preferenceSheetCli.js`. T279's `archive_when`
   asserts the import screen calls the same transform; it does not. Fix the code or amend the record.

## Traps this work has already fallen into — do not repeat

- **Reporting something instead of storing it.** The same defect recurred THREE times (coordinate keyed to a
  schedule's identity; residue instead of storing the coordinate; reporting a loss instead of landing the
  subject). The ADR diagnosed the pattern two rounds before it recurred twice more.
- **A measurement that cannot reach a surface reports green about it forever.** The probe corpus passes
  `occurrences: []` and runs no solve, so it cannot reach the engine. The solver defect survived five slices of
  green measurement; the first hand-driven run of that path gave a wrong answer.
- **Never verify a tree an agent is writing to.** Five misleading reds this session from sampling mid-edit.
  Wait for QUIESCENT.
- **A gate that prints nothing and exits 0 is not a pass.** Running `scripts/security-gate.js` from a different
  cwd makes `git ls-files` enumerate ANOTHER TREE and prints a full green pass line about it. Run gates from the
  worktree root; capture npm's REAL exit code to a uniquely-named file; quote the ✅/❌ verdict line.
- **Every adapter's first draft mischaracterised what it skipped.** "Never refuse" and "never mischaracterise"
  are one rule with two halves. Accepting a file and then describing it wrongly is not an improvement on
  refusing it.
- Non-vacuity: tests must enter at FILE BYTES and assert at the DATABASE. A test asserting a bucket changed, or
  merely no longer expecting "refused", proves nothing.

## Known limits, recorded not hidden

- The swim opt-out is reported but has no persisted home (owner question, open).
- `coverage.measurable` is wrong in the flattering direction for grid subjects (reported, unfixed).
- The probe's `classify()` returns COMMITTED for any write; its promised correctness read does not exist, so
  "35 committed" means "35 wrote rows", not "35 wrote the right rows".
- One NON-REPRODUCIBLE observation of a camper name persisted reversed ("Feldspar Ari"), once in 11 runs, cause
  unidentified. If real it is non-deterministic camper identity, which Automerge cannot converge. Warrants a
  dedicated repro attempt.
- T284 (#578) reopened the premise that mixed-version replication is out of scope; the reasoning used here to
  dismiss a v78/v79 field-drop concern rests on the ADR it questions.

## Before merge

Rebase onto main (conflicts: `docs/current/PLATFORM_STATE.md` keep-both, `docs/work/INDEX.md` regenerate with
`npm run index:work`), re-verify with a real exit code, and **confirm CI is green on the PR** — no checks had
reported as of this writing, and CI on a clean runner is the gate of record.
