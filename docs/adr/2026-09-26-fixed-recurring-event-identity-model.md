---
title: "Fixed events, recurring events and activities: one identity model resolved by id"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-26
task_class: architecture
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
related_adrs:
  - docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md
  - docs/adr/2026-08-28-fixed-vs-recurring-events.md
  - docs/adr/2026-08-22-event-internal-subschedule.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/adr/2026-08-09-ingest-fixed-event-routing-and-reviewable-units.md
related_tickets:
  - docs/work/tickets/T267-fixed-recurring-event-identity-model.md
---

# Fixed events, recurring events and activities: one identity model resolved by id

**Status: ACCEPTED.** The owner delegated the call on this ADR on 2026-09-26 ("you can make the
call on the adr... it does not need me. just get this done"); the orchestrating Governor accepted
it on his behalf the same day. One question is deferred rather than blocking: what the **UI** calls
each family (see "two families" below). That is a label choice for Designer, and it does not gate
implementation — the schema and resolution model are settled here.

## Why this ADR exists, and how it relates to the one from yesterday

`docs/adr/2026-09-26-ingest-category-exclusivity-and-anchor-identity.md` (merged, `c711ecaf`,
**Option A recommended, not yet implemented**) already did the hard diagnostic work on half of
this problem: `anchor_activities` resolves to its catalog activity **by name**, there is no
`activity_id` column and never has been, and that name-only link is the direct cause of a defect
that reached production silently for a month (T62) and is about to cause a second one (the
category-exclusivity leak). That ADR's Option A — give `anchor_activities` a real `activity_id`
foreign key, add a role marker on `activities` so a pinned row stops appearing in free-choice
pickers, delete the name-matching fallback — **is this ADR's foundation, not an alternative to
it.** T267 exists to:

1. **Carry Option A to closure** — the previous ADR proposed it; nothing has been built.
2. **Answer the question that ADR explicitly left open**: is `anchor_activities` (the thing with
   `kind IN ('fixed','recurring')`) the same *family* as the separate `events` table (Field-Day-
   style constructs with their own internal sub-schedule)? The owner named this vocabulary
   confusion directly and it has to be ruled, not deferred again.
3. **Rule what T266's `activities.catalog_role` column becomes** inside that model, since it is
   arriving on `main` independently and overlaps in intent with the role marker Option A called for.
4. **State the vocabulary** the app will use going forward: fixed events / recurring events /
   activities.

If the owner has not yet ruled on the prior ADR's Option A vs B, **this ADR assumes A** — B
(collapsing `anchor_activities` into `activities` entirely) is rejected here for the same reason
it was rejected there: disproportionate to the reported problem, and it would still need
everything below built on top of it. Nothing here is compatible with Option C or D alone.

## The observable success predicate, in the owner's words

Today: two different rows can claim to be "the swim class at 10am" — one in the free-choice
activity list, one in the anchors list — connected only by spelling the name the same way. Typing
a space differently, or a director renaming one and not the other, silently breaks the connection
with no error anywhere.

**After this change:**

- A fixed or recurring event and its catalogue activity are **the same row wearing two hats**, not
  two rows that happen to match by name. Renaming it in one place renames it everywhere it appears.
- The catalogue (the free-choice activity list a director drags onto the grid) never shows a
  pinned event. The event still shows up on the generated grid, at its pinned time, **exactly
  once** — never zero times, never twice.
- If the app ever cannot tell which catalogue row a fixed/recurring event refers to, it says so
  loudly (a red finding, a refused schedule generation) instead of quietly scheduling nothing or
  scheduling it twice.
- "Events" in the app continues to mean two different, clearly-separated things a director already
  understands from using it — the pinned daily/weekly items (Lunch, morning line-up) and the
  special one-off constructs with their own internal mini-schedule (Field Day) — and this ADR does
  not merge those two, because they are not the same kind of thing (see the ruling below).

**Non-goals:**

- Not a UI redesign of the Anchors screen, the Events screen, or the Roots census tiles. Screen
  *shape* is unaffected; only how a row's identity is stored and resolved changes.
- Not a fix for the elective preference model (per-cell vs global) — untouched, unblocked by this.
- Not T264 — no mechanism for it is proposed, designed, or referenced.
- Not a rename of the `events` table, its sub-schedule tables, or anything about Field-Day-style
  events. This ADR is scoped to `anchor_activities` and its relationship to `activities`.
- Not a back-compat shim. Pre-production, one user, standing preference for a clean cutover.

## Candidate approaches considered (divergent pass)

Five cognitive frames were run in parallel before converging (regulator, biology,
remove-the-load-bearing-assumption, 3am-on-call, 10-year-old — full transcripts available on
request, not reproduced here). The frames converged on the same handful of underlying angles
despite starting from unrelated vantage points, which is itself evidence for the recommendation:

- **"Identity is a stored id, not a cached resolution"** (regulator: two-key identity with audited
  renames; 3am: validate at write time inside the same transaction; 10-year-old: "give it a secret
  handshake made up the day it's born"). This is Option A's core move, arrived at independently
  five different ways.
- **"One spine, many expressions"** (biology: one genome/activities.id expressed as different
  organ systems; remove-assumption: table-per-hierarchy with a shared abstract parent; 3am: "a
  single `schedulable_thing` identity table both resolve into"). This is the strongest candidate
  for *unifying* `anchor_activities` and `events` into one family — see why it is rejected below.
- **"Make the failure loud, not the resolution smarter"** (regulator: schema-level CHECK against
  ambiguity; 3am: nightly count of unresolved rows that pages; biology: autoimmune framing of a
  false name-match). This becomes the acceptance predicate (§ below), not a standalone option.
- **Traps identified and discarded:** probabilistic/diverging name+id pairs surfaced as a
  reconciliation flag (remove-assumption) — reintroduces exactly the silent-drift failure mode
  this ADR exists to close, just with a UI Band-Aid; derived-at-render "kind" with nothing
  persisted (remove-assumption) — loses the ability to filter/query by kind cheaply and contradicts
  the existing, already-shipped `kind` CHECK constraint for no benefit; two-tier concept/manifestation
  ids (remove-assumption) — solves a per-season-reset problem this app does not have (a camp's
  activities are not re-created each season) and would be premature generality.

**Converged recommendation: Option A-continued** — a single `activity_id` on `anchor_activities`
(already the prior ADR's plan), a single role marker on `activities` (T266's `catalog_role`,
absorbed rather than duplicated — see below), and **two families, not one**, for
`anchor_activities` vs `events`. Confidence: **high** that identity must be by id and that the two
tables stay separate; **medium** on the exact display vocabulary, which is a product/naming call
the owner should confirm (flagged as an open question, not silently decided here).

## The ruling: `anchor_activities` vs `events` — two families

**Two families.** They model structurally different things, and the resemblance is in the English
word "event," not in the data:

| | `anchor_activities` (fixed/recurring) | `events` (Field-Day-style) |
|---|---|---|
| What it is | A pinned **placement** of an existing catalogue activity on the regular grid | A **freestanding construct** with its own internal mini-schedule |
| Owns its own groups/time-blocks? | No — uses the camp's groups, days, time blocks | Yes — `event_groups`, `event_time_blocks`, `event_slots`, seeded from the camp's but edited independently |
| Relationship to `activities` | Refers to (after this ADR: *is identified with*) one catalogue row | An event's `event_slots.activity_id` can reference **many** catalogue activities, one per internal cell — an event is a container, not a single activity |
| Cardinality | One row per pinned occurrence | One row per special day/construct, containing many internal slots |
| Appears on the main grid? | Yes, directly, at its pinned period | No — it has its own screen/sub-schedule; the main grid does not place it |

Collapsing these into one family would mean either forcing an `events` row (a container of many
activities) to pretend to be a single activity, or forcing `anchor_activities` (a single pinned
activity) to grow an internal sub-schedule it has no use for. Both directions violate
`docs/adr/2026-08-22-event-internal-subschedule.md`'s decision that an event's internal grid is
its own group/time-block space, and neither buys anything an owner asked for. The "remove the
load-bearing assumption" frame's `schedulable_thing` spine was seriously considered — it is
elegant on paper — but it is a shared-parent abstraction built for a distinction that does not
otherwise exist anywhere in this codebase, and the karpathy standard here is not "what is
structurally prettiest" but "what is the smallest correct thing." Rejected as premature generality.

**What does need to change:** the vocabulary collision is real and worth naming plainly, even
though the schema stays separate. Both are currently reachable as "events" in casual conversation
with the owner and in code comments. This ADR recommends the table `anchor_activities` be renamed
to **`fixed_events`** at the SQL/code level (the `kind` column already distinguishes fixed from
recurring within it, so one table covers both), while the existing `events` table keeps its name
unchanged, since it is a genuinely different, already-shipped concept with its own ADR lineage.
**Open question for the owner/Designer** (flagged, not decided here): what the *UI* calls each —
"Recurring/Fixed Events" vs "Special Events," or some other pairing that a director will not
confuse. That is a naming/IA choice, not an architecture one.

## The ruling: T266's `catalog_role` — absorbed, not superseded

T266 (merging to `main` imminently, currently declaring schema v75, `activities.catalog_role TEXT`
additive nullable column) is the role marker Option A called for, arriving under a different name
and slightly ahead of schedule. **T267 absorbs it rather than building a second mechanism.**
Concretely:

- `catalog_role` becomes the single field that marks a catalogue row as pinned (`'fixed_event'` /
  `'recurring_event'`, or a single `'pinned'` value plus the existing `anchor_activities.kind` as
  the source of truth for which — see the migration step below for the exact value set, which is a
  Maker-level decision within this ADR's constraint, not a further architectural one).
- Free-choice pickers and the elective offering pool filter on `catalog_role IS NULL`.
- **What must not happen:** a second, competing "is this row pinned" signal invented independently
  (e.g. inferring pinned-ness from the existence of an `anchor_activities` row pointing at it).
  There is exactly one authority for "is this catalogue row pinned": `activities.catalog_role`.
  `anchor_activities.activity_id` is the *link*; `catalog_role` is the *classification*. They are
  written together, by the same commit path, and nothing should reason about one without the
  other agreeing.
- **Scope of that claim, stated precisely because it is narrower than it first reads.** "One
  authority" holds for the **import path** (`src/ingest/buildPlan.js`), which writes both together.
  It does **not** hold for the **v77 migration backfill**, which matches on name alone and never
  reads `catalog_role` — deliberately. T266 shipped `catalog_role` with **no backfill**, and that
  absence is load-bearing rather than an omission (`electron/db/migrationDomainState.js:188-199`):
  a pre-v75 database cannot tell a free choice from a leaked event without re-running import-time
  inference, and CONSTITUTION Art. V forbids a migration deciding that for a director who never saw
  it. So the column is NULL on every row of every camp that has not re-imported since T266, and a
  backfill consulting it would classify **every** existing row as ambiguous — it carries no signal
  yet. Consulting `catalog_role` becomes worth revisiting in PR 2, once post-T266 imports have
  populated it.
- **Why the v77 backfill is nonetheless legitimate, given T266 refused to write.** The two are not
  the same act. T266 would have had to *invent classification data that exists nowhere* — "is this
  activity a leaked pinned-event artifact or a real free choice" is a judgement requiring the full
  import plan's `dualUseNames`, not derivable from a database snapshot. The v77 backfill restores a
  **join** the existing data already encodes, and it auto-resolves **only** the unambiguous
  single-candidate case; zero and two-or-more both refuse to guess and go to
  `fixed_event_identity_gaps`. A join is not a classification, which is why Art. V's clause does not
  transfer even though the post-v52 / document-modeled / `projectAll` clauses do — and those are
  exactly why the migration arms the domain-state marker rather than writing silently.

## The identity model (the technical core)

1. **`fixed_events`** (renamed from `anchor_activities`) gains `activity_id TEXT` — a soft
   reference (no SQL `FOREIGN KEY`, matching this table's existing FK-by-convention columns like
   `location_id`, and matching `elective_set_activities.activity_id`'s precedent) pointing at
   `activities.id`.
2. **Backfill at migration time**, resolving every existing row by the current name-match logic
   (`anchorNameKey`/`resolveAnchorActivityIds`'s fallback path) — this is the last moment that
   resolution is guaranteed correct, per the prior ADR's own reasoning. A row that resolves to
   zero or more-than-one catalogue activity is **not silently dropped or guessed**: it is written
   to a new SQLite-only table `fixed_event_identity_gaps (id, camp_id, fixed_event_id, name,
   candidate_count, created_at)` for a human to resolve post-migration (surfaced on the Roots/Setup
   screen as a finding, using the existing flag vocabulary — no new banner, per the repo's standing
   "no banners" rule). This is the concrete form of Option D's invariant, applied at the one moment
   automatic resolution is uncertain instead of at every read.
3. **After backfill, delete the name-matching fallback.** `resolveAnchorActivityIds` becomes a
   direct lookup by `activity_id`; `anchorNameKey`/`indexActivitiesByName` and their call sites in
   `buildSchedule.js` and `weekCatalog.js` are removed, not kept as a "belt." Per-production
   posture: no compatibility shim survives past the migration that made it unnecessary.
4. **Write path**: `electron/ops/ingest.js`'s `commitPlan` already proposes both the catalog
   activity and the anchor from the same source cell (this is *why* the category-exclusivity ADR
   calls the duplicate "not a duplicate — the event's identity"). It gains one additional write:
   set `fixed_events.activity_id` to the activity id it just created/matched, and set that
   activity's `catalog_role`, in the same commit. The Anchors screen's manual-entry path
   (`AnchorsScreen.jsx`) gets the equivalent: creating or renaming a fixed/recurring event either
   links to an existing catalogue activity or creates one, never a bare name.
5. **Invariant, enforced as a finding, not a silent pass**: every `fixed_events` row's
   `activity_id` resolves to exactly one live `activities` row. Zero matches (orphaned — the
   activity was deleted) or the row somehow pointing at a row that no longer exists both produce a
   red finding and, per the prior ADR's Option D, **refuse to generate a schedule** rather than
   silently placing nothing or placing it twice. This is the direct fix for the T62 failure class:
   the previous unit test could hand-build an object with a field the database didn't carry and
   stay green; this invariant is checked against the real table, at generation time, every time.

## What happens to existing Automerge document keys — the sync-safety analysis

This is a reshape of a **synced** entity (`anchor_activities` is one of the 27 camp entities in
`docs/current/WHERE_DATA_LIVES.md`'s table, registered in `PROJECTIONS.anchor_activities` and in
`MODELED_ENTITIES`), so the change is not a SQL migration in isolation — it changes what key two
devices agree a fact lives under.

- **The document key `anchor_activities` is the entity name inside `campDocument.js`'s
  `MODELED_ENTITIES` set and the key `applyWrite`/`reconcile` walk.** Renaming the SQL table to
  `fixed_events` **must rename the document key identically** — `PROJECTIONS['fixed_events']`,
  `MODELED_ENTITIES` updated, and the genesis-seed shape in `seed.js` updated. A rename that
  touches only `electron/db/schema.sql`/`localDb.js` and not `campDocument.js`/`projections.js`
  would silently split the fleet: an old-code device still writing under the key `anchor_activities`
  and a new-code device reading `fixed_events` would each see the other's writes vanish, with no
  error, no conflict row — exactly the class of failure `campDocument.js:330`'s own guard exists to
  catch for an *unregistered* entity, but a **renamed, still-registered** entity does not trip that
  guard, because both keys are individually valid entity names to the projector. This is the
  single highest-risk step in the whole change and is called out as its own PR/gate step below.
  - **Practical consequence for the one real device this app has today (the owner's):** because
    there is no live camp and no second device to disagree with, the safe order is: ship the
    document-key rename and the SQL rename in the **same commit**, verified by
    `electron/automerge/rebuildFromDocument.test.js`-style round-trip (seed → document → fresh-db
    projection) before merge, so there is never a moment where a persisted document uses one key
    and running code expects the other.
- **Every new field (`activity_id`) must be added to `PROJECTIONS.fixed_events.fields` in the same
  change that adds the SQL column.** `applyWrite` silently drops any field not in that allowlist —
  this is not a hypothetical, it is documented behavior at `electron/ops/projections.js`'s own
  comments and is the exact mechanism T266's `catalog_role` had to go through for `activities`.
  Skipping this step does not error; it produces a column that fills in locally and reads back
  empty after the next sync, which is worse than an error because nothing flags it.
- **`A.getConflicts`** (verified against the installed `@automerge/automerge@^3.4.1`, resolved via
  `package-lock.json` — no version-specific behavior change from what `campDocument.js`/
  `reconcile.js`'s existing comments already document for this project) walks document keys with
  no allowlist. Two devices concurrently writing different `activity_id`s to the same
  `fixed_events` row (e.g. one re-links it after a rename, the other after a merge) produces a
  same-field conflict, which already flows into the existing `conflicts` table/resolution UI —
  **no new conflict-handling code is required**, this falls out of the existing per-field CRDT
  model for free, exactly like every other field on this entity does today.
- **`catalog_role` on `activities`** is additive and already shipping in T266 under the existing
  `activities` entity/key — no document-key rename risk there, only the ordinary
  add-field-to-both-schema-and-PROJECTIONS step T266 itself already had to do.

## Blast radius (graph + grep, both run; graph's blind spot noted)

- **`graphify affected` for `anchor_activities` and `events` returned "No unique node match"** —
  these are SQL table name string literals, not indexed symbols; this is the documented graph
  blind spot (string/table-name references are invisible to the code graph), not evidence of zero
  dependents. Compensated with the grep sweep below, per the CLAUDE.md standing rule.
- **`graphify affected "resolveAnchorActivityIds"`** (the one indexed symbol on this seam) returned
  **18 dependent nodes** across 10 distinct files: `buildSchedule.js` (3 call sites: `L177`, `L236`,
  `L787`), `weekCatalog.js` (`L65`), `useGeneration.js` (2: `generate` `L69`, `placeAnchors` `L170`),
  plus 6 test files that import the module and 3 files that import `useGeneration.js`/
  `useScheduleData.js`/`useSnapshots.js` transitively.
- **`grep -rl "anchor_activities"`** across `*.js`/`*.jsx`: **111 files.** These split roughly into:
  schema/migration (`localDb.js`, `schema.sql`, ~15 `*.migration.test.js` files, 6
  `rollback/v*_down.js` files), the engine (`anchorActivityLink.js`, `buildSchedule.js`,
  `weekCatalog.js` and their tests), ingest (`ingest.js` and 12 `ingest.*.test.js` files,
  `fixedEvents.js`, `blastRadius.js`, `extractEntities.test.js`, `firstImportSignal.js`,
  `multiBlockCandidates.js`, `reconciliationReport.js`, `rootMapModel.js`), the projection layer
  (`projections.js`, `projectionsCoverage.test.js`, `campDocument.js`, `projector.js`,
  `generalize.test.js`, `seed.js`), the mock client (`localClient.mock.js` and 5 of its
  `*.test.js` companions — the mock hand-maintains a **duplicate copy** of the projections
  allowlist at `localClient.mock.js:435`, explicitly commented as "mirroring
  `PROJECTIONS.anchor_activities.fields`," which must be updated in lockstep or the mock silently
  diverges from the real projection, a second instance of the two-copies-drift failure mode this
  project has hit before), 6 screens (`AnchorsScreen.jsx`, `ImportScreen.jsx`,
  `ReconciliationScreen.jsx`, `RootsHomeScreen.jsx`, `ScheduleScreen.test.jsx`,
  `ScheduleScreenExclusions.test.jsx`) and their tests, `scripts/mcp/tools.js`/`tools.test.js` (the
  MCP surface), and `readiness.js`/`useCurrentStructureCounts.js`/`domainRollup.js`/`recordLabels.js`
  (census/rollup surfaces that display anchor counts).
- **`grep -rl "anchorActivityLink|resolveAnchorActivityIds|anchorNameKey"`**: **11 files** — the
  narrower set that touches the name-resolution function itself and is deleted/rewritten by step 3
  above (matches the graph's 18-node answer once test files and the module's own file are
  reconciled against the file-level grep).
- **Sweep B (write-failure dependents), per the "relaxing a constraint needs two sweeps" lesson**:
  nothing here relaxes a constraint that code depends on failing — this ADR *adds* a column and a
  finding, it does not remove a CHECK or a UNIQUE index. The one place this matters is the reverse
  direction: `resolveAnchorActivityIds` returning `[]` today is treated as "correct no-op" by three
  call sites (`buildSchedule.js`, `weekCatalog.js`). After this ADR, `[]` should never happen for a
  correctly-migrated row — a `[]` result is not deleted; it is left as a genuine finding, so any
  code relying on `[]` as "matched nothing, silently continue" is deliberately not touched by this
  ADR and inherits the finding rather than a behavior change. This is why the migration writes gaps
  to `fixed_event_identity_gaps` instead of forcing every row to resolve at migration time — some
  will not, and that must be visible, not papered over with a guessed match.

## Requirement: a resolved reference must carry its scope

The by-name link is the first symptom of a wider property — **anchor resolution does not carry
enough context to be correct**. Three consumers were checked directly rather than assumed:

- `src/engine/buildSchedule.js:158` and `:226` DO filter anchors by `schedule_week_id`
  (`a.schedule_week_id == null || a.schedule_week_id === weekId`). Week scope is honoured here.
- `src/engine/weekCatalog.js:62-65` resolves anchors **by name** and applies group/day scope via
  `src/engine/anchorScope.js`, but there is **no week resolver in `anchorScope.js` at all** — it
  exports `resolveAnchorGroupIds` and `resolveAnchorDayIds` and nothing for weeks. Week scope is
  therefore open-coded at two call sites in `buildSchedule.js` and absent from the shared resolver,
  which is the precise shape that produced the group-scope drift `anchorScope.js`'s own header
  describes.
- The export paths resolve anchors **by id**, not by name: `src/utils/scheduleCells.js:23,39-40`
  (`anchorLookup.get(slot.anchor_id)`) and, on T197's branch,
  `electron/ops/electiveRunOuterSchedule.js:52-56` (`anchorById.get(row.anchor_id)`). Because the
  slot already names the anchor id, an override week cannot yield the *wrong* anchor there.

**Correction to the brief, recorded because it will be read as authority:** the reported defect
"the child-schedule export can show the wrong anchor in an override week" does not hold as
described — that export resolves by id. What it *does* suffer is this ADR's actual root cause,
visible verbatim at `electron/ops/electiveRunOuterSchedule.js:54-56`: *"anchor_activities carries
no activity_id of its own (schema.sql) — its own `name` is the only identity available"*, and the
builder therefore returns `activityId: null`. The export cannot link a pinned event to its
catalogue activity at all. That is stronger evidence for this ADR than the week claim was.

**Requirements this imposes on the design, not on a follow-up ticket:**

1. `resolveAnchorActivityIds` is replaced by a resolver that takes the **scope context**
   (`{ weekId, groups, days }`) and returns a resolved reference, so a caller cannot obtain an
   activity id without having supplied the scope it is valid in. Callers that hold no week (export
   paths reading a stored slot) pass the slot's own week explicitly rather than omitting it.
2. The week predicate open-coded at `buildSchedule.js:158,226` moves into `anchorScope.js` as
   `resolveAnchorWeekApplies(anchor, weekId)`, joining the group and day resolvers. One
   implementation, for the reason that file's header already gives.
3. `electron/ops/electiveRunOuterSchedule.js`'s `resolveTemplateSlot` returns the real
   `activityId` for an anchor once `activity_id` exists. Coordinate with T197 before landing; do
   not edit that branch from here.

## Decision: the v73 table-rebuild column list — inherited, with a tripwire

Verified at `electron/db/localDb.js:3091-3153`: the v73 block (guard `>= 72 && < 73`) rebuilds
`locations`, `activities`, `events`, `elective_sets`, `groups`, `cohorts` and others from a
**hardcoded column list**. On a fresh install the whole chain replays, so `schema.sql` creates
every column, v73 drops any column absent from its list, and a later migration re-adds it. T266's
`activities.catalog_role` is the live instance (created by `schema.sql`, dropped by v73, re-added
at v75). The end state is provably identical today and nothing reachable loses data, because a
database arriving at v73 by a real forward path is at <= 72 and cannot yet hold the column.

**It is only safe while the adding migration is numbered above 73.** A future column added to one
of those tables at or below 73, or any reordering of the chain, is lost silently on fresh installs
while migrated installs keep it — fresh and migrated diverge behind a green gate, the same family
as the inline-`UNIQUE` autoindex trap.

**Decision: inherit it, and add a tripwire rather than retire it.** Retiring the hardcoded lists
means rewriting six table rebuilds in a migration that has already shipped, which widens T267's
blast radius well past the identity model it exists to fix, for a hazard that is currently latent.
Instead T267 adds one test asserting that, for every table the v73 block rebuilds, the column set
after a full fresh replay equals the column set in `schema.sql` — so the next person who adds a
column at or below 73 gets a red gate naming the trap instead of a silent divergence. This is a
stated decision, not an omission: the hardcoded lists survive T267 deliberately.

Note that `anchor_activities` is **not** among the tables v73 rebuilds, so T267's own
`activity_id` column is not exposed to this trap. The tripwire is for the next ticket, not this one.

## Sequencing: three PRs, each green and shippable on its own

**PR 1 — Schema + document-key rename + projection registration (v77).**
Add `fixed_events` as the renamed table (rename, not drop/recreate, to preserve existing rows —
SQLite `ALTER TABLE anchor_activities RENAME TO fixed_events`), add `activity_id TEXT`, add
`fixed_event_identity_gaps`, update `PROJECTIONS`/`MODELED_ENTITIES`/`localClient.mock.js`'s mirror
allowlist together, run the backfill, populate `catalog_role` for backfilled rows (absorbing T266).
**Gate proves:** migration round-trips (fresh install byte-identical to migrated,
`rebuildFromDocument.test.js`-style document round-trip passes), every existing `.test.js` that
constructs an `anchor_activities` fixture is updated to the new name and still passes, no reference
to the old table name remains except in rollback scripts and historical ADRs. The engine, ingest,
and UI code paths are **untouched** in this PR — they still call the old name-resolution functions,
which still work against the renamed table (name is still a real column). Nothing about scheduling
behavior changes yet.

**PR 2 — Cut over resolution to `activity_id`; delete the name-matching fallback.**
`resolveAnchorActivityIds` becomes an id lookup; `anchorNameKey`/`indexActivitiesByName` and their
imports are removed; `commitPlan` and `AnchorsScreen.jsx` write `activity_id` and `catalog_role` on
create; free-choice pickers and the elective offering pool filter on `catalog_role IS NULL`.
**Gate proves:** the acceptance predicate below, end-to-end, through the real ingest path (not a
hand-built fixture — this is the exact lesson of T62 and of yesterday's ADR). The category-
exclusivity leak this ADR's predecessor described is closed as a side effect: a pinned name can no
longer appear in the free-choice catalogue, because `catalog_role` excludes it, and it can no
longer resolve to `[]` at generation time undetected, because the invariant in step 5 makes that a
refused generation instead.

**PR 3 — Cosmetic and read-path cleanup.**
Rename remaining `anchor_activities`-named identifiers in non-critical-path code (variable names,
comments, MCP tool descriptions in `scripts/mcp/tools.js`, census/rollup labels in
`domainRollup.js`/`recordLabels.js`) to `fixed_events`/"fixed events"/"recurring events"
vocabulary. **Gate proves:** no behavior change — this PR is pure rename/label, verified by the
existing test suite passing unchanged plus a grep confirming zero remaining `anchor_activities`
references outside `rollback/`, migration history, and historical ADR text.

Each PR leaves `npm run verify` green. PR 1 is safe to ship alone (no scheduling behavior changes).
PR 2 is the one that changes what a director sees and must not ship without PR 1 already merged
and soaked. PR 3 can be deferred indefinitely without cost if time runs out — the previous two are
where the risk and the value both live.

## Schema version plan

**v77.** Checked against `main` (v74) and against every local worktree, not just this one:
**T266 (`t266-build`) and T197 (`shoresh-rendezvous-wan-handoff-5f211b`) each currently declare
`CURRENT_SCHEMA_VERSION = 75`** — a live collision between those two tickets, reported upward and
resolved outside this ADR by T266 keeping v75 and T197 renumbering to v76. T267 therefore takes
**v77**, contingent on that resolution holding. Do not hardcode it from this document: **before
opening PR 1, re-read `CURRENT_SCHEMA_VERSION` on current `main` and on every local worktree, and
take the next free number.** A version hole fails `migrationDomainState.test.js`.

- **Migration guards**: `getSchemaVersion(db) >= N-1 && getSchemaVersion(db) < N` at every
  version-gated block this ADR adds — the house form every block from v60 onward uses, stated as
  the rule at `electron/db/localDb.js:3089`. Never a bare `< N` with no lower bound (bug #194,
  quoted at `electron/db/localDb.js:1975-1979`: an unstamped earlier migration pushes `MAX()` past
  a version so a later cleanup never retries — the lower bound is the fix). Never widen the upper
  bound past `N` either: several blocks here do full table rebuilds, which re-firing would
  destroy.
- **Rollback**: `electron/db/rollback/v{N}_down.js` reversing the rename (`fixed_events` →
  `anchor_activities`) and dropping `activity_id`/`fixed_event_identity_gaps`, following the exact
  pattern of `v51_down.js`/`v71_down.js` (both of which already reverse a table-rebuild on this
  same table).
- **Tripwires**: a `.toBe(N)` assertion on `CURRENT_SCHEMA_VERSION` in
  `localDb.migrations.test.js`'s sibling suite, per the standing lesson that a version hole fails
  `migrationDomainState.test.js` silently otherwise.
- **Column-order trap**: `activity_id` and any new column on the renamed table must be appended
  LAST in `schema.sql`'s `CREATE TABLE fixed_events`, matching the ALTER-based migration path,
  exactly as `recurrenceTruthStatus.migration.test.js`-style byte-identical fresh-vs-migrated tests
  already enforce for this table's existing columns (`kind`, `unit_ids`).

## Test plan (specified here; not implemented by this ADR)

**Non-vacuity is mandatory**, per the standing bar: for every new guard, plant the defect, show
red, revert, show green — and at least one planted defect must be one the guard's own description
would not lead a reader to expect (e.g. the id-resolution guard should also be tested against a
row whose `activity_id` points at an activity that was since **soft-deleted**, not only a row with
`activity_id IS NULL`, since "deleted but still referenced" is the failure mode a reader focused on
"is null" would not think to plant).

**Fixtures come from the schema**, not from the code under test — built by inserting real rows
through the real `PROJECTIONS`-gated write path (`applyWrite`/`commitPlan`), never a hand-built
JS object carrying fields `resolveAnchorActivityIds`'s caller wishes existed. This is the exact
discipline that would have caught T62 a month earlier.

**The specific predicate to prove**, end-to-end through the real ingest path (a hand-built fixture
cannot demonstrate this, per the predecessor ADR's own finding — the leak only appears where two
independent proposers meet on a real parsed grid):

1. Ingest a spreadsheet with at least one pinned recurring name and one free-floating activity
   name. Commit through the real `commitPlan`.
2. Assert: the pinned name does **not** appear in the free-choice activity catalogue
   (`catalog_role IS NOT NULL`).
3. Assert: every `fixed_events` row for this camp has a non-null `activity_id` resolving to
   **exactly one** live `activities` row — plant a fixture where it resolves to zero (deleted
   activity) and one where a stale duplicate makes it resolve to two, and confirm both are reported
   as findings and both refuse schedule generation, not silently degrade.
4. Generate a schedule. Assert the pinned name appears on the generated grid **exactly once per
   group per day** — plant the pre-fix behavior (delete the `activity_id` link, fall back to name
   matching against a duplicated catalogue row) and confirm the test goes red before the fix and
   green after, using `process.stdout.write` for any diagnostic output (vitest drops `console.log`
   when stdout is not a TTY, which would make a red-before/green-after check silently unobservable
   in CI).
5. Assert the free-choice activity from step 1 is still freely placeable and unaffected.
6. A cross-device conflict test: two `campDocument.js` documents each set a different
   `fixed_events.activity_id` for the same row id, merge, and confirm the conflict surfaces via
   `A.getConflicts`/the existing `conflicts` table — not a silent last-write-wins.
7. `localClient.mock.js`'s hand-maintained allowlist mirror (`localClient.mock.js:435`) gets its
   own drift tripwire: a test that diffs it against `PROJECTIONS.fixed_events.fields` and fails
   loudly if they diverge, closing the exact "two copies, one drifted" failure class this project
   has hit before (recorded project memory: dedup-the-half-that-drifted).

The full gate (`npm run verify`) is Stage 2, not restated here — the above is what feeds it: these
assertions become new tests inside `electron/ops/ingest.t267.test.js` (or extending
`ingest.t72.test.js`'s sibling pattern) and `electron/automerge/*.test.js` for the sync-conflict
case.

## Reused vs. new

**Reused:** `activities` table and its existing write path; `PROJECTIONS` allowlist mechanism
(no new gating mechanism — one more entity, one more field, same rules); the existing `conflicts`
table/resolution UI (no new conflict UI); the existing flag/finding vocabulary (no new banner
mechanism, per the standing "no banners" rule); T266's `catalog_role` column, absorbed rather than
duplicated; the rollback pattern already established at `v51_down.js`/`v71_down.js` for this same
table; the existing `rebuildFromDocument.test.js` round-trip pattern as the verification method for
the document-key rename.

**New:** `fixed_events.activity_id`; `fixed_event_identity_gaps` (a small, SQLite-only, non-synced
table — deliberately not modeled in the document, since it is a local migration-time worklist, not
camp data two devices need to agree on); the invariant check at generation time (zero/multiple
resolution is a refused-generation finding); the drift tripwire between `PROJECTIONS` and
`localClient.mock.js`'s mirrored allowlist, which did not exist before and should have.

## ADR required: yes

This is filed as the ADR itself, at
`docs/adr/2026-09-26-fixed-recurring-event-identity-model.md`. It introduces a new persistent
relationship (`fixed_events.activity_id`) that other code will depend on, renames a synced entity's
document key (a decision with real cross-device consequences if done wrong, and not obviously
reversible once two real devices exist), and settles a standing architectural ambiguity
(`anchor_activities` vs `events`, one family or two) that a prior ADR explicitly left open. All
three individually clear the constitution's ADR bar.

## Open questions for Governor / the owner

1. **UI vocabulary for the two "event" concepts** (flagged above, not decided here): what a
   director sees labeled "Recurring/Fixed Events" versus the existing Field-Day-style `events`
   screen, so the two are never confused in the product even though they were always structurally
   distinct in the schema. Product/naming call, not architecture.
2. **`catalog_role`'s exact value set** (`'fixed_event'`/`'recurring_event'` vs a single `'pinned'`
   value plus deferring to `fixed_events.kind`) is left to Maker within this ADR's constraint that
   there be exactly one authority for "is this row pinned" — confirm with Governor before PR 1 if
   there's a reason to prefer one shape (e.g. an existing UI filter that already branches on a role
   string) over the other.
3. **Confirm the schema version number at PR-1 time** against whatever has actually merged to
   `main` by then (T266 and/or T197) — this ADR deliberately does not hardcode v76 as final.

## Out of scope, explicitly

- T264 (ADR-gated separately; no mechanism proposed or implied here).
- The elective preference model (per-cell vs global) — untouched.
- Any change to the `events` table, its sub-schedule tables, or the Events screen's behavior.
- UI/IA redesign of the Anchors screen — only its write path (link to an activity, not just a name)
  changes; screen shape is a Designer question if the owner wants one, not implied by this ADR.
