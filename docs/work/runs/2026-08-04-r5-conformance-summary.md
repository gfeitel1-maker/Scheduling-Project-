---
task: "Phase E (R5) — verify the code conforms to the amended repository-layer policy and retire stale layering language"
document_type: run
date: 2026-08-04
round: 1
status: pass
task_class: architecture
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T47-component-io-outside-the-approved-exception.md]
related_specs: []
related_adrs: [docs/adr/2026-08-04-repository-layer-policy.md]
selected_agents: [governor, verifier]
omitted_agents:
  - agent: architect
    reason: not-applicable
    note: nothing to design — the repository-layer policy was already decided in ADR 2026-08-04; this phase only verifies conformance to it. The exhaustive call-site enumeration was run as a read-only general-purpose audit, which is not a roster agent.
  - agent: designer
    reason: not-applicable
    note: no UI surface
  - agent: maker
    reason: not-applicable
    note: documentation-only; git diff main touches no file under src/ or electron/. The one code-level finding was filed as T47 rather than implemented.
  - agent: code-reviewer
    reason: not-applicable
    note: no code diff to review for plan alignment or maintainability; the documentation claims are checked by the Verifier's greps instead
  - agent: tester
    reason: no-predicate
    note: no director-visible behavior to evaluate
  - agent: security
    reason: not-applicable
    note: no auth, secret, IPC, or packaging change
  - agent: red-hat
    reason: not-applicable
    note: no change to stored shape, op-log, sync, or migrations
  - agent: grader
    reason: not-applicable
    note: no Tester/Security/RedHat reports exist to consolidate; the verdict rests on the Verifier's deterministic gate, not a score
deterministic_checks: [npm run test, npm run lint, npm run build, npm run check:governance]
human_gates: [product owner approved Phase E scope and the stop-after-E boundary]
verdict: pass
completion_evidence:
  - "Every direct localClient use in src/ enumerated and classified; zero non-conforming repository cases"
  - "Two component-IO violations found and filed as T47 rather than silently blessed as exceptions"
  - "Four architecture reports stamped as superseded in part; ARCHITECTURE_STANDARD.md §6 exception register added"
archive_when: superseded by a later conformance pass
---

# R5 conformance summary

Phase E of the 2026-08-04 architecture program. The repository-layer policy was decided and written
into `ARCHITECTURE_STANDARD.md` §6 in Phase A. This records whether the code actually conforms.

**Verdict: it does, with two known exceptions, both tracked in T47.** No repository needs to be
created. No abstraction was added for consistency's sake.

## The rule being tested

A repository is required only where a domain has meaningful shared persistence mapping,
normalization, batching, or access policy to centralize. No pass-through repositories. Two approved
shapes: `Screen → Hook → Repository → localClient` (complex mapped domain) and
`Screen → Hook → localClient` (simple domain). Components are presentational.

## Every direct `localClient` use in `src/`, classified

Exhaustive enumeration of non-test files.

| Category | Count | Verdict |
|---|---|---|
| Routed through `scheduleRepository` (complex mapped domain) | 1 repository, ~25 call sites inside it | Conforming |
| Hooks calling `localClient` directly (simple domain) | 4 hooks — `useCohorts`, `useDeviceMode`, `usePendingConflicts`, `useWeeks` | Conforming |
| Screens calling `localClient` directly (simple domain) | 13 non-schedule screens, plus `App.jsx` | Conforming |
| Bootstrap utilities (`ensureCohort.js`, `seedDays.js`) | 2 | Conforming in spirit; see note below |
| Infrastructure (repo construction, `getDeviceId`, `onOpApplied`, `onSyncStatusChanged`, pairing/token subscriptions) | ~12 | Not domain access; out of scope of the rule |
| Component IO — approved exception | 2 (`DeleteWeekDialog`, `DeleteRecordDialog`) | Conforming, registered in §6 |
| Component IO — **not** covered by any exception | 2 (`Sidebar`, `RecordHistory`) | **Violations — T47** |
| Non-conforming: duplicated mapping that should be a repository | **0** | — |

**Note on bootstrap utilities.** `src/utils/ensureCohort.js` and `seedDays.js` are one-shot
idempotent seeders called from `App.jsx`, each with a single call site. They fit the simple-domain
shape but the standard's two shapes do not literally name a "util" tier. This is a wording gap, not
a conformance problem, and does not warrant restructuring working code.

## Is an `activities` repository justified yet? No.

The ADR named `activities` as the strongest future candidate but required *evidence of repeated
mapping or access divergence across call sites* before creating one. That evidence still does not
exist:

- **Two** places write activity fields: `ActivitiesScreen.jsx:339` (via a local
  `serializeFieldValue`) and `scheduleRepository.writeActivityFields`, which writes only the
  `is_locked` scalar. No shared mapping is duplicated.
