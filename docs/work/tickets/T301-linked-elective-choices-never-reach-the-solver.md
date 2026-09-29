---
title: "The linked-choice tier is unreachable in the product"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-29-linked-elective-bundles.md]
related_tickets: [docs/work/tickets/T300-findings-name-activities-as-the-director-does.md]
archive_when: "a director can author an elective choice that spans more than one period, that choice reaches `buildElectiveAssignments` as `choices` + `choiceOfferings` from the real screen, a camper who ranks it is placed in ALL of its periods or none, and a run driven from the UI produces an `UNSUPPORTED_LINKED_CHOICE` finding when the data warrants one — OR the tier is deliberately retired and the dead code, schema and tests go with it"
---

# T301 — The linked-choice tier is unreachable in the product

Found while scoping [T300](T300-findings-name-activities-as-the-director-does.md). T300 fixed the
rendering of `UNSUPPORTED_LINKED_CHOICE`; this ticket is about the fact that a director can never
cause that finding, because the whole feature it belongs to is not wired.

## What exists

T247 built a **two-tier solver**. Tier 1 places *linked choices* — an elective a camper takes as a
SET across more than one period, placed all-or-nothing — before the ordinary per-occurrence pass.
`runLinkedChoiceTier` in `src/engine/buildElectiveAssignments.js` is complete, deterministic and
well tested, and it emits `UNSUPPORTED_LINKED_CHOICE` in three cases.

The storage exists too: `elective_choices` and `elective_choice_offerings` (both v66, schema
`electron/db/schema.sql`), and `elective_run_outer_snapshots` carries `is_linked_choice` /
`choice_label` (v76, T197).

## What does not, verified 2026-09-29

**1. The only production caller passes neither input.** `src/screens/elective/assignment/AssignmentPanel.jsx`
calls `buildElectiveAssignments` with `campers`, `occurrences`, `offerings`, `preferences`,
`attendance` and `lockedAssignments` — and no `choices`, no `choiceOfferings`. Both default to `[]`,
so `membersByChoice` is empty and `runLinkedChoiceTier` returns on its first guard. Nothing else in
`src/` passes them either; every other call site is a test.

**2. Nothing ever authors a linked choice.** `electron/ops/commitElectiveRun.js` writes
`elective_choices` rows with `is_linked: 0` HARDCODED. The engine already documents this and routes
around it — its own comment says "Deliberately NOT the `is_linked` column: nothing in this repo
writes it as 1 (commitElectiveRun hardcodes 0), so reading it would leave this tier permanently
dead" — and derives "linked" from *more than one member occurrence* instead.

**3. So the fallback definition is dead too.** The only writer of `elective_choice_offerings` is the
projection's parent stub in `electron/ops/projections.js`, an `INSERT OR IGNORE ... (id, choice_id)`
that carries no occurrence and no activity. A choice can therefore never reach two member
occurrences, so the derived definition of "linked" is never satisfied either.

Both the column-based and the count-based definitions of "linked" are unreachable, by different
routes. The engine's workaround for (2) is defeated by (3).

## Why it matters

- **A real product capability is built and paid for and cannot be used.** A camp that runs a
  two-period woodworking elective cannot express it; those campers get placed one period at a time,
  which is the exact outcome the `UNSUPPORTED_LINKED_CHOICE` message apologises for.
- **It is invisible.** Tier 1 returning early is indistinguishable from "no linked choices exist",
  so nothing reports the gap. Tests pass because they construct the inputs by hand.
- **Dead code that looks live is a standing hazard.** T300 spent real effort fixing a finding a
  director cannot see, and the next reader will too.

## The decision this ticket needed first — SETTLED

**Owner ruling 2026-09-29: yes, linked choices are wanted.** The retirement branch below is closed;
the work is an authoring surface, a writer, and the wiring from `AssignmentPanel` into the solver.
Designer before Architect before Maker, as this ticket already said.

_Prior: this section asked whether the feature was wanted at all, and said not to start
implementation before it was settled. It is settled._

Four further decisions were taken during design the same day and are recorded, with what each one
forces, in [the design spec](../specs/2026-09-29-t301-linked-elective-bundles-design.md): the unit of
a bundle is the **offering** (director picks the periods); division scoping is **fully general**; an
activity **may** carry more than one bundle, which a camper picks between; and a bundle's name is
**proposed and editable**, because that name is what a camper's sheet must match.

Two consequences worth carrying at the ticket level:

