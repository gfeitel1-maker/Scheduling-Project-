---
title: "Would an event-driven shape fix fixing, testing, and debugging?"
document_type: discovery
status: active
created: 2026-09-16
task_class: architecture
governing_docs:
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
related_adrs:
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-09-08-crdt-conflict-reconciliation.md
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
  - docs/adr/2026-09-04-projection-failure-detection-and-recovery.md
  - docs/adr/2026-08-04-repository-layer-policy.md
related_tickets: []
related_specs: []
---

# Would an event-driven shape fix fixing, testing, and debugging?

**Nothing here is implemented, and nothing here may be implemented without an ADR.** This is
architecture work under `ARCHITECTURE_STANDARD.md`; the human gate is ADR approval
(`CONSTITUTION.md` Art. IV). It ends in one recommendation with a confidence level, its evidence,
and the conditions that would make it wrong.

## 0. The question, and the predicate it is answered against

The owner's question, in their words: *would splitting the application into an event-driven
architecture be a different route to go for fixing, testing, and debugging?* The underlying claim
being tested is that the **shape** of the system is what makes those three hard.

**Success predicate for this document.** A recommendation is good here if it (a) states whether the
measured difficulty is caused by system shape or by something else, (b) is falsifiable — names what
would have to be true for it to be wrong, and (c) can be executed as small reversible tickets or
says plainly that it cannot.

**Non-goal of this document.** Choosing an implementation. No code, no schema, no vocabulary is
proposed as settled.

---

## 1. Two corrections to the premise before anything else

Per Art. I, code outranks prose. Two things in the framing this exploration was given do not match
the code, and both change the answer.

### 1.1 SQLite is not written *from* the document on the local write path

The brief states "writes go to the document first; the projection follows." On the local write path
the order is the reverse. `appendOp` (`electron/ops/operations.js:162`) runs, inside one
transaction:

1. `INSERT INTO operations (...)` — the ledger row,
2. `applyProjection(db, op)` — the SQLite row, projected **from the op**,

and only *after* that transaction has committed does it call `recordLocalWrite(...)` to mirror the
write into the Automerge document. If that mirror throws, the comment in the file says it plainly:
*"SQLite has this write and the document does not"* — and the failure is recorded in
`document_write_failures` rather than rolled back.

So the honest description of today's write path is **dual-write with SQLite-first ordering**, not
document-source-of-truth-with-a-derived-projection. The document *is* authoritative for
**replication** and for **remote** changes — `electron/automerge/projector.js` genuinely rebuilds
SQLite from the document, its header says "SQLite is DERIVED, not authoritative", and
`rebuildFromDoc` / `projectAll` exist — but locally, the document is the second writer, not the
first.

This is not a defect report; the dual-write is deliberate, guarded, and instrumented
(`documentWriteFailures.js`, `check_projection_health`, ADR 2026-09-04). It matters here only
because **"the document is already the source of truth, so events are already primary" is not a
safe premise to reason from.** It is half true, and the half that is false is exactly the half an
event-driven proposal would be touching.

Recommend recording this as an Art. I drift note against `docs/current/PLATFORM_STATE.md` if that
document states the doc-first ordering; it is stale prose, not a code defect.

### 1.2 `SHORESH_SYNC_ENGINE=oplog` still exists as a live branch

`electron/sync/automerge/syncEngineFlag.js` still resolves an env var, and `appendOp` still
early-returns `'engine-off'` on that branch. Stage 6 retired op-log *replication*; the flag that
selected between the two engines is still readable in shipping code. Any event-driven proposal
has to say what happens to that branch, because a second write-path selector is precisely the kind
of thing a third one compounds.

---

## 2. Diagnosis: is this architecture, or is it test seams?

**It is both, but not in equal measure, and they are separable.** The measured slowness is a
fixture/coupling problem that an event rewrite would not touch. The debugging opacity is genuinely
a shape problem — but a much smaller one than "event-driven architecture" implies.

### 2.1 The testing pain is fixture cost, and it is already being fixed without touching shape

From the T188 measurement ticket (branch `claude/t188-gate-tiering`, measured 2026-09-16 at
`d920ce8`, 4 cores):