- **Two** places normalize activity reads — `ActivitiesScreen.jsx`'s `normalizeActivity` and the
  shared `src/utils/normalizeActivityEligibility.js`. The second was *extracted from* the first
  precisely to remove duplication, and is deliberately narrower: `ScheduleScreen` depends on `null`
  meaning "no cap" for `max_per_week` / `max_groups_per_slot`, so applying the modal-facing defaults
  there would change behavior. That divergence is intentional, commented, and tested — not drift.

The nearest real duplication is not `activities` at all: `serializeFieldValue` is mirrored between
`ActivitiesScreen.jsx` and `AnchorsScreen.jsx`. But they cover **different entities and different
field sets**, so an activities repository would not absorb the anchors copy. What they share is a
four-line idiom (booleans → 0/1, arrays → JSON), and a repository is the wrong container for an
idiom. If it is ever consolidated, the right shape is a shared helper in `src/utils/` — and at two
sites, it is not yet worth it.

**Conclusion: the ADR's text remains accurate as written. Do not create the repository, and do not
open a ticket for it.**

## The worked precedent

`src/screens/schedule/useWeeks.js` (Phase D) is the policy working as intended in both directions.
It calls `localClient.duplicateWeek` directly and deliberately does **not** add a
`repo.duplicateWeek`: `duplicateWeek` and `deleteWeek` are multi-entity cascading Host transactions,
so a repository method would be a one-line pass-through with zero added mapping — exactly what the
ADR forbids. The reasoning is recorded in a comment at the top of the file with an ADR citation.

Meanwhile `scheduleRepository` continues to earn its place: it exists because it replaced three
separately-drifting copies of the same engine-slot → DB-row mapping, and deleting it would
reintroduce that triplication.

## Stale-language sweep

Checked `CLAUDE.md`, all of `docs/governance/`, `docs/current/`, `docs/adr/`, `docs/work/`, README
files, and inline comments in `src/` and `electron/`.

**Corrected:** all four architecture reports (`TARGET_ARCHITECTURE.md`, `BOUNDARY_AUDIT.md`,
`REPOSITORY_ARCHITECTURE_MAP.md`, `RESPONSIBILITY_MATRIX.md`) carried language asserting a mandatory
repository tier — variously "the single largest structural gap", "half-adopted", "structurally
unavailable", "necessarily bypass a tier that doesn't exist for them". Each now carries a
supersession banner at the top. The analysis beneath is preserved as dated evidence rather than
rewritten, because these are findings documents, not living law.

**Already correct, no change needed:** `ARCHITECTURE_STANDARD.md` §6 carries the amended policy in
full. `docs/adr/2026-08-04-repository-layer-policy.md` quotes the old four-tier chain, correctly
framed as the superseded rule. `docs/current/PLATFORM_STATE.md` makes no repository-tier claim at
all. `CLAUDE.md` is silent on the repository tier. Inline comments in `scheduleRepository.js`,
`useSlotMutations.js`, `useGeneration.js`, `useSnapshots.js` reference "the T28 repository"
descriptively without asserting a universal tier.

**Correctly frozen, deliberately not edited:** closed tickets T28/T30, their run records, the
2026-08-01 decoupling design spec, multi-week slice specs, handoffs, and everything under
`docs/archive/**` and `legacy/**`. These are historical and describe the rule as it stood.

## Corrections to the audit reports' factual claims

| Claim | Reality today |
|---|---|
| "~15 non-schedule screens call `localClient` directly" | **13** screens (plus `App.jsx` and 2 utils) |
| "Three schedule-adjacent screens mix repository and direct calls **for the same entities**" | Three still import both, but **no longer for the same entities** — `ActivitiesScreen`/`GroupsScreen` use the repository only for week exclusions and `localClient` only for their own entity. Disjoint. `ScheduleScreen.jsx` has **zero** domain `localClient` calls. Finding resolved. |
| "`scheduleRepository` is the only repository" | Still true |
| "`ScheduleScreen.jsx:441, 448, 947` skip the repository" | Resolved by Phase D; those lines no longer exist |
| "`Sidebar.jsx:133-143` uses `window.shoresh` directly" | Resolved by Phase B; no `window.shoresh` remains in `src/` outside `localClient.js` |
| `PROJECTIONS` enumeration lists 18 entities | **19** — `users` was omitted |

## Open items

- **T47** — `Sidebar.jsx` and `RecordHistory.jsx` perform domain reads inside components. Both want
  extraction into simple-domain hooks. Neither needs a repository.
- The "util tier" wording gap noted above. Not worth a ticket on its own; fold into the next
  standard revision.
- **`npm run check:governance` is not clean, for reasons predating this program.** Six findings
  remain, all in two files from commit `c9c2436`: `docs/work/specs/multi-week-slices-2-3.md`
  (invalid status `awaiting-approval`; missing `created` and `archive_when`) and
  `docs/work/handoffs/slices-2-3-handoff.md` (missing `task`, `created`, `archive_when`).
  Deliberately not fixed here: choosing a status for someone else's spec would be inventing
  governance state rather than recording it. Whoever owns that slice should set the real values.
  Every document produced or touched by this program passes.