- ~~**T219 (multi-day catalog linkage) is the same feature, not a separate one.**~~ **CORRECTED on
  close, 2026-09-29 — this was too broad and T219 STAYS OPEN.** What is true: `deriveOccurrences`
  builds an occurrence per distinct `(day, time_block, tier)` cell, so a double period and a
  multi-day pair are structurally identical *as a bundle's membership*, and T301 needs no adjacency
  rule to express either. What does not follow: that T301 closes T219. Reading T219's own
  "Reshaped (2026-09-26)" section rather than its title shows it was narrowed to the **ingest
  half** — consume `linkageMarkers` (produced by `src/ingest/parseGridSchedule.js`, consumed by
  nothing) in the elective-grid commit path, so a camp's *imported offering sheet* yields linkage
  without a director re-declaring it by hand. T301 built the **authoring** half. Both halves are
  real and only one is done.
- **A model tension for whoever takes T219, recorded not resolved.** T219's reshaped design says a
  multi-span "occupies two real time blocks, rendered as one cell spanning both", via
  `span_blocks`/`is_span_head` — the slot-span chain. T301 deliberately does NOT use that chain:
  ADR D12 verified electives are excluded from spanning at four layers and chose the
  choice/member model instead, and decision 5 (arbitrary, non-contiguous periods) means the chain
  could not express a bundle even if that exclusion were lifted. So the two tickets currently
  describe multi-period electives with two different mechanisms. That needs settling before T219's
  ingest work picks one, and it is an ADR-level question, not an implementation detail.
- **There is one unsettled architectural decision, and it is the ADR's job, not this ticket's.** A
  bundle serving several divisions must expand to one choice PER division, because tier 1 excludes a
  camper who does not attend every member occurrence — and `deriveElectiveChoiceId(runId, labelKey)`
  keys on label alone, so those choices collide on one id. Three options and a preference are in the
  spec.

_Prior: ~~Do not start slice 1 before the ADR settles that.~~ Settled in
`docs/adr/2026-09-29-linked-elective-bundles.md` and delivered._

## Closed 2026-09-29 — all three slices on `main`

- Slice 1 (schema v81, bundle storage, `deriveChoices`, the rank-collision fix) — PR #629, squash
  `388631ee`.
- Slices 2+3 (the authoring control and the solver wiring) — PR #646, squash `9e216c29`.

A director can mark an activity as taken across a chosen set of an elective set's periods, name the
bundle, create more than one bundle for the same activity, and a camper who ranks one is placed in
every one of its periods or in none.

Two things found on the way, both fixed in branch and neither caused by T301:

- `buildAttendance` read `camper.division` while the parser has only ever produced
  `division_label`, so division scoping had never worked on a real sheet import since T229. Its own
  tests hid it by hand-building fixtures that matched the bug. Found only because the work was
  driven through the real UI.
- The engine changed twice, contrary to this ticket's first reading that it would not: a multimap
  rank broadcast so per-division choices each receive a camper's ranks, and a fix for tier 1
  falsely reporting that a cross-division camper "does not attend every period". Placement was
  correct in the second case; the findings surface was lying to the director.

CI caught three registry gaps that three reviewers and a verifier had all passed — each had run a
chosen subset of tests, and the defect sat where nobody chose. Adding a table in this repo is a
registration checklist, and the guards are the checklist.

## Slice 1 — LANDED (2026-09-29): storage, derivation, and the engine rank fix

[The ADR](../../adr/2026-09-29-linked-elective-bundles.md) settled the one open architectural
decision (the per-tier choice-id collision, D3) and two more it found while tracing the decision to
ground truth (the rank collision, D4; the sheet/bundle coexistence gap, D6 — routed to slice 3).
Slice 1 implements D1–D5, D7, D9 and D10:

- Schema v81: `elective_bundles` / `elective_bundle_periods` / `elective_bundle_tiers`, sibling
  storage to `elective_set_activities` (setup-level, not run-scoped), with `v81_down.js` rollback.
- `deriveLinkedElectiveChoiceId(runId, bundleId, tierId)` (`electron/ops/electiveDerivedIds.js`) —
  keys a bundle's per-tier expansion on the bundle's own opaque id, not its label.
- `src/screens/elective/assignment/deriveChoices.js` — the run-scoped derivation, beside
  `deriveOccurrences.js`, expanding an authored bundle into per-tier `choices`/`choiceOfferings`.
- The rank-collision fix (D4) in `src/engine/buildElectiveAssignments.js`: a labelKey-only
  preference now broadcasts its rank to every choice sharing that label, not just the lowest-id one —
  otherwise a bundle serving a second tier could never register a camper's rank against its own
  tier's choice, and that tier silently never placed anyone atomically, with no finding.