| Fact | Value |
|---|---|
| Full gate | ~1174s (19.6 min) |
| `test` alone | 1015s — **87.2%** of the gate |
| Test files / tests | 439 / 5893 |
| Largest single file-time | `eslint.supabase-ban.test.js`, 136.1s — an **ESLint** run, not a fixture |
| Per-test schema rebuild | 304ms × 68 files ≈ 330s |
| Measured fix | prebuilt-schema fixture, **4.2×** on the converted files |
| Parallel speedup on 4 cores | **1.31×** — the suite is ~3× slower than its own CPU cost implies |

Counted independently for this document: **138 of 439 test files (31%) open a real SQLite
database** (`openLocalDb` / the new template fixture).

Three of the four largest cost lines have nothing to do with architecture:

- The single biggest file is a **duplicated full-tree ESLint pass** — a redundancy inside the test
  suite. No architecture in any shape removes it; deleting one test call does.
- The schema-rebuild cost is **fixture construction**, already measured and already 4.2× improved
  by a template copy. An event log does not make building a schema cheaper.
- The 1.31× parallel speedup is **vitest process/isolation configuration**. Same conclusion.

The fourth line *is* shape-related: `electron/main.test.js` is 2566 lines / 161 tests, all driving
`makeHandlers(db, deviceId, {...})` against a real database. But note what that already is — a
**dependency-injected seam**. The handlers are a factory taking `db` as a parameter, separated
from `ipcMain.handle` registration (`electron/main.js:187` vs `:2114`). The tests do not need a
new architecture to reach the code; they already cross a clean seam. What makes them expensive is
that the **adapter behind that seam is a real SQLite file**, and there is no second adapter.

**Conclusion on testing: this is a test-seam and fixture problem, not an architecture problem. An
event rewrite would not touch it.** Stated plainly because the evidence says so.

### 2.2 The existence proof the repo already contains, and its actual lesson

`src/engine/buildSchedule.js` (879 lines) is pure, seeded, and tested by a 1922-line test file with
no fixture at all. It is the counter-example cited in the brief, and it is a real one.

But the lesson is narrower than "make everything pure." `buildSchedule` is pure because
**scheduling is a computation over inputs**. Placing an activity by drag is not a computation; it
is a durable mutation with concurrency, authorization, and replication attached. You cannot purify
a write. What you *can* do is extract the **decision** from the **effect** — which is a deep-module
question, not an event-sourcing one, and §5 takes it up.

### 2.3 The one place where shape genuinely is the problem

The write seam's unit is **a single field**, and the caller's unit is **a user action**. That
mismatch is real, it is load-bearing, and it is where every one of the three pains meets.

`src/localClient.js:61` — `write(token, entity, entity_id, field, value, parent_op_id)`: one field,
one IPC round trip. `src/data/scheduleRepository.js:65` — `writeFields` loops that call, awaiting
each, and **throws on the first failure**:

```js
for (const [field, value] of Object.entries(fields)) {
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
}
```

Now count what one drag costs. `replaceSlot` (`src/screens/schedule/useSlotMutations.js:527`)
writes, per row, the occupant triple (`activity_id`, `elective_set_id`, `event_id`) plus `flags`
— four fields — across the target row, the source row, and every freed span-tail row. **A single
drag of a two-block activity is routinely 12–16 separate, individually-committed field writes with
no shared transaction.**

Three consequences, all observable in the code rather than hypothesized:

1. **A user action is not atomic.** A failure on write 7 of 16 leaves seven fields committed,
   projected, and replicated to peers, and raises an exception. The renderer then rolls back its
   *optimistic UI state* — so the screen and the database disagree, and the database is the one
   that is wrong.
2. **The correlation exists and is thrown away.** `useSlotMutations` mints a `gestureId` /
   `claimId` per user action and threads it through the per-cell write queue — and it **never
   crosses the IPC boundary**. It is renderer-local serialization. The `operations` table
   (`schema.sql:304`) has `seq`, `id`, `entity`, `entity_id`, `field`, `value`, `author_user_id`,
   `device_id`, `timestamp`, `parent_op_id`, `client_write_id` — and **no column that groups the
   16 rows one gesture produced**.
