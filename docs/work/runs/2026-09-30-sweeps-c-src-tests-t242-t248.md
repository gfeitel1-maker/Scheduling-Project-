---
task: Sweeps PR C — four small src-side leftovers (T182 route-gate test, T266 mounted ImportScreen test, T242 conflicts deep-link, T248 export span fixture)
document_type: run
date: 2026-09-30
round: 2
status: pass
task_class: ui-ux-design
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/standards/DESIGN_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
related_tickets:
  - docs/work/tickets/T182-stale-anchor-duplicate-finding.md
  - docs/work/tickets/T266-ingest-pass-exclusivity.md
  - docs/work/tickets/T242-conflicts-screen-unique-kind.md
  - docs/work/tickets/T248-child-schedule-export.md
related_specs: []
related_adrs:
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  - docs/adr/2026-08-21-arbitrary-length-activity-span.md
selected_agents: [governor, maker, code-reviewer, red-hat, tester, verifier, grader]
omitted_agents:
  - agent: architect
    reason: no-predicate
    note: no new persistent data shape, no changed contract, no irreversible tradeoff — three test additions and one control on an existing card
  - agent: designer
    reason: not-applicable
    note: one link on an existing card reusing the file's inline link pattern and the Sidebar's own label; no new visual vocabulary
  - agent: security
    reason: no-predicate
    note: no auth, secrets, PIN, IPC, libp2p, or packaging surface touched; the only non-test edit is a renderer-local onNavigate call
deterministic_checks:
  - "npx vitest run src/screens/schedule/useScheduleData.test.js"
  - "npx vitest run src/screens/ImportScreen.passExclusivity.test.jsx"
  - "npx vitest run src/screens/ConflictsScreen.test.jsx"
  - "npx vitest run src/utils/exportSchedule.test.js src/utils/exportScheduleRoundTrip.test.js src/utils/exportWorkbook.test.js"
  - "npx eslint src"
  - "npm run build"
human_gates: []
verdict: pass
completion_evidence:
  - "Verifier PASS — named vitest gate, 10 files, 215/215 passed, EXIT=0"
  - "npx eslint src — EXIT=0, 0 errors (20 pre-existing warnings)"
  - "npm run build — EXIT=0"
  - "seam compliance — git diff --name-only origin/main names no hard-seam path; git status --porcelain clean"
  - "red-then-green, re-run by Verifier — route gate removed at useScheduleData.js:344: EXIT=1, 1 failed | 17 passed; restored: EXIT=0, 18 passed"
  - "red-then-green, re-run by Verifier — nav target pointed at a bogus screen key: EXIT=1, 2 failed | 28 passed; restored: EXIT=0, 30 passed"
  - "Grader — average 4.0, lowest dimension 4, PASS"
archive_when: all four leftovers are either closed or re-ticketed and this PR has merged
---

# Run: Sweeps PR C — src-side leftovers T182 / T266 / T242 / T248

> Written **before dispatch** per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

This run is one PR inside Build Board item `q-small-sweeps-batch` (owner ruling 2026-09-29: work the
small sweeps in sequence or in parallel where the team allows). Two peer Governors work the same
board item in parallel on `scripts/` and `docs/`. The owner is not available; brainstorming was
self-answered and unresolvable product questions are recorded as open points rather than guessed.

No ticket number is allocated, no schema version is bumped, and no ticket status is flipped — those
belong to whichever session closes the tickets.

## Brief

**Product outcome:** four small honesty gaps close. The manual schedule route is *proved* never to
show a finding that only means something on the generated route; the import screen's pin-only rule is
exercised through the screen a director actually uses rather than only through a headless plan build;
a director looking at a duplicate-day collision can get to the screen that fixes it instead of
reading about it; and the group Excel export is *proved* to carry every period of a multi-period
activity rather than assumed to.

**Success predicate:**
1. A hook-level test in `src/screens/schedule/useScheduleData.test.js` builds one anchor/regular pair
   and asserts, in the same test, that the **generated** route surfaces `ANCHOR_DUPLICATE` (positive
   control) and the **manual** route does not.
2. A new `src/screens/ImportScreen.*.test.jsx` file mounts `ImportScreen` and drives the pin-only
   rule (`derivePinOnlyActivityNames` at `src/screens/ImportScreen.jsx:770-771`) through to the
   reconciliation-resolution output, with `src/screens/ImportScreen.jsx` itself unchanged.