**Not done yet, and not this ticket's `archive_when` condition:** no authoring UI (slice 2, Designer
first per this ticket's own ordering) and `AssignmentPanel.jsx` does not yet call `deriveChoices` or
pass bundle-derived choices to the solver (slice 3, which also owes the D6 coexistence-policy wiring
in `commitElectiveRun.js`). A director cannot yet create or use a bundle from the app — this ticket
stays `open` until slice 3 lands.

## Slices 2+3 — LANDED (2026-09-29): the authoring control and the solver wiring

Landed together, deliberately: slice 2 alone would ship a control that writes rows nothing reads
(this project's standing rule against an inert control).

**Slice 2 — authoring.** `src/screens/elective/ElectiveSetDetail.jsx`'s `OfferingRow` grows an inline
disclosure (the app's existing idiom — `AssignmentPreview.jsx`'s `OccurrencePanel`,
`ActivitiesScreen.jsx`'s "More options") holding zero or more `src/screens/elective/BundleEditor.jsx`
instances plus a trailing "+ Add another bundle". The picker grid's cells come from
`src/screens/elective/assignment/deriveBundlePickerCells.js` (new, beside `deriveOccurrences.js`) — the
union of both candidate schedule routes' placed periods, since neither route is canonical, sub-labelled
where they disagree. `src/screens/elective/bundleOverlap.js` (new) resolves a bundle's effective
divisions and warns — a bronze caution, never blocking — when two bundles of one activity would collide
at the solver's tier 1. Deleting a bundle, or the offering it belongs to, cleans up its
`elective_bundle_periods`/`elective_bundle_tiers` rows (no FK cascade exists for this soft-pointer
storage, D1) — required by both cleanup paths, called out independently by two reviewers during design.
Only Delete is admin-gated; periods/scope/name stay editable for every role, matching capacity/minimum's
existing posture. `src/localClient.mock.js`'s `seedDemoCamp()` now seeds an elective set placed on the
schedule across two periods and two divisions, with three offerings, so the feature is demonstrable in
`npm run dev` without Electron.

**Slice 3 — wiring.** `AssignmentPanel.jsx`'s `solve()` calls `deriveChoices` fresh on every solve — both
the first-solve and the re-solve-from-stored-rows paths — and passes `choices`/`choiceOfferings` to
`buildElectiveAssignments`; tier 1 is reachable from the app for the first time. `commitElectiveRun.js`
re-derives the run's bundles at commit time (ADR D6): it persists a bundle's per-tier choice/offering
rows for the first time (the table's only prior writer was a no-op parent stub) and routes a camper's
sheet-derived preference for a label a bundle claims to that bundle's own choice for the camper's OWN
tier — never a separately-minted plain choice. **Mechanism chosen for the D6 coexistence policy:**
bundles are read from the db and re-derived via `deriveChoices` inside `commitElectiveRun.js` itself
(mirroring exactly what `AssignmentPanel.jsx` does at solve time), building a
`(labelKey, tierId) -> choiceId` lookup the preference-writing loop consults before falling back to the
plain-choice path. A camper whose own tier the claiming bundle's scope does not cover is **skipped, not
thrown** — the same posture this file already takes for a hand-edited preference (`preferencesHeld`) —
so one mismatch cannot fail the rest of a sheet's import; this is a deliberate, disclosed product-copy
gap the ADR left open (no finding is raised for it).

The invariant the ticket exists to prove — a bundle places identically whether the solve runs on the
freshly-parsed path or on a re-solve from stored rows — is pinned by a test in
`electron/ops/commitElectiveRun.test.js` that solves one bundle fixture both ways against the real
write/read-back path and asserts identical `elective_assignments`.

**This ticket's `archive_when` condition is now met**: a director can author a multi-period bundle from
the real screen, a camper who ranks it is placed in every one of its periods or none, and a run driven
from the real UI reaches the solver correctly. Left `open` for Governor to close after review rather than
self-archived here.

## Non-goals

- Not a change to tier 2, the per-occurrence pass every real run uses today.
- Not a re-litigation of T247's placement algorithm, which is tested and sound.
- Not a migration: whichever way the decision goes, the schema already supports it.

## Evidence to gather before implementing

- Drive a run from the real UI with a choice spanning two periods and confirm today's behaviour
  (each period placed independently) — the ticket's premise should be re-confirmed at the screen,
  not only by reading call sites.
- Confirm whether any camp fixture in `test/fixtures/preference-corpus/` expresses a multi-period
  set, which would say whether this is a real camp need or a speculative one.