3. **The ordering constraint is invisible at the seam.** `writeFields`' comment records that field
   order is load-bearing (`kind` must be written first for `schedule_templates`). That is an
   interface obligation carried in a comment on the caller, which is the definition of a shallow
   interface.

---

## 3. The three pains, named from the repository

### 3.1 Fixing

The unit of a fix is frequently smeared across four files that must agree. The repo's own recorded
history is the evidence:

- **Registration that fails silently.** `ARCHITECTURE_STANDARD.md` §2 records that an entity
  missing from `PROJECTIONS` has its writes *succeed at the op-log and never materialize*, and
  that this has cost real debugging time **twice** (`schedule_templates`, `schedule_snapshots`).
  That is a shape problem: two registries that must agree, with silence as the failure mode.
- **Value coercion as a 60-line comment.** `coerceOpValue` exists because `better-sqlite3`
  *misinterprets* un-coerced JS values, and its read-side counterpart (`normalizeSlots`) covers
  only the columns it happens to name. The comment says so: any future object- or boolean-valued
  column needs a matching case added there "or the renderer silently reads back the raw stored
  primitive." A fix in one place requires a hand-remembered edit in another.
- **Fixtures built from the code rather than the schema.** The memory of T62 — a test hand-built
  an `activity_id` column `anchor_activities` never had, stayed green for a month while the engine
  double-booked Lunch — is the same failure class T188 hit again writing the schema template.

None of these three is caused by "not being event-driven." All three are caused by **two or more
places having to agree, with no mechanical check that they do.**

### 3.2 Testing

Covered in §2.1. The additional shape-specific cost: because the write unit is a field, a test of a
user-level behaviour must assert over N field writes and their order, which is why
`useSlotMutations.test.js` is 2662 lines — larger than the 1705-line module it tests.

### 3.3 Debugging — what a developer cannot answer today

This is the sharpest section, so it is stated as questions.

**Answerable today.** *What is the current value of this field?* (SQLite, or the document.) *Who
last wrote it, from which device, and was it a human or the importer?* (`operations`, plus
per-field provenance — ADR 2026-09-09.) *What did this record contain before it was deleted?*
(`operations`, via `trash.js` / `restore.js`.) *Did the projection drift from the document?*
(`check_projection_health`, `rebuild_projection_from_document`.) *What did the importer ask and
what did the director answer?* (`import_decisions`, T173.) This is genuinely good coverage and
should not be undersold.

**Not answerable today:**

1. **"What single user action produced these rows?"** There is no correlation key. Sixteen op rows
   from one drag are sixteen unrelated rows sharing a timestamp to the second.
2. **"Did that action complete, or partially fail?"** `writeFields` throws to the caller; the
   caller shows a banner. Nothing durable records *"gesture X wrote 7 of its 16 fields."*
   `document_write_failures` and `sync_health_events` cover the SQLite↔document divergence, which
   is a different failure.
3. **"Why is this cell empty?"** — the director's actual question. Empty because the engine found
   it unfillable, because someone cleared it, because a span-tail release freed it, or because a
   peer's concurrent edit won a merge. The `operations` ledger records *that `activity_id` became
   null*, never *which of those four things happened*. The intent is destroyed at the
   `localClient.write` boundary.
4. **"What did this device's state look like at 14:30?"** The op-log is local-history only and no
   longer a replay mechanism; the Automerge document holds current state plus its own change
   history, but there is no tool that reconstructs a past state for inspection.
5. **"In what order did two devices' changes interleave?"** Timestamps are wall-clock strings from
   two machines. CRDT merge order is not recoverable from `operations`.

**Items 1–3 are the same defect**: intent is not recorded, only its field-level residue. Item 4 is
a tooling gap. Item 5 is inherent to CRDTs and is not worth chasing.

---

## 4. What full event-sourcing would actually do here — and why it re-opens a settled decision

### 4.1 It competes with the Automerge document; it does not complement it