3. `src/screens/ConflictsScreen.jsx` renders a "Go to Days" navigation control on the
   `days_of_operation` unique conflict **only**; the other three hard-set entities still render no
   interactive element. `src/screens/ConflictsScreen.test.jsx:345-386` is amended to assert both
   halves.
4. `src/utils/exportSchedule.test.js` contains a multi-period fixture built in the shape the database
   actually stores, and asserts every period of the span appears in the group export rows — green,
   with `src/utils/exportSchedule.js` fixed first if it was red.
5. The named gates exit 0, and no file under the hard-seam rule below appears in
   `git diff --name-only origin/main`.

**What does not count as done:**
- A T182 test that would still pass with the `r === 'generated'` gate removed. Non-vacuity must be
  demonstrated by removing the gate, capturing the red, and restoring it — the plant is never
  committed.
- Editing `src/screens/ImportScreen.jsx`, `src/components/setup/ImportModal.jsx`, or anything under
  `src/screens/elective/`, `src/engine/`, `src/ingest/`, `electron/ops/`, `electron/db/`. Another
  worker owns those. A **new test file** that mounts `ImportScreen` is allowed; a change to the
  screen is not.
- A "Go to …" link on a unique-conflict kind that has no director-facing screen. `users`,
  `schedule_templates` and `camp_maps` deliberately have none — `ConflictsScreen.jsx:47-57` records
  why, and inventing a destination is worse than the honest gap.
- A span fixture invented for convenience rather than mirroring the stored row shape.
- A banner, a help paragraph, or any new CSS file (`CLAUDE.md` styling rule; the `scheduleGrid.css`
  exception does not extend outside `src/components/schedule/`).

## Premises verified before dispatch

`feedback_cite_the_line_in_every_brief` — every constraint handed to an agent carries a citation, and
two of the brief's own premises did not survive the check:

