---
title: "ADR: An unresolved-location decision is remembered per camp via a compound_cell_decisions-shaped table, and every held-conflict reason gets a triage card"
document_type: adr
status: proposed
authority: normative
implementation_state: implemented
date: 2026-09-05
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs: []
related_tickets: []
related_adrs: [docs/adr/2026-09-03-compound-cell-interpretation.md, docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
supersedes: []
affects: []
---

# An unresolved-location decision is remembered per camp, and every held-conflict reason gets a triage card

## Context

An import can stop dead and show the director nothing. When ingest hits certain conditions it
raises a **held conflict**, which by design rolls the entire import back atomically
(`electron/ops/ingest.js:1040-1044` — "the whole import must still write nothing… leaves the DB
byte-identical"). That part is correct and out of scope here.

`heldConflictsToDecisions` (`src/screens/reconciliationTriage.js:35`) only builds a decision card
for 2 of the 6 held-conflict reasons: `ambiguous_identity` and `stale`. The other four —
`location_unresolved`, `validation`, `eligibility_unresolved`, `unit_unresolved` — fall through the
`for`/`if` chain and produce nothing. The director presses Import, the whole thing silently does
not happen, and there is no card, no explanation, no path forward. This is a pre-existing bug on
the update path (`resolveFieldWrite` already raises `location_unresolved` there today).

It also blocks a correct, already-written fix on unmerged branch `claude/location-provenance-honesty`
(commit `6c127a8`) that makes the **create** path raise `location_unresolved` too, so a brand-new
activity naming an unrecognized location is held rather than silently created with no location and
no record of why. Merging that fix without first fixing rendering would turn a silent data gap into
a silent dead end.

### The domain shape

A schedule grid usually cannot name a room — activities are placed by name only, and the room is
often baked into the activity name itself ("Back Playground"). In the **unlabeled daysheet**
format, the room is genuinely printed as a second line inside the cell:

```
   Archery        Pottery        Sailing        Archery
   Barn           Loft           Lake           Barn
```

`Barn`, `Loft`, `Lake`, `301` are real printed text the parser read correctly, not inferences from
nothing — but the parser's known failure mode is misreading a second stacked *activity* as a room.
The director is the only one who can tell the difference, which is why the resolution card must
show the source lines as evidence.

### The approved card (product owner signed off on a mock)

A third card shape, alongside the existing "is this the same thing?" (`ambiguous_identity`) and
"this value changed" (`stale`) shapes: **"I can't finish until you tell me about this."** For
`location_unresolved` it asks *"Is Barn a place at your camp?"*, shows the source grid lines as
evidence, and offers three choices, all of which let the import finish:

1. **Yes, add it** — create the place.
2. **Use instead →** pick an existing place (catches near-duplicates before they exist).
3. **Not a place — ignore it** — the activity imports with no room (today's silent outcome, now
   chosen rather than accidental).

**Product owner decision: choice 3 must be remembered, so the same word never asks twice.**

Two smaller decisions already made by the product owner (recorded here, not re-litigated): a
numeric room like `301` is treated identically to a named one, no special-casing; and a place
created via choice 1 lands on the Locations screen with capacity 1 marked **Inferred** — this
already happens as of #287, so it needs no new work.

### Precedent this must follow, and the one it must not

`compound_cell_decisions` (`electron/db/schema.sql:131-141`, ADR
`docs/adr/2026-09-03-compound-cell-interpretation.md`) solves the identical shape of problem: a
director's confirmed interpretation of an ambiguous import token, remembered per camp so a future
import never asks again. It is host-only, never synced, keyed `UNIQUE(camp_id, pattern)`, written
only from one dedicated module, admin-gated at the IPC boundary.

`open_reconciliation_decisions` (`schema.sql:194`) is explicitly **not** the right home: its own
comment states held conflicts are out of scope because "they never reach the commit write." A
remembered "not a place" decision has to be readable *before* the commit decides whether to hold —
it prevents the hold from being raised at all on a later import. That is a fundamentally different
read pattern (pre-flight lookup during extraction, not payload alongside a resolved decision), so
riding `open_reconciliation_decisions`'s path would require bending its contract, not reusing it.

## Decision

### 1. Storage: a new table, shaped exactly like `compound_cell_decisions`

Add `location_word_decisions`, a sibling to `compound_cell_decisions` and `declined_two_row_splits`
— same posture (host-only, never synced, one writer module, admin-gated), same reason a new table
beats extending an existing one: `compound_cell_decisions`'s `interpretation` enum
(`as_written`/`wrapper`/`alternatives`) is a different vocabulary answering a different question
("what does this compound cell mean?") from this one ("is this word a place?"). Bending one enum to
answer both questions would make every reader of either table carry a switch over cases that don't
apply to it — the CLAUDE.md-documented byte-identical-migration discipline this schema already
follows makes a shared, overloaded table strictly worse than two narrow ones.

```sql
-- Host-local memory of a director's "not a place" answer for an unresolved
-- location word, so a re-import never raises location_unresolved for the
-- same word again. Same posture as compound_cell_decisions and
-- declined_two_row_splits: NEVER included in any full-sync SELECT/payload,
-- NEVER sent over the wire, NEVER added to DIRECT_CAMP_ENTITIES or
-- PROJECTIONS. Written only from electron/ops/locationWordDecisions.js,
-- admin-gated at the IPC boundary like confirmAlias.
CREATE TABLE IF NOT EXISTS location_word_decisions (
  id TEXT PRIMARY KEY,
  camp_id TEXT NOT NULL REFERENCES camps(id),
  word_key TEXT NOT NULL,        -- normalized lookup key (see §2) derived from
                                  -- the literal word ingest read as a location
  raw_word TEXT NOT NULL,        -- the word as printed, for display/audit —
                                  -- never used as the lookup key itself
  decision TEXT NOT NULL,        -- 'not_a_place' (only value written today —
                                  -- see §3 on why choices 1/2 don't write here)
  confirmed_by TEXT,             -- plain TEXT user id, provenance only
  confirmed_at TEXT NOT NULL,
  UNIQUE(camp_id, word_key)
);
```

`decision` is a TEXT enum with one value today rather than a boolean, for the same forward-
compatibility reason `compound_cell_decisions.interpretation` is an enum and not a flag: a reader
written against today's schema must be able to tell "I don't recognize this value" from "this
means yes," and refuse to silently treat an unrecognized future value as safe-to-suppress.

**Schema version bump.** This is v56 (current `CURRENT_SCHEMA_VERSION` is 55, confirmed via
`electron/db/anchorEventLocation.migration.test.js:101` and 10 sibling migration test files, all
of which assert `CURRENT_SCHEMA_VERSION` by number). The Maker brief must include: bump
`CURRENT_SCHEMA_VERSION` to 56 in `electron/db/localDb.js`, add the v56 migration block (`CREATE
TABLE IF NOT EXISTS location_word_decisions ...` — identical to the fresh-install DDL above, since
this is a brand-new table with no legacy column-order hazard to preserve), and update the
`.toBe(55)` → `.toBe(56)` tripwire in every sibling migration test that asserts it (at least the 11
files matched by `grep -rl "CURRENT_SCHEMA_VERSION).toBe(55)" electron/db/`).

### 2. Lookup key: case/whitespace-normalized word, per camp, no source scoping

`word_key` is the printed word lowercased and whitespace-collapsed/trimmed (the same normalization
class `electCanonicalSpellings` already applies to activity names in
`src/ingest/extractEntities.js:161` — reused convention, not a new one). This closes the most
likely real-world miss (`Barn` vs `barn` vs `Barn ` from OCR/PDF noise) without inventing fuzzy
matching, which the compound-cell ADR already explicitly investigated and rejected for this exact
class of problem (word-list/generic-rule approaches don't generalize across camps' idiosyncratic
vocabulary — the director is the source of truth per camp, not a heuristic).

**Scope is camp-only, not per-source or per-cohort.** A word a director has said "is not a place"
at their camp is a fact about their camp's vocabulary, not about one schedule file's formatting.
Scoping tighter (per source layout, per season) would mean the same director answering the same
question again for a file laid out slightly differently — exactly the annoyance this feature exists
to remove. If a real camp situation later contradicts this (the same word is a place in one
season's grid and logistics-only in another) that is a product question to raise if and when it
occurs, not a hazard to design around now (see Open Questions).

**If the director changes their mind:** no UI is being added for this now (see Non-Goals). The row
is a plain, admin-writable table row like its precedent — an admin can be told to delete it via a
direct request if this ever comes up, the same manual-intervention posture the codebase already
accepts for `declined_two_row_splits` and `compound_cell_decisions` (neither ships an "undo my past
answer" screen either). Building reversal UI ahead of a demonstrated need would be exactly the kind
of premature generality `karpathy-guidelines` warns against — three of this shape of precedent
table already ship with no unwind UI, so this is following, not inventing, an established simplicity
line.

### 3. How choices 1/2/3 flow back into a re-commit

Trace: `heldConflictsToDecisions` builds cards from a HELD response's `conflicts` array →
`foldTriageInputs` folds the director's answers into the same payload shape `commitIngest` already
accepts (no parallel resolution schema, per the existing ADR precedent this module already follows)
→ the import is re-run with those answers included, and — because no data was ever written on the
held pass — this re-run is a normal, full ingest commit, not a partial-apply/retry of a half-written
state.

- **Choice 1 (create the place) and Choice 2 (use existing place)** are *not* new mechanism: they
  are exactly what `ambiguous_identity`-style resolution already does — the director's answer
  becomes a resolved value fed back into the SAME re-commit cycle via `foldTriageInputs`, using the
  existing `resolve_conflict`/decision shape. No new commit-side branch is needed beyond what the
  location card contributes (the field's resolved `to` value: either a new location name to create,
  or an existing location's id/name to bind to). This is genuinely the same mechanism as the two
  reasons already wired up — the gap today is only that no card exists to *produce* that answer for
  `location_unresolved`, not that the re-commit plumbing is missing.
- **Choice 3 (not a place — ignore)** is different in kind: it doesn't resolve a value for *this*
  import so much as it pre-empts the check on *every future* import. It writes one row to
  `location_word_decisions` (via the new host-only module, admin-gated, same shape as
  `confirmAlias`) **and** resolves the current field the same way the update path already treats an
  unresolved location field it isn't holding on (i.e., the activity commits with `location: null`
  for this run). The write to `location_word_decisions` and the resolution of the current held
  field are two separate, sequenced writes inside the same re-commit — not a new sync-safety
  primitive, since this table is host-local and single-writer-gated exactly like its precedent.
- **The consuming read side** is the actual behavior change: before `resolveFieldWrite` (and its
  create-path counterpart, once `claude/location-provenance-honesty` merges) raises
  `location_unresolved` for a word, it must first check `location_word_decisions` for a matching
  `word_key` at that camp. A hit means: do not raise the conflict, resolve the field to `null`
  directly, exactly as if the director had just answered "not a place" again. This is the entire
  point of the feature — the check has to happen *before* the hold, at the same point
  `listAliasMap` is already consulted for alias resolution in `electron/ops/ingest.js:247`, which
  is the established pattern for "consult a host-local remembered-decision table during plan
  building."

### 4. Render all four unresolved reasons now, with two tiers of specificity

Fix `heldConflictsToDecisions` to build a card for `location_unresolved`, `validation`,
`eligibility_unresolved`, and `unit_unresolved`, not just the one this ticket is chartered around.

**Recommendation: yes, all four, but not to the same depth.** Ship the full three-choice
"Is Barn a place?" card (with remembered-decision write) for `location_unresolved` only — that is
the one with an approved design and a real resolution path. For the other three
(`validation`, `eligibility_unresolved`, `unit_unresolved`), add a **generic fallback card**: same
"needs an answer" visual family (reusing the mock's card shell — `.pill`, `.card-stripe`, `.why`,
evidence block), showing the reason, the affected entity/field, and the from/to values already
present on every `makeFieldConflict` conflict object, with the single available action being
"skip this field" (resolves the field to its prior value / leaves it unset, same no-op-but-chosen
posture as location's choice 3, minus the remembered-decision write since these three reasons don't
have an established "remember for next time" semantics yet).

Reasoning, converging the divergent options considered: a raw, unmapped reason code
(`validation`) shown verbatim is not acceptable — every reason must route through director-facing
copy, never a bare enum string. But building three more bespoke, fully-designed resolution flows
is not warranted by this ticket's evidence — nobody has reported hitting `validation`,
`eligibility_unresolved`, or `unit_unresolved` as a live pain point the way `location_unresolved`
was. The generic fallback closes the actual harm (silent dead end, zero explanation) at low cost,
without speculative design work for reasons with no demonstrated frequency. It is explicitly a
placeholder to be widened into its own dedicated card if and when one of those three reasons turns
out to be common enough to deserve its own answer set — tracked as an open question below, not
built now.

`heldConflictsToDecisions` must also fail loudly, not silently, if a *seventh*, wholly unknown
reason ever appears in a `conflicts` array — mirroring the existing `commitPlan` assertion at
`electron/ops/ingest.js:1657-1658` ("`commitPlan: conflict reason "${item.reason}" is not
implemented at S1a`"), so the render-side and commit-side vocabularies can never silently drift
apart the way this ticket's four missing cases already did once.

## Interface-contract checklist (org-interface-contracts)

- **Idempotency.** The `location_word_decisions` write is a fresh `INSERT` per new `word_key`
  (blocked by `UNIQUE(camp_id, word_key)` on a genuine duplicate); a retried "ignore" click for the
  same word is a no-op collision on the unique constraint, which the writer module must catch and
  treat as success (matching `confirmAlias`'s existing idempotent-retry handling), not surface as
  an error.
- **Concurrent retries.** This table is host-only and never synced, so there is no cross-device
  concurrent-write hazard to solve — the same posture as `compound_cell_decisions`. The only
  concurrency to consider is two admin sessions on the Host resolving the same import simultaneously,
  which is already out of scope for the whole reconciliation screen today (single-admin-at-a-time is
  an existing assumption, not one this ADR changes).
- **Unknown outcomes.** N/A at the IPC layer — this is a local synchronous SQLite write on the Host,
  not a WebSocket call that can time out ambiguously.
- **Error shape.** The new writer module should return the same shape `confirmAlias`/the
  compound-cell decision writer already return (thrown error on genuine failure, caught and mapped
  through `describeWriteFailure` the same way `mapCommitError` already does at the triage-screen
  boundary) — no new error vocabulary.
- **Scope/authority boundary.** Writing a `location_word_decisions` row is IPC-admin-gated,
  identical to `confirmAlias` and the compound-cell decision writer. Reading it during ingest
  (the pre-flight check in §3) is a plain host-local SQLite read inside the existing import
  pipeline, not a new IPC surface.
- **Trust boundary.** `raw_word`/`word_key` originate from parsed import text — a trust boundary —
  so the normalization in §2 must be applied consistently on write and on read (the writer module
  should own the normalization function so read and write can never compute `word_key` two
  different ways).

## Files/modules affected

- `electron/db/schema.sql` — new `location_word_decisions` table (fresh-install DDL).
- `electron/db/localDb.js` — `CURRENT_SCHEMA_VERSION` 55 → 56, new v56 migration block.
- ~11 migration test files under `electron/db/*.migration.test.js` — `.toBe(55)` → `.toBe(56)`.
- `electron/ops/locationWordDecisions.js` (new) — single writer module: normalize word, write
  decision row, idempotent-collision handling. Owns the normalization function used by both write
  and read.
- `electron/ops/ingest.js` — `resolveFieldWrite` (update path) and its create-path counterpart
  (from `claude/location-provenance-honesty`) consult `location_word_decisions` before raising
  `location_unresolved`, via a lookup analogous to the existing `listAliasMap` consultation
  (`electron/ops/ingest.js:247`).
- `electron/preload.js` / `electron/main.js` — new admin-gated IPC method for writing a
  location-word decision (mirrors `confirmAlias`'s IPC shape).
- `src/screens/reconciliationTriage.js` — `heldConflictsToDecisions` extended to cover all four
  currently-unrendered reasons: full card for `location_unresolved`, generic fallback card for
  `validation`/`eligibility_unresolved`/`unit_unresolved`; add the loud-failure branch for any
  future unrecognized reason.
- New location-specific card component (design already approved via the mock at
  `/private/tmp/claude-501/.../scratchpad/unresolved-card-mock.html` — Maker/Designer should treat
  that mock as the visual and copy source, not re-derive it) plus a lighter generic fallback card
  component, both under `src/screens/reconciliation*` following the existing card-component layout.

## Reused vs. new

**Reused:** the `compound_cell_decisions`/`declined_two_row_splits` host-only-table shape and its
IPC-admin-gating convention; `electCanonicalSpellings`'s normalization approach; the existing
`resolve_conflict`/`foldTriageInputs` re-commit plumbing already wired for `ambiguous_identity`/
`stale`; the `listAliasMap`-during-plan-building read pattern; the `mapCommitError`/
`describeWriteFailure` error-shape convention; the approved mock's card visual language.

**New:** the `location_word_decisions` table itself (a new fact this schema has never recorded:
"this word is confirmed not to be a place"); the pre-flight consult-before-hold check in
`resolveFieldWrite`; the generic fallback card component (nothing in the codebase currently renders
an unmapped held-conflict reason at all, by design — it silently drops them, which is the bug).

## ADR required: yes

This decision is filed at `docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md`
(this document). It meets the constitution's bar: it introduces a new persistent data shape (a new
host-only table other code — the ingest pipeline's held-conflict check — will depend on) and it
changes an existing contract (`heldConflictsToDecisions`'s reason coverage, which other tests and
the re-commit fold path already depend on today).

## Non-Goals

- No UI for a director to review, list, or reverse a past "not a place" decision. An admin can be
  asked to delete the row directly; a management screen is not being built speculatively.
- No cross-source or cross-season scoping of the remembered decision (see §2).
- No bespoke, fully-designed resolution UI for `validation`, `eligibility_unresolved`, or
  `unit_unresolved` beyond the generic fallback card — those get a real card only if usage shows
  they need one.
- No change to the atomic-rollback behavior of held conflicts themselves — that mechanism is
  correct and untouched.
- No signature/tamper-protection on `location_word_decisions` rows beyond what every other
  host-only table in this schema already relies on (the existing device/file trust boundary).

## Open questions for Governor

1. **Merge sequencing with `claude/location-provenance-honesty`.** Should this ADR's schema/read
   work land before, after, or bundled with that branch's create-path fix? Landing the triage-card
   fix first (this ADR's §4, independent of §1-3) removes the "silent dead end" risk immediately,
   even before the create-path fix or the remembered-decision table exist — worth sequencing as two
   Maker tickets rather than one, if the product owner wants the safety fix shipped fastest.
2. **Does the generic fallback for `validation`/`eligibility_unresolved`/`unit_unresolved` need a
   product decision on copy/action wording**, or is "skip this field, here's what changed" adequate
   without further product input? This ADR assumes the latter given no reported real-world
   frequency for these three reasons; flag if the product owner has seen these hit in practice.
3. **Per-camp scope was assumed correct** (§2) based on the director-is-the-source-of-truth
   framing already established by the compound-cell ADR. If there's a known real scenario where the
   same printed word is a place in one context and not in another at the *same* camp, that changes
   the key design and should be raised before Maker starts.