An event-sourced system derives current state by **replaying an ordered log**. A CRDT derives
current state by **merging unordered changes**. These are two answers to the same question, and a
system cannot have two sources of truth for the same state without one of them being decorative.

Stage 6 already chose. The op-log was retired as the replication mechanism *specifically because*
the reshape in ADR 2026-09-08 (flat record shape) removed the correctness regression that had been
holding the cutover open — the ADR is explicit that "retiring the op-log becomes safe because of
this reshape." The cutover deleted ~14k lines of WS/replay code across PRs #339–#345.

**Making an event log primary again would re-litigate that decision at roughly its original cost,
and would reintroduce the class of defect the flat record shape eliminated by construction** — two
devices concurrently editing, one side lost, measured at 400 merges with zero preserving both
sides. That is the single clearest finding in this document.

Note the asymmetry that makes this worse than a neutral swap: the CRDT's merge semantics are what
make **offline multi-device editing** work without a coordinator. An ordered event log needs a
total order, which needs either a coordinator (the Host — reintroducing the asymmetry Stage 6 moved
away from) or a vector-clock/causal scheme (which is the CRDT, rebuilt by hand).

### 4.2 What would stop being possible

- Peer-to-peer merge without a designated orderer.
- The "different fields are different keys, so they cannot collide" guarantee.
- The current property that a fresh device can be brought up by shipping it one document, not a
  log whose replay must be deterministic across versions.

### 4.3 The part of "event-driven" that is genuinely worth having

Strip the replay and the source-of-truth claim, and what is left is **commands**: a named,
whole-intent unit at the write seam, recorded. `PlaceActivity`, `ClearSlot`, `SplitSlot`,
`ExpandSlot`, `ImportSchedule`, `GenerateSchedule`, `ResolveConflict`, `RestoreSnapshot`.

That is not event sourcing. It is a **deep module at the write seam**, and it answers every one of
debugging items 1–3, plus atomicity, plus the ordering-in-a-comment problem — without touching
replication at all. §5 takes it up as an alternative, because that is what it is.

---

## 5. Cheaper alternatives, compared honestly

Assessed against the deep-module vocabulary: depth = behaviour per unit of interface a caller must
learn; the deletion test = does complexity reappear across N callers.

### A. A command seam between the renderer and storage — `localClient.command(name, payload)`

One IPC call per user action. Behind it, one transaction, all N field writes, one durable
`command_id` stamped onto every `operations` row it produces.

- **Depth:** high. Callers learn one method and a vocabulary of intents instead of
  `write × N` plus an undocumented field-ordering rule. `writeFields`' ordering comment becomes an
  invariant inside the module.
- **Deletion test:** passes loudly — delete it and the ordering rule, the partial-failure handling,
  and the gesture correlation disperse back across `useSlotMutations` (1705 lines) and
  `scheduleRepository`.
- **Fixes:** debugging 1, 2 and 3; write atomicity; the optimistic-UI/database divergence.
- **Does not fix:** test wall-clock (it does reduce assertion sprawl in `useSlotMutations.test.js`),
  the ESLint duplication, the schema-fixture cost, `PROJECTIONS` registration silence.
- **Relationship to Automerge:** none. The document still records the same field writes; they
  arrive in one batch instead of sixteen. **No replication semantics change.** This is why it is
  safe.
- **Cost:** medium, and **fully incremental** — a command handler can wrap the existing
  `writeFields` body on day one and be narrowed later, one intent at a time, with `write` staying
  available throughout.

### B. Extract more pure functions at the `buildSchedule` boundary

Move decision logic out of `useSlotMutations` (what rows does this gesture touch; what does each
become) into pure functions over `(slots, timeBlocks, gesture)`, leaving effects thin.

- **Depth:** moderate. **Fixes:** a real share of the 2662-line test file, with no fixture.
- **Does not fix:** any debugging item, atomicity, or gate wall-clock.
- **Cost:** low. **Fully incremental**, function by function.
- Note this composes with A rather than competing: A's command body is the natural home for B's
  pure planner. `plan(gesture, state) → writes[]` is testable with no database at all.

