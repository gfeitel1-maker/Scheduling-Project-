---
task: M0 — camp location / spatial model architecture assessment
document_type: run
date: 2026-08-15
round: 1
status: escalated
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: []
related_specs: []
related_adrs: [docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md, docs/adr/2026-08-09-s1b-host-local-aliases.md, docs/adr/2026-08-08-s5-readiness-six-state-model.md, docs/adr/2026-08-12-drag-live-write-serialization.md]
selected_agents: [governor, architect, red-hat]
omitted_agents:
  - agent: designer
    reason: not-applicable
    note: the visual model must follow the domain model, not determine it; Designer binds at the map-surface slice, not at M0
  - agent: maker
    reason: not-applicable
    note: M0 produces no production code by explicit instruction
  - agent: code-reviewer
    reason: no-predicate
    note: no diff to review
  - agent: verifier
    reason: no-predicate
    note: no code, therefore no gate to execute; Verifier binds at the first implementation slice
  - agent: tester
    reason: no-predicate
    note: no running surface to evaluate
  - agent: security
    reason: not-applicable
    note: no auth, secrets, PIN, LAN protocol or IPC surface at M0; binds mandatorily at whichever slice introduces facility-image/asset import
  - agent: grader
    reason: no-predicate
    note: Grader scores the five agent reports; at M0 only two exist and Verifier's deterministic input is absent, so a score would be uncalibrated
deterministic_checks: []
human_gates: [ADR approval before any implementation slice begins]
verdict: null
completion_evidence: []
archive_when: the spatial-model ADR is accepted or rejected by the product owner
---

# Run: M0 — camp location / spatial model architecture assessment

> Written per `WORK_RECORD_STANDARD.md` §5.1, and updated as agents return.

**Process note, recorded rather than hidden.** §5.1 requires this record to exist *before* the first
dispatch. It did not — Architect and the reference-research agent were dispatched first, and this
file was written while they ran. The selection below is the set actually dispatched, unedited. Rule
3 (missing evidence is disclosed, never converted into a passing result) applies to process
evidence too.

## Brief

**Product outcome:** Shoresh gains a coherent model of *place* — locations that exist as real things
the camp owns and schedules, rather than as text typed on an activity — so that the scheduler,
ingestion, and the coming reconciliation experience can all reason about where something happens.
A director may optionally draw that as a camp map; a director who does not want a map loses nothing.

**Success predicate for M0:** an assessment document exists that (a) states the current location
ontology with file:line evidence, (b) recommends exactly one minimum architecture with confidence
and evidence, (c) states migration, rollback and sync implications, (d) decomposes the work into
bounded slices, (e) names explicit non-goals, and (f) lists the product-judgement questions only the
owner can answer — and that document has survived an adversarial pass.