- **`span_blocks` is not a `template_slots` column.** It is a column on `activities`
  (`electron/db/localDb.js:273`, added at `:346-348`) and on `fixed_events`. A multi-period activity
  *on the grid* is stored as the `is_span_head` chain: a head row plus one real `template_slots` row
  per covered period, each carrying the **same** `activity_id` (or `event_id`) and
  `is_span_head === false` — see `collectSpanTails` at
  `src/screens/schedule/useSlotMutations.js:49-65`, and `project_arbitrary_length_span` ("adopt the
  is_span_head chain as sole representation … NO migration, NO new column"). The column is INTEGER in
  SQLite (`localDb.js:369`) and something on the read path coerces it; the Maker must cite that
  coercion rather than assume the renderer sees a JS `false`.
- **`onNavigate` is already threaded to ConflictsScreen.** `src/App.jsx:402-403` passes
  `{ campId, role, onNavigate: navigate, pendingConflicts }` for `resolvedScreen === 'conflicts'`.
  Only the component signature at `src/screens/ConflictsScreen.jsx:288` ignores it. **No `src/App.jsx`
  change is expected**; if one turns out to be needed that is a finding to report, not a licence.

Two further anchors confirmed: the destination screen key is `days` (`src/App.jsx` SCREENS,
`days: DaysScreen`) and the Sidebar names it exactly **"Days"**
(`src/components/layout/navSections.js:41`), so the label is "Go to Days".

Consequence for T248: because each covered period is its own slot row, `exportToExcel`'s
per-`(group, day, block)` lookup (`src/utils/exportSchedule.js:18-22` and `:36-41`) is expected to
find every tail already. The likely honest outcome is that the ADR's "not span-aware" leftover is
**stale for this criterion**, with the fixture as the proof. That is a legitimate result; a fix is
only made if the test is genuinely red.

## Task class and what it pulls in

`ui-ux-design` for T242's one control, and the run also spans `test-infrastructure` for the three test
additions. `task_class` is a scalar in `scripts/check-governance.js:150`, so the stricter reading is
recorded here in prose: the union of both `GOVERNANCE_INDEX.md` §3–8 rows applies.

| | |
|---|---|
| Standards | `DESIGN_STANDARD.md` (T242 control) · `TESTING_STANDARD.md` (the three tests) |
| Mandatory gates | test · lint · build. Integration is **not** mandatory — nothing here touches sync, auth, or schema (`TESTING_STANDARD.md` §1). Scoped to named files per the dispatch constraint; the whole-suite gate is the merging session's, and CI is the gate of record. |
| Human gate | none reached. `ui-ux-design` gates on changing a **token value** (none changed); `test-infrastructure` gates on changing a shared harness, setup file, or gate budget (none changed — `vitest.setup.js` and the gate list are untouched). |

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing |
| Architect | no | `no-predicate` — no persistent shape, no changed contract, no irreversible tradeoff |
| Designer | no | `not-applicable` — one control on an existing card, reusing this file's inline link pattern and the Sidebar's own label |
| Maker | yes | four disjoint sub-items, fanned to parallel foreground Makers, committed serially |
| Code Reviewer | yes | plan alignment: did the tests land where the tickets said, and is the seam rule respected |
| Verifier | yes | always — the only deterministic evidence source |
| Tester | yes | director's-eye on the T242 link only; honest UNVERIFIED if the `:5200` mock cannot produce a unique-value conflict |
| Security | no | `no-predicate` — no auth/secret/PIN/IPC/transport/packaging surface |
| Red Hat | yes | three adversarial questions worth asking (below) |
| Grader | yes | calibrated score from the four reports |

Red Hat's brief carries three specific questions rather than a general sweep: (1) does the T182 test
actually exercise the gate **site** in `useScheduleData.js:338-351`, or does it merely re-test the
engine's emission? (2) does the span fixture match the shape the database stores, or a convenient
one? (3) can the "Go to …" control appear on a kind with no screen — including through a fallback
branch or an unknown entity?

## Gates

All run by Verifier, each as `cmd; echo EXIT=$?` so the code comes from the invocation that produced
the output. The whole-suite gate was deliberately out of scope — it is ~11 minutes, past the
foreground ceiling, and CI is the gate of record for merging (`TESTING_STANDARD.md` §1).

| Gate | Result | Evidence |
|---|---|---|
| Named vitest (10 files, incl. `src/App.test.jsx`) | PASS | EXIT=0, 215/215 passed |
| `npx eslint src` | PASS | EXIT=0, 0 errors, 20 pre-existing warnings |
| `npm run build` | PASS | EXIT=0, dist built |
| Seam compliance | PASS | `git diff --name-only origin/main` names the run record, `docs/work/INDEX.md` and seven `src/` files; nothing under `src/screens/elective/`, `src/engine/`, `src/ingest/`, `electron/ops/`, `electron/db/`; `src/screens/ImportScreen.jsx`, `src/components/setup/ImportModal.jsx` and `src/App.jsx` untouched; tree clean |
| Non-vacuity, T182 gate | PASS | gate removed at `useScheduleData.js:344` → EXIT=1, 1 failed \| 17 passed, `AssertionError: expected true to be false`; restored → EXIT=0, 18 passed |
| Non-vacuity, T242 nav target | PASS | `screen: 'days'` → bogus → EXIT=1, 2 failed \| 28 passed (`expected to be called with ['days'], received ['bogus']`, plus the navSections vocabulary check); restored → EXIT=0, 30 passed |
| Non-vacuity, the three peer gate sites | PASS | each site planted individually → EXIT=1; restored → EXIT=0, 102/102 across the three files |
| Non-vacuity, T266 pin-only rule | PASS | Red Hat inverted the rule in `src/ingest/pinOnlyActivityNames.js` → both assertions red; restored, tree clean |

Both of the first two proofs were **re-run independently by Verifier** rather than read from a
Maker's log — a round-1 Maker reported a failure alongside `EXIT=0`, which cannot be true of one
vitest invocation, so its self-reported red was not accepted as evidence.

## Verifier verdict

**PASS** — all five predicate clauses verified mechanically, no clause left UNVERIFIED.

> Verifier alone writes this line and the `verdict` field. A FAIL or unresolved UNVERIFIED blocks
> a pass outright, whatever Grader reports (`CONSTITUTION.md` Article VII).

## Grader score

Average **4.0**, lowest dimension **4** (Resilience 4, UX friction 4, Code review 4). Pass is ≥ 4.0
with no dimension below 3. Security was omitted pre-dispatch with `no-predicate`, so it contributes
no dimension.

## What round 2 changed, and why there was one

Round 1 delivered all four sub-items and the named gates were green. Red Hat then reproduced three
findings — with plants, not arguments — and all three were closed rather than carried:

1. **HIGH.** The route gate T182 was written to protect is hand-copied at three further sites
   (`src/screens/ScheduleScreen.jsx:506-512`, `src/screens/schedule/useSnapshots.js:175`,
   `src/screens/schedule/useGeneration.js:243-245`) and none had a test. `useGeneration.test.js`
   mocks `computeFindings` outright, so inverting the gate on the restore path would have shipped
   behind a green suite. All three now fail under a per-site plant. This is the repo's standing
   "guard the choke point, not the instance" shape: the *proper* fix is one shared helper the four
   sites call, which is a refactor beyond a sweep — see the finding below.
2. **MEDIUM.** The T248 fixture's `is_span_head` values were decorative — replacing them with `999`
   and `'nonsense'` left the test green, because `exportToExcel` never reads that field. The comment
   foregrounded it, so the next reader would have believed the test constrained span handling. Fixed
   by making the claim true rather than vague: the comment now says the field is carried for shape
   fidelity only, that what is asserted is per-period coverage, and that cell merging is a separate
   unasserted question.
3. **MEDIUM.** `UNIQUE_CONFLICT_NAV_TARGET[conflict.entity]` inherited from `Object.prototype`, so an
   entity named `constructor` rendered a labelless button navigating to `undefined` — and that name
   arrives as unvalidated op-log data, which in a local-first app can come from a paired device
   merge. Guarded with `Object.hasOwn` and tested against real prototype keys. The destination key is
   now also tied by test to `navSections.js`'s vocabulary, because `src/App.jsx:399` falls back to a
   default screen for an unknown key and would have swallowed a retired Days screen silently.

Red Hat also **confirmed against the Governor's own suspicion** that the T266 test's dual-use control
is genuinely discriminating: inverting the rule in `src/ingest/pinOnlyActivityNames.js` turned both
assertions red. That closed the one gap its Maker had honestly declared.

## Findings carried forward

- **The ANCHOR_DUPLICATE route gate is still four hand-copied sites, not one choke point.** All four
  now have tests, so a break is caught — but the duplication itself remains, and the correct fix is a
  single shared "findings inputs for this route" helper the four sites call. That refactor touches
  `ScheduleScreen.jsx`, `useSnapshots.js` and `useGeneration.js` and is out of scope for a sweep.
  Needs a ticket.
- **`docs/work/tickets/T242-conflicts-screen-unique-kind.md:36` lists deep-linking under Non-goals
  while its status is `completed`,** and the code now does exactly that. The reversal is recorded
  only here. This PR deliberately flips no ticket status and edits no ticket (a peer Governor owns
  `docs/` in this batch), so the session that closes T242 must refresh that line.
- **The T242 control has never been seen in a running app.** Tester could not produce a
  `days_of_operation` unique conflict in the `:5200` mock and said so rather than describing a
  screenshot it did not take; the evidence is the rendered test DOM. A director's-eye look under
  `npm run electron:dev` is still owed.

## Open points (owner unavailable)

- **OP-0 (`check:governance` advisory):** `npm run check:governance` reports **no blocking findings**
  on this branch, but one advisory: `docs/current/PLATFORM_STATE.md` is behind the last structural
  change. Touching a screen is what that check counts as structural, so this run probably raised it.
  It was deliberately not fixed here — `docs/current/` is outside this PR's footprint and a peer
  Governor owns `docs/` in this board item. The merging session should run `/update-state` or confirm
  the advisory was already standing on `origin/main`.

- **OP-1 (T242 copy):** the `days_of_operation` card previously read "Rename or delete one on the Days
  screen." Turning that sentence into a control means the sentence and the label say the same thing
  twice. Self-answered: keep the explanatory line and add the link beneath it, because the line names
  the *action* (rename or delete) and the link names the *destination*. If the owner prefers the line
  collapsed into the link alone, that is a one-line change.
- **OP-2 (T248 scope):** if the fixture proves the group export already carries every period, the
  ADR's "group×day×block only, not span-aware" note is still true *as a statement about cell
  merging* — the export writes one row per period rather than one merged multi-period cell. Whether a
  director wants merged cells in Excel is a product question left open, not answered here.

## Decision

**PASS** — Verifier PASS with no unresolved UNVERIFIED clause, Grader 4.0 with nothing below 4, and
the three adversarial findings closed in round 2 rather than deferred. Not pushed, no PR, no merge:
that is the merging session's call, and CI is the gate of record for it.

Tester's UNVERIFIED-by-running-UI is recorded above as owed work, not as a passed check.