### C. A second adapter behind the existing storage seam (in-memory / fake db)

The `makeHandlers(db, …)` seam already exists; only one adapter has ever satisfied it.

- **Honest assessment: do not do this.** Per the codebase-design rule, one adapter is a
  hypothetical seam. A hand-written fake for a 65-migration schema is a second source of truth for
  schema behaviour, and this repository has already been burned twice by exactly that (T62's
  hand-built column; T188's schema-template equivalence test). The prebuilt-schema template is the
  *right* version of this idea, it is already landed, and it is 4.2× — because it is a copy of the
  real database, not a model of it.

### D. Better projection-rebuild / time-travel tooling for debugging

Extend the existing MCP surface (`check_projection_health`, `rebuild_projection_from_document`,
`repair_projection_entity`) with a read-only "state as of" and "explain this field" view.

- **Fixes:** debugging item 4, and part of 3 once A exists to give it something to read.
- **Cost:** low. **Fully incremental.** But it is worth much less *before* A: today there is no
  intent in the ledger for it to show.

### E. Full event sourcing as primary

Covered in §4. **Cost: very high; not stageable; re-opens Stage 6; reintroduces a measured
correctness regression.**

### F. Do nothing architectural; finish the measured test work

Remove the duplicate ESLint pass (~135s), convert the remaining 63 files to the schema template
(~330s share), tune vitest parallelism (up to ~3×).

- **Fixes:** the entire measured testing pain, plausibly to single-digit minutes.
- **Fixes no debugging item and no fixing item.**
- **Cost: lowest of anything here, and it is already scoped and partly landed.**

---

## 6. Recommendation

**Do not adopt event sourcing. Do F first, then A, with B folded into A's implementation.**
Treat D as a follow-on that only pays off after A, and reject C and E outright.

**Confidence: high** on "not event sourcing" — this is the strongest claim in the document, and it
rests on a documented, expensive, recently-settled decision (Stage 6 / ADR 2026-09-08) plus the
measured 400-merge regression that decision fixed.

**Confidence: high** on "the testing pain is not architectural" — it rests on direct wall-clock
measurement: the single largest test file is an ESLint run, the second-largest cost is schema
construction already fixed 4.2× by a fixture, and the parallel speedup is 1.31× on 4 cores. None of
those three moves under any change of system shape.

**Confidence: medium-high** on the command seam (A). The *diagnosis* behind it is high-confidence
and directly observed — `localClient.write` is per-field, `writeFields` loops and throws on first
failure, a 12–16-write drag is not atomic, and `gestureId` dies at the IPC boundary. What is
medium is whether the **cure is worth its cost right now** relative to the other open programs, and
that is an owner call, not a technical one.

### Non-goals

- No change to replication, the Automerge document, the CRDT merge, or conflict reconciliation.
- No new source of truth. No replay-derived state.
- No removal of the `operations` ledger; A **adds a column** to it, it does not repurpose it.
- No rewrite of `ScheduleScreen` or `useSlotMutations` as part of A — the command seam is entered
  from where they already call the repository.

### What would have to be true for this recommendation to be wrong

1. **If the owner's real pain is gate wall-clock**, F alone is the answer and A is a distraction —
   in which case stop after F. (Evidence that would show this: the owner's next complaint after F
   lands is not about debugging.)
2. **If partial-write divergence is happening in practice**, A stops being a convenience and
   becomes a correctness fix, and should jump ahead of F. This is currently *unmeasured* — nothing
   counts how often `writeFields` throws mid-loop, and it would be cheap to find out.
3. **If a third device class or a server ever enters the picture**, the ordered-log argument
   changes and §4 would need re-deriving.
4. ~~**If the schedule grid's write pattern is atypical** — if most of the app writes one field at
   a time and the grid is the only multi-field caller — then A's leverage is much smaller than
   §2.3 implies, and B alone may be enough.~~ **CHECKED 2026-09-16 — refuted. See §6.1.** The
   pattern is app-wide, not grid-specific, and it is implemented nine times in five mutually
   incompatible ways. This falsifier is closed, and it moved the case for A *up*, not down.

### 6.1 Falsifier 4, checked: the multi-field write pattern is app-wide

A0's read-only half was run — a static sweep of non-test `src/`. The result is stronger than §2.3
assumed.

**Nine per-field write sites, not one.** Five hand-written `for (const [field, value] …) await
write(…)` loops, plus three setup screens routing through two shared repositories:

| Site | Partial-failure behaviour |
|---|---|
| `src/data/scheduleRepository.js:65` | throws on first failure; **no cleanup** |
| `src/data/setupCrudRepository.js:78` | throws; a *separate* `createWithFields` best-effort deletes the partial row |
| `src/screens/AnchorsScreen.jsx:349` | screen-local `cleanupPartialRow`, which **can be refused** — delete is admin-only — leaving a real orphaned row, as its own comment states |
| `src/screens/ActivitiesScreen.jsx:629` · `src/screens/CohortsScreen.jsx:172` | delegate to `setupCrudRepository` |
| `src/utils/ensureCohort.js:69` | swallows UNIQUE violations only; rethrows everything else |
| `src/utils/seedDays.js:60` | **no failure handling at all** — see §6.1.1 |
| `src/screens/specialDay/SpecialDayGridEditor.jsx:48` · `src/screens/event/EventGridEditor.jsx:68` | per-field `writeField` checks the result; the loop has no rollback |
| `src/screens/ImportScreen.jsx:1069` | inside the import commit path |

**Five mutually incompatible strategies for one hazard:** throw-and-leave, throw-and-cleanup,
throw-and-cleanup-that-may-be-refused, swallow-selectively, and ignore. Nothing reconciles them and
nothing could — the hazard lives below all nine, and each site invented its own answer to it.

**The ordering rule is re-derived in four places.** "Write `name` first, or a UNIQUE collision
leaves an orphaned partial row" appears as an independent comment in `ActivitiesScreen`,
`CohortsScreen`, `ensureCohort`, and — as `kind` first — `scheduleRepository`. Four hand-maintained
copies of one invariant the write seam does not enforce.

**This is the deletion test passing loudly.** The complexity a command seam would absorb is not
hypothetical future complexity: it is already dispersed across nine call sites in five shapes, one
of which documents a reachable orphaned-row outcome in its own comment.

Revised confidence on A: **high**, up from medium-high. What remains an owner call is sequencing
against the other open programs, not whether the seam earns its keep.

#### 6.1.1 A defect found on the way, unrelated to this recommendation

`src/utils/seedDays.js:60` writes up to four fields per day and **checks no result**:

```js
for (const [field, value] of Object.entries(fields)) {
  await localClient.write(token, 'days_of_operation', id, field, value)   // result discarded
}
```

Every other site in the table above inspects `result.status`. A write rejected here is invisible —
against the standing rule that every mutation surfaces its failure. Small, self-contained, and
independent of the command seam; it should not wait on it. **Filed as a finding, not fixed here**
(rule 6: this document reviews, it does not implement).


---

## 7. What it would cost, in ticket-sized pieces

Everything below is stageable behind existing seams. **Nothing here is a big-bang change**, which
is the point — and if any slice cannot be done reversibly, that is the signal to stop, not to
proceed carefully.

**Phase F — already scoped, no ADR (test-infrastructure human gate):**

- F1. Remove the duplicate full-tree ESLint pass from the test suite. ~135s. Red Hat must attack
  the "strictly weaker than an earlier gate step" claim.
- F2. Convert the remaining 63 files to the prebuilt-schema template. Mechanical, measured.
- F3. Vitest parallelism / `isolate` investigation. Red Hat on cross-test contamination.

**Phase A — requires an ADR (architecture):**

- A0. **Falsifier first.** ~~Count multi-field write sites across the app~~ — **done, §6.1: nine
  sites, five failure strategies, refuted.** The remaining half is live instrumentation (how often
  a loop actually fails mid-way), which needs production code and should ride along with A2 rather
  than block A1.
- A0b. **Independent of everything else:** fix `seedDays.js`'s discarded write results (§6.1.1).
  One file, no ADR, no dependency on A.
- A1. ADR: the command seam — vocabulary, the `command_id` column, the atomicity contract, and an
  explicit statement that replication is unchanged.
- A2. Add `command_id` (nullable) to `operations`, written by nothing yet. Migration + rollback
  plan; `database-sync` gates; Red Hat mandatory.
- A3. Introduce `command(name, payload)` on the IPC surface with exactly **one** intent
  (`ClearSlot` — smallest blast radius), implemented by wrapping today's writes in one
  transaction. `write` unchanged and still used everywhere else.
- A4. One ticket per additional intent, each independently revertible. `PlaceActivity` second,
  since it is where the 12–16-write gesture lives.
- A5. Fold B into each intent: the pure `plan(gesture, state) → writes[]` function is the intent's
  body, tested without a database.
- A6. Once the grid's intents are migrated, a decision point — **not a foregone conclusion** —
  about whether `write` should be narrowed or left as the general-purpose escape hatch.

**Phase D — follow-on, low cost, only after A2 lands:**

- D1. Extend the MCP debugging surface to group `operations` rows by `command_id` and answer "what
  happened here."

**Sequencing rationale.** F is cheapest and already measured. A0 is a falsifier and must precede
A1. A2 is inert by construction (a nullable column nothing writes) and is therefore the safest
possible first architectural step. Every slice after it is revertible by not using the new path.

---

## 8. Evidence register

| Claim | Source | Kind |
|---|---|---|
| Gate 19.6 min; `test` 87.2%; 439 files / 5893 tests; 1.31× on 4 cores; 4.2× fixture win | T188 measurement ticket, branch `claude/t188-gate-tiering` | measured |
| 138 of 439 test files open a real SQLite database | counted for this document | measured |
| `write` is one field per IPC call | `src/localClient.js:61` | code |
| `writeFields` loops and throws on first failure | `src/data/scheduleRepository.js:65` | code |
| One drag = 12–16 individually-committed field writes | `src/screens/schedule/useSlotMutations.js:527` + `occupantFields` triple | code, derived by reading |
| `gestureId`/`claimId` never crosses IPC | `useSlotMutations.js`, `useDragFSM.js`; absent from `localClient.js` and `schema.sql` | code |
| `operations` has no command/gesture correlation column | `electron/db/schema.sql:304` | code |
| SQLite is written before the document on the local path | `electron/ops/operations.js:162` (`appendOp`) | code |
| `SHORESH_SYNC_ENGINE=oplog` still selectable | `electron/sync/automerge/syncEngineFlag.js` | code |
| Op-log retired as sync, kept as local history | `electron/automerge/historyLedger.js` header | code |
| Retiring the op-log was made safe by the flat reshape; CRDT lost one side at 400/400 merges before it | ADR 2026-09-08 flat-record-shape | accepted ADR |
| Unregistered `PROJECTIONS` entity fails silently; cost real time twice | `ARCHITECTURE_STANDARD.md` §2 | normative standard |
| `makeHandlers(db, …)` is already a DI seam with one adapter | `electron/main.js:187` vs `:2114` | code |
| `buildSchedule` is pure, seeded, 879 lines / 1922 test lines, no fixture | `src/engine/buildSchedule.js` + its test | code |
| Nine per-field write sites across `src/`, five incompatible failure strategies | static sweep, §6.1 | measured |
| "write `name` first" invariant re-derived in four independent comments | `ActivitiesScreen`, `CohortsScreen`, `ensureCohort`, `scheduleRepository` | code |
| `seedDays.js` discards every write result | `src/utils/seedDays.js:60` | code |

**Agent selection (Art. VII).** This document was produced by **Governor** alone, as an exploration
with no code. **Omitted:** Architect (an ADR is the *next* step if the owner accepts A, not this
step); Maker (no code by instruction); Verifier (no gate run — the full gate is ~17 minutes and
single-occupancy on this machine, and nothing here changes executable behaviour); Red Hat and
Security (nothing to attack until an ADR proposes a concrete seam — both are mandatory on A1/A2);
Designer, Tester, Grader (no UI, no implementation, no work to score).