**What does not count as done:**
- A map feature, or any production code. M0 is architecture only.
- A menu of options handed to the owner without a recommendation (global workflow default #2).
- An assessment that accepts the handoff's premise that locations are already first-class. See below.

## Premise correction carried into the brief

The handoff memo §7 states locations "have recently been moving toward first-class status." The
audit contradicts this, and the contradiction is the most consequential fact of the initiative:

| Claim | Evidence |
|---|---|
| There is no location entity | `electron/db/schema.sql:267` — `location TEXT` is a nullable free-text column on `activities`. No `locations` table, no location id |
| Place identity is string equality | `src/engine/buildSchedule.js:186,202` — the engine's whole spatial notion is a map keyed `"${location}\|${dayId}\|${blockId}"` |
| Capacity of a place lives on the activity | `activities.max_groups_per_slot`, applied at `buildSchedule.js:224–235` against a location-keyed map shared across activities |
| Indoor/outdoor is a property of the activity, not the place | `activities.is_outdoor` |
| The repo already left a seam | `src/engine/readiness.js:138` declares `location` a `FORWARD_AREA` — "real areas the app will grow into but that carry no collection binding today" |

The handoff's M1 ("Location model corrections") is therefore misnamed: there is nothing to correct,
only to create. Architect was briefed to verify all of the above rather than inherit it.

## Task class and what it pulls in

`architecture` — per `GOVERNANCE_INDEX.md` §3–8 this governs:

| | |
|---|---|
| Standards | `standards/ARCHITECTURE_STANDARD.md` · relevant ADRs |
| Current-state reference | `docs/current/PLATFORM_STATE.md` |
| Mandatory gates | test · lint · build · integration — **at implementation slices, not at M0** |
| Human gate | **ADR approval** |

Implementation slices will additionally span `database-sync` (new table, migration, op-log
participation), which per §4 of the work-record standard means those slices take the **stricter**
gate list of both: integration is mandatory, plus fresh-vs-migrated schema equivalence.

**Rule 8 observation on `deterministic_checks`.** The enum is `test · lint · build · integration`.
An architecture-assessment round runs none of them, and the one mechanical check that does apply to
its output — `npm run check:governance` over the new documents — is not in the enum. Recorded as
empty rather than rounded to a value that would misreport what ran. This is a finding about the
enum's coverage of no-code rounds, not a defect in this run; it is not being fixed here.

## Agents

| Agent | Selected | Why / why not |
|---|---|---|
| Governor | yes | routing, premise correction, escalation to owner |
| Architect | yes | owns the ontology, the recommendation, migration and sync shape, and the ADR |
| Designer | no | the map is a representation of the model; specifying it now would let the picture determine the schema — the exact failure the handoff warns against |
| Maker | no | no production code at M0 |
| Code Reviewer | no | no diff |
| Verifier | no | no gate to execute; binds at the first implementation slice |
| Tester | no | no running surface |
| Security | no | no auth/secret/protocol surface at M0; mandatory at the facility-image import slice if that is recommended |
| Red Hat | yes | the handoff names eight attack vectors explicitly and asks for aggression |
| Grader | no | would score two reports without deterministic input |

**One non-roster agent was also dispatched:** a read-only reference-research pass on how shipping
products (camp management, institutional room booking, calendar resource models, timetabling
engines) model place. It writes nothing and holds no authority. It exists because
`docs/work/` history records a case where frame-based ideation alone produced a wrong architecture
answer that empirical product research reversed; it runs as a peer to Architect, not under it.

## Gates

| Gate | Result | Evidence |
|---|---|---|
| ADR approval (human) | pending | not yet reached — no ADR drafted |

## Verifier verdict

Not applicable this round — Verifier omitted for `no-predicate`. This is not a pass.

## Grader score

Not scored this round — see omission.

## Findings carried forward

- **CONFIRMED live defect** (Architect ran a deterministic engine probe): place capacity is
  order-dependent, and null/0 caps silently mean unlimited — reachable in every migrated and every
  imported camp. This is the substance of the initiative, not the map. Fixed in slice M2 with
  characterization tests first; must not be folded silently into a schema slice.
- **Three ADR-level invariants from Red Hat** (INV-1/2/3, recorded in the assessment's post-review
  addendum). INV-1 (deterministic device-identical backfill id) blocks the ADR — a `randomUUID` or
  `${deviceId}`-scoped id forks an already-paired fleet silently. These are engineering invariants
  the ADR must state; not owner questions.
- Pre-existing gap 16 (`permissions.ENTITIES` drift — `schedule_weeks` + both week-exclusion tables
  silently admin-only, no drift test) is out of scope for this initiative but should be its own
  ticket and fixed before M1 copies the buggy template.
- `claude/keen-kapitsa-c3c98c` is active in `src/components/schedule/**`. The optional map surface
  (M6) must avoid those files or wait; §21 overlap watch item, not currently a conflict.

## Decision

**M0 complete — recommendation stands, but owner's Q3 answer re-routes the program.**

**Owner decisions (2026-08-15):**
- Q1/Q2 (capacity cleanup): **fix and surface everything** — safe default (1), review items for
  was-unlimited-now-capped, disagreements, and near-duplicate names, all shown before regeneration.
  As recommended; INV-1's determinism invariant and the null→1 flag both stand.
- Q4 (closures): **per-week is enough** — `week_location_exclusions` confirmed as the mechanism.
- Q5 (outdoor): **stays on the activity for now** — no `locations.is_outdoor` in M1; deferral is
  clean (Red Hat confirmed).
- **Q3 (summers): YES — Shoresh should track summers/years.** Owner chose this against the
  assessment's recommendation, with the "separate program, locations waits behind it" consequence
  visible in the option text. **This is the pivotal decision.** Per §6B and §13-Q3, a season concept
  is a foundational change touching groups, tiers, days, activities, and time blocks — not a
  locations feature — and it may change the locations ontology itself (approach B was rejected
  *because* no season concept existed; that premise is now reversed).

**Governor routing consequence:** the locations v32 ADR is NOT drafted yet. "Track summers" spans a
1-week archive feature to a multi-month temporal-model program depending on what the owner means, and
that scope determines both the roadmap order and whether locations stay one entity (scoped by season)
or split. A second scoping decision is required from the owner before any architecture is designed.
Escalated back to the owner for the shape of "summer." Locations remain the eventual consumer either
way.

Approach A (one `locations` entity, capacity on the place, week-scoped availability, optional map)
is recommended with high confidence, converges with independent empirical product research, and
survived adversarial review with three fixable ADR-level invariants. Per `CONSTITUTION.md` Article IV
the human gate is ADR approval, and Q1–Q5 in the assessment §13 are product-judgement questions
reserved to the owner. No ADR is drafted and no code is written until they are answered. Next dispatch
after answers: Architect drafts the v32 ADR (amending `2026-08-10-ingestion-reconciliation-semantics`
D7) with INV-1/2/3 baked in, for owner approval.
