---
title: "Backfill: clear import-manufactured activities.priority left over from before B2"
document_type: adr
status: rejected
authority: normative
implementation_state: not-started
date: 2026-08-10
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# Backfill: clear import-manufactured `activities.priority` left over from before B2

## Status
**REJECTED — no automatic backfill will be built (product owner, 2026-08-10).**

Round-2 review proved the predicate is fundamentally unreliable: `source === 'import'`
records provenance *class* (import vs human), never *cause* (inference vs. a
director-typed value). It cannot distinguish a pre-B2 **manufactured** priority
(the intended target) from **(b)** a priority a director typed into an exported S4
workbook and re-imported, or **(c)** a priority a director explicitly *Accepted* on
a stale conflict — all three are stored identically. S4 is already shipped to `main`,
so legitimate director-typed import-sourced priorities exist in real DBs today.
An automatic clear against an absolute "never touch a director's decision"
constraint has one honest resolution: **do not auto-clear.**

**Decision:** Option 0 — do NOT backfill. The legacy manufactured priorities are
left in place; the fix is forward-only (B2). Surfacing these `source='import'`
non-null priorities for a director to review/confirm is **deferred to Phase C/D**,
where the NEEDS-ATTENTION uncertainty-surfacing experience is being designed
coherently — not as a one-off screen here. This ADR is retained as the record of
*why* a naive backfill is unsafe (Phase C/D must respect the (a)/(b)/(c) ambiguity).

The mechanism analysis below (the Host-only marker, sync/replay convergence, the
`client_write_id` device-scoping fix) is preserved for reference should a
review-driven clear ever be built under Phase C/D — but nothing here ships as an
automatic backfill.

---

_Original (rejected) design follows, for the record:_

**Superseded in part — see "Round 2: predicate is not reliable" below.** Decision 1
(mechanism), Decision 4 (sync/replay), and Decision 5 (camp scoping) stand.
Decision 2 (predicate) and Decision 3 (op-write shape) are revised. Do not
implement Decision 2/3 as originally written below without reading the Round 2
section first — it changes what gets cleared.

## Context

B2 (commit 57f75ed) stopped the importer manufacturing `activities.priority`
('high'/'low') going forward — the write guard in `electron/ops/ingest.js`
(~line 625) now only writes `priority` when the incoming plan's `rule.priority`
is explicitly 'high' or 'low', and a plan built after B2 rarely carries that
field at all. But activities imported *before* B2 still hold a manufactured
priority in the projection, written by the importer with no human review. A
re-import of that same camp today does not fix it: the plan no longer proposes
a `priority` value for that activity, and S2b's field-update semantics do not
overwrite a field the incoming plan is silent on ("blank preserves live" —
`docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md`). The stale
manufactured value sits there indefinitely, silently shaping `buildSchedule.js`
scheduling for an activity no director ever asked to be high/low priority.

This ADR designs a one-time, idempotent backfill that resets `priority` to
UNKNOWN (`NULL`) wherever — and only wherever — the current value was written
by import provenance, never touching a human-set value. `buildSchedule.js` and
the engine are untouched; this is purely a data-provenance cleanup at the
op-log / projection boundary, using the same machinery S2a (field provenance)
and the trash-can restore path already built.

## Decision 1 — Mechanism: Host-only startup routine, gated by a dedicated marker table, not a schema-migration data write

### Candidates considered
- **A. Write the clearing ops inside `initSchema`'s migration block** (the
  obvious "just add v31" approach, following the v26 recovered-Version
  precedent of a migration that writes real data, not just DDL).
- **B. A dedicated one-time maintenance routine, gated by its own idempotency
  marker, invoked from `chooseMode`'s Host branch in `electron/main.js`
  (~line 378) — after Host/Client role is decided — rather than from
  `initSchema` (before role is decided).**
- **C. An on-demand IPC-triggered admin action** (director clicks a button).

### Why B, and why A is disqualified (not just suboptimal)

Traced the actual startup sequence: `openLocalDb` — which runs `initSchema`
and all versioned migrations — happens at `electron/main.js:1081`, and
`chooseMode` (which decides whether this device is Host or Client this
session) is only called later, from the renderer's pre-login init effect or
the `shoresh:choose-mode` IPC handler (`main.js:1128`). **Host/Client role is
not yet known at migration time.** This repo's own sync research (traced this
session) confirms the asymmetry that matters: a Host-authored `appendOp`
eventually reaches Clients via `sendMissedOps` on next `authenticate`
(`electron/sync/syncServer.js:265`, wired at `:409`) — durable, if not
instant. A **Client**-authored `appendOp` has **no path back to the Host**;
Client writes only become durable/canonical via `submit_op` over the sync
socket (`syncClient.js`, `serverUrl`-present branch), which runs
`detectConflict`/`appendOp` on the Host and assigns the canonical `seq`. A
migration that calls `appendOp` directly, unconditionally, inside `initSchema`
would therefore run on *every* device (Host and Client both run the same
migration code — confirmed, no Host/Client branch anywhere in `initSchema`)
and would silently and permanently diverge any Client's local `operations`
table from the Host's — exactly the failure mode `handleSubmitOp` and
`detectConflict` exist to prevent, bypassed entirely. **A is disqualified as
unsafe, not merely non-preferred.**

C is unnecessary process weight: this has one correct predicate and no
judgment call for a director to make; an admin click adds a permission-model
question ("who can run this, what do they see") this ADR would then also have
to answer, for no benefit over "it just happens once, silently, the first
time this build's Host comes up."

**Recommendation: B, confidence high.** Concretely:

- Schema change (v31, DDL only, mirrors the v30 precedent of "DDL only, no
  data movement, reapplying is harmless"): add a `host_backfills` table —
  `id TEXT PRIMARY KEY, applied_at TEXT NOT NULL` — created in `initSchema`
  the same way `source_aliases` was in v30. This table is intentionally NOT a
  projection, NOT in `PROJECTIONS`, NOT replicated: it is host-local
  bookkeeping, same category as `device_identity`.
- Data routine: a new function, e.g. `backfillImportPriority(db, { device_id })`
  in `electron/ops/ingest.js` (co-located with `IMPORT_SOURCE` and the
  provenance helpers it depends on) or a new small module
  `electron/ops/backfillImportPriority.js` — Architect leaves this call to
  Maker's judgment on file size, but it must live under `electron/ops/`, not
  `electron/db/`, since it is an op-log writer, not a schema migration.
- Invoked from `chooseMode`'s `requestedMode === 'host'` branch in
  `electron/main.js`, after `syncServer` starts and `deviceId` is known,
  guarded by:
  ```js
  if (!db.prepare('SELECT 1 FROM host_backfills WHERE id = ?').get('priority-unknown-backfill-v1')) {
    backfillImportPriority(db, { device_id: deviceId })
    db.prepare('INSERT INTO host_backfills (id, applied_at) VALUES (?, ?)')
      .run('priority-unknown-backfill-v1', new Date().toISOString())
  }
  ```
  A Client never runs this routine at all — not "runs it but it's a no-op",
  it is simply not called outside the `host` branch. If a device is Host in
  one session and Client in another (role is chosen per-session per the code
  read above), the marker row makes re-becoming Host later a correct no-op.

### Idempotency (belt-and-suspenders, three independent layers)
1. The `host_backfills` marker row — primary gate, checked before the routine
   runs at all.
2. The provenance predicate itself is naturally idempotent: after the first
   clear, the field's latest write has `source = 'import'` and `value = NULL`,
   so "current value is non-null" (part of the predicate, Decision 2) is false
   on any re-run — even if the marker row were somehow lost.
3. A deterministic `client_write_id` per activity (`backfill-priority-unknown:${activity_id}`)
   on each written op, for traceability/debugging (`findOpByClientWriteId`) —
   not load-bearing for idempotency here since `appendOp` itself does not
   dedupe by `client_write_id` (only `syncServer.handleSubmitOp` does, for
   remote `submit_op` messages, which this path never goes through), but
   costs nothing and matches the project's existing convention for
   migration-written rows (`DELETE_FIELD`'s own doc comment: "a delete gets a
   `client_write_id` for idempotent retry").

## Decision 2 — Exact provenance predicate

**Predicate: `lastKnownFieldSources(db, 'activities', id).get('priority') === 'import'`
— strict equality, not `!== 'human'`.**

For each activity in the Host's camp:
1. `sources = lastKnownFieldSources(db, 'activities', id)` (S2a helper,
   `electron/ops/restore.js:106`).
2. `fields = lastKnownFields(db, 'activities', id)` (same file, `:84`).
3. Skip unless `fields.get('priority')` is `'high'` or `'low'` (requirement:
   only clear a non-null value; already-NULL is untouched — no-op, no op
   written).
4. Skip unless `sources.get('priority') === 'import'` exactly.
5. Otherwise, write the clearing op (Decision 3).

**Proof a human-set value is never cleared:** `lastKnownFieldSources` returns
the source of the *last* op that wrote `priority`, defaulting unset/NULL
source to `null` (S2a's documented decode). A human write always carries
`source = 'human'` — set structurally by ActivitiesScreen's writer and,
critically, *forced* to `'human'` by `syncServer.js` on any replicated human
write regardless of what a peer claims (S2a's writer census, cited in the
S2a ADR). There is no code path that produces `source === 'import'` for a
human-authored write. Since step 4 requires exact equality to `'import'`,
any `'human'` or `null` source fails the predicate and the activity is
skipped. `'human'` is excluded by construction (correct value, wrong branch
of the `===` check); `null` is excluded by the strict-equality choice below.

**Pre-v29 NULL-source activities (imported before the S2a `source` column
existed): deliberately NOT cleared.** This mirrors the T72 precedent exactly
(`electron/ops/ingest.js` ~lines 555-585): T72 rejected `source !== 'human'`
in favor of strict `source === 'human'` for its own predicate because a NULL
source is ambiguous between two very different origins (there, "director
rejected" vs "import teardown"; here, "pre-v29 import" vs "pre-v29 human
edit that happened to predate the column"), and getting it wrong in the unsafe
direction is worse than leaving it alone. Using `!== 'human'` here to catch
more legacy import garbage would also catch any pre-v29 human edit whose
source is NULL — directly violating this task's hard constraint ("a human-set
priority must NEVER be cleared"). **Confidence: high** that strict equality is
correct; this is not a coin flip, it is the same reasoning the codebase
already committed to once. The accepted cost: some pre-v29 import-manufactured
priorities are missed and stay stale. This is the same over-protection
posture S2a itself documents ("a false 'protect' costs a review click, never a
lost edit") — mirrored here as *a false skip leaves one stale value, never
destroys a real one*. A director can still fix any individual leftover by
hand-editing the activity's priority in ActivitiesScreen, which stamps
`source = 'human'` going forward.

## Decision 3 — Op-write shape and why it does not masquerade as human

```js
const latest = latestOpForEntity(db, 'activities', id) // for parent_op_id chain
appendOp(db, {
  entity: 'activities',
  entity_id: id,
  field: 'priority',
  value: null,
  author_user_id: null,          // no logged-in human authored this
  device_id,                      // getOrCreateDeviceId(db), the Host's own id
  parent_op_id: latest?.id ?? null,
  client_write_id: `backfill-priority-unknown:${device_id}:${id}`,
  source: IMPORT_SOURCE,          // 'import' — electron/ops/ingest.js:385
})
```

- **`value: null`, plain field op, not `DELETE_FIELD`.** `DELETE_FIELD`
  tombstones the whole entity (per its own doc comment in
  `electron/ops/operations.js`); this backfill only clears one field on a
  live activity. `applyProjection` (`electron/ops/projections.js`) sets
  `activities.priority` to `NULL` for an ordinary field op with `value: null`
  — confirmed by the existing S2b field-update path, which already writes
  `null` this way for a "blank field" update.
- **`source: IMPORT_SOURCE`, not a distinct "migration" source.** This is the
  crux of "does not masquerade as human": Policy A's protection gate reads
  `isProtected = !!latest && latest.source !== 'import'`
  (`electron/ops/ingest.js:774`). Writing the clear with `source: 'import'`
  means the field's provenance *stays* import-owned after the clear — a
  future re-import whose plan *does* carry a `priority` for this activity is
  **not** blocked by Policy A (since `isProtected` is `false` when
  `latest.source === 'import'`) and can legitimately overwrite the cleared
  value. Had the clear instead used `source: 'human'` (or a new sentinel
  source), that would incorrectly protect the field from future legitimate
  import updates, which is exactly the "masquerades as a human decision"
  failure the task warns against. A distinct third source value (e.g.
  `'migration'`) was considered and rejected: it isn't `'import'` so the
  `!== 'import'` check in `isProtected` would treat it as protected — the
  same wrong outcome as `'human'` — and it adds a third provenance value
  every other `source`-reading call site in the codebase (S2a's writer census,
  T72's tombstone check, this backfill) would now have to reason about, for no
  behavioral benefit `'import'` doesn't already give.
- **Re-import will not re-manufacture the clear.** B2 already stopped
  `commitCreate`'s rule-derived write (`ingest.js`, the `if (rule.priority ===
  'high' || rule.priority === 'low') fields.priority = rule.priority` guard)
  from firing when a plan doesn't propose a priority. So an ordinary re-import
  of the same legacy camp today writes nothing for `priority` at all — the
  cleared `NULL` simply persists, which is the whole point of this backfill.

## Decision 4 — Sync/replay convergence

Per Decision 1, this only ever runs once, Host-side, gated by `host_backfills`.
The written ops are ordinary field ops on `activities.priority`, indistinguishable
in shape from any other import-sourced clear. They reach connected Clients the
same way every other Host-authored op does: `sendMissedOps`
(`electron/sync/syncServer.js:265`) replays anything with `seq` past a
Client's watermark on its next `authenticate`. A Client applies it through its
normal `op_applied` handling, same as any other op — no special-casing needed,
no new wire message, no new IPC. Two Hosts never run this concurrently against
the same camp (single-camp-per-device, one Host per camp session), so there is
no double-write/conflict scenario to reconcile — this is unlike a Client-originated
write, which is exactly why Decision 1 requires this to be Host-only.

## Decision 5 — Camp scoping

Single-camp-per-device is an existing, documented invariant
(`electron/db/localDb.js`, the v26 migration comment: "camp_id/kind stay
NULL... right only under the single-camp-per-device invariant"). The routine
therefore does not need a `camp_id` parameter — it queries
`SELECT id FROM activities` directly (the `activities` table on this device's
DB already belongs to exactly one camp) rather than joining through `camps`.
If a future multi-camp-per-device device ever exists this routine would need
revisiting, but that is out of scope here and not a decision this backfill
should preempt.

## Round 2: predicate is not reliable — escalation

Red Hat + Governor traced three op-log-indistinguishable origins for a
`priority` field whose latest write has `source === 'import'`:

- **(a) pre-B2 `activityRules` inference** — `commitCreate`, the intended
  backfill target.
- **(b) an explicit priority a director typed into an exported S4
  enrichment workbook**, re-imported. `src/ingest/buildPlan.js:319` reads
  `recFields.priority` off the workbook row; `src/ingest/fieldUpdate.js:64`
  writes it into `fields`. Workbook cell edits are **not** added to
  `item._humanFields` (confirmed: `humanFieldsFor` in `buildPlan.js` is driven
  by a separate `humanEditedFields` side-channel, never by workbook-diff
  cells), so the resulting op — whether it lands via `commitCreate` (a
  brand-new activity row added in the workbook, S4 forces `mode:'add'` so new
  rows are legal) or `commitUpdate` (an existing activity's workbook cell
  edited) — is stamped `source: 'import'` by the same `humanFields.has(field)
  ? 'human' : IMPORT_SOURCE` logic in both `ingest.js:667` and `:695`. **S4 is
  already merged to main**, so real director-typed workbook priorities can
  already exist in shipped user DBs today, not just hypothetically.
- **(c) a director clicking Accept on a stale priority conflict** —
  `electron/main.js:766` stamps `source: stale_accept ? 'import' : 'human'`
  on resolution; this deliberately makes acceptance "stick" as import-owned
  (S2b R1's documented intent) so future re-imports don't re-conflict. This
  always operates on an *existing* activity (a stale conflict presupposes a
  prior value), so it is always an UPDATE, never a CREATE.

### Q1 — is there a reliable op-log-visible distinguisher?

**No — traced and ruled out, not merely "not found yet."**

The strongest candidate, "the priority op is the activity's first/creation-time
op (parent_op_id null) and nothing import-touched it later," would separate
(a) from (c) (c is always a later UPDATE with a real `parent_op_id`) but
**does not separate (a) from (b)**: a brand-new activity added as a workbook
row (S4, `mode:'add'`) with a director-typed priority goes through the exact
same `commitCreate` path as an activityRules-inferred CREATE — same
`parent_op_id: null`, same `source: IMPORT_SOURCE` (workbook cells are never
in `_humanFields`), same field-write shape. There is no batch/grouping
metadata, no distinct `client_write_id` pattern, and no field-set signature
that differs between the two — both go through the identical
`for (const [field, value] of Object.entries(fields)) appendOp(...)` loop in
`commitCreate` (`ingest.js:655-667`). (b)-via-UPDATE and (c) are likewise
identical in shape (`commitUpdate`, `ingest.js:679-700`) — both write a single
field-null-or-value op with `source` chosen by the same `_humanFields`/
`stale_accept` logic, and nothing downstream of `appendOp` records *why* the
caller chose 'import'. The op log records provenance CLASS (import vs human)
by design, deliberately not provenance CAUSE — S2a's whole point was a cheap
binary signal, not an audit trail of which import feature wrote a field. That
design choice is exactly what makes this backfill's finer-grained question
unanswerable from the log alone.

### Q2 — recommendation

No reliable distinguisher exists, so this is a product-owner tradeoff, not a
technical one. Three options:

- **Option 1 — accept collateral damage** (clear every `source === 'import'`
  priority, original Decision 2). Rejected: directly violates the stated hard
  constraint that a director's explicit priority is never touched, and S4
  being already shipped means this is not a theoretical risk — real director
  decisions in the field would be silently erased on first Host startup after
  this ships.
- **Option 2 — narrow-but-imperfect heuristic** (e.g. also require the
  activity has no row in `conflicts` referencing a resolved `priority`
  conflict, as a partial signal against (c)). Rejected: this only screens out
  some of (c) and none of (b) — a director's workbook-typed priority on a
  brand-new or freshly re-imported activity is invisible to any such
  heuristic, so it still fails the hard constraint, just less often. A
  heuristic that can still silently destroy a real decision is not a
  narrower version of a safe design, it's the same defect at lower frequency.
- **Option 3 — do not auto-clear; surface for review.** Replace the automatic
  backfill with a Host-local **read-only report** (or a director-facing list
  in the existing conflicts/import UI) of activities whose `priority` is
  non-null with `source === 'import'` — i.e. exactly the candidate set
  Decision 2 would have auto-cleared, now presented for a director to
  individually confirm ("clear this back to unknown" vs "keep, this was
  mine"). Each confirmation is a normal `human`-sourced or re-confirmed
  `import`-sourced write through the existing ActivitiesScreen path — no new
  op-log primitive, no new source value, just an existing write with a
  human in the loop. This is the only option that satisfies the hard
  constraint with certainty, because certainty here can only come from asking
  the human who'd otherwise be second-guessed by a heuristic.

**Recommendation: Option 3. Confidence: high** that this is the correct
tradeoff given the stated hard constraint is phrased as an absolute ("NEVER
touched"), not a risk-tolerance range — an absolute constraint against an
unreliable signal has exactly one honest resolution, which is to stop trying
to infer and ask instead. Confidence is **not** high on effort/scope: this
turns an "electron/db + ingest provenance helpers" backfill into a small
UI-surfaced review flow, which is larger than this task's original scope
line ("migration/backfill code + electron/db + ingest provenance helpers
ONLY. No B3 work.") anticipated, and likely needs a Designer pass, not just
Architect+Maker. That scope call belongs to Governor/the product owner, not
to this ADR.

If Governor decides the scope increase is unacceptable for this slice, the
remaining honest fallback is **Option 0 — do nothing automatic**: document the
gap (pre-B2 imports may carry a stale manufactured priority that only a
director's own hand-edit in ActivitiesScreen can now correct) and close this
task without a backfill at all. This is strictly safer than Options 1/2 and
costs nothing to build; it just doesn't close the hole the task asked to
close. Not recommended over Option 3 if the review-list scope is acceptable,
but it is the correct answer if it is not.

### Q3 — client_write_id collision (medium, fix regardless of Q1/Q2 outcome)

Confirmed: `operations.client_write_id` is UNIQUE, and the original
`` `backfill-priority-unknown:${id}` `` id has no device component. Two
devices that each become Host for the same camp at different times (e.g. one
offline device never received the other's already-replicated clear op, then
itself becomes Host and runs its own not-yet-applied backfill/review-confirm
write) would independently mint the identical id for the same activity;
whichever op arrives second at the other device violates the UNIQUE
constraint. **Fix: include `device_id` in the id** —
`` `backfill-priority-unknown:${device_id}:${id}` `` (already applied to the
Decision 3 code block above). Dropping `client_write_id` entirely was the
other option raised; keeping it (correctly keyed) is preferred over dropping
it, since it costs nothing and preserves the `findOpByClientWriteId`
traceability hook the rest of the codebase relies on for debugging migration-
and resolution-written rows — the bug was in the key shape, not in having a
key.

## Files/modules affected
- `electron/db/localDb.js`: new v31 migration, DDL-only — `host_backfills`
  table (and `CURRENT_SCHEMA_VERSION` bumped to 31). Also add the matching DDL
  to `schema.sql` for fresh installs (v25/v30 both-places-DDL precedent).
- `electron/ops/ingest.js` (or a new `electron/ops/backfillImportPriority.js`
  under `electron/ops/`): the `backfillImportPriority(db, { device_id })`
  function, built on `lastKnownFields`/`lastKnownFieldSources`/`latestOpForEntity`
  (`electron/ops/restore.js`) and `appendOp` (`electron/ops/operations.js`).
- `electron/main.js`: one call site in `chooseMode`'s `requestedMode === 'host'`
  branch (~line 378), gated by the `host_backfills` marker row.
- New test file, e.g. `electron/ops/backfillImportPriority.test.js`, and a
  migration test for v31 following the `*.migration.test.js` pattern.
- **Not touched:** `src/scheduling/buildSchedule.js`, the engine, any
  projection registration (uses the existing `activities` projection
  unchanged), `PROJECTIONS`, sync wire protocol.

## Reused vs. new
**Reused, unmodified:** `lastKnownFieldSources`, `lastKnownFields`,
`latestOpForEntity` (S2a/restore.js), `appendOp` (operations.js),
`applyProjection`'s existing `activities.priority` handling, `IMPORT_SOURCE`
constant, `getOrCreateDeviceId`, `sendMissedOps`'s existing Host→Client
catch-up path, the `schema_migrations`/DDL-in-two-places migration convention.

**New:** the `host_backfills` marker table (one-time-routine bookkeeping —
nothing existing tracks "did a non-schema startup routine run", as distinct
from "which schema version are we at"); the `backfillImportPriority` function
itself; one call site in `chooseMode`.

## ADR required: yes
Filed at `docs/adr/2026-08-10-legacy-import-priority-backfill.md` (this file).
Meets the bar on two counts: it introduces a new persistent primitive
(`host_backfills`, a table other future one-time routines may reuse) and it
makes a non-obviously-reversible tradeoff (accepting that pre-v29 NULL-source
legacy priorities are permanently out of this backfill's reach, in exchange
for a hard guarantee that no human-set value can ever be cleared).

## Test list for Maker (test-first)
(a) Import-sourced `'high'` → cleared to `NULL`, op written with
    `source: 'import'`, `value: null`.
(b) Human-set `'high'` (`source: 'human'`) → **unchanged**, no op written.
(c) Pre-v29 NULL-source `'high'`/`'low'` → **unchanged, no op written**
    (documented accepted gap, per Decision 2).
(d) Run the routine twice (simulating marker-row loss or a direct
    double-invocation) → second run is a no-op: no new ops, DB byte-identical,
    because the predicate's `fields.get('priority')` is already `null` after
    the first run.
(e) Activity whose `priority` is already `NULL` (regardless of source) →
    untouched, no op written.
(f) After the backfill clears a value, a subsequent import commit whose plan
    proposes a new `priority` for the same activity can still write it (not
    wrongly protected — `isProtected` reads `false` because the clearing op's
    `source` is `'import'`); and a subsequent import commit whose plan is
    silent on `priority` (the current B2 behavior) leaves the `NULL` alone
    (not re-manufactured).
- Migration test: v31 adds `host_backfills` with the right shape on both a
  fresh install and a v30→v31 migrated DB (`PRAGMA table_info` parity,
  matching the v29/`source` column precedent).
- Role test: the routine is invoked when `chooseMode({ mode: 'host' })` runs
  and is **not** invoked when `chooseMode({ mode: 'client' })` runs.

## Open questions for Governor
0. **(Round 2, primary open question, blocks implementation.)** Confirm Option
   3 (surface-for-review, no automatic clear) as the resolution to the
   predicate-reliability problem above, or confirm Option 0 (no backfill,
   document the gap) if the review-UI scope increase is unacceptable for this
   slice. Option 1 (auto-clear everything) and Option 2 (heuristic auto-clear)
   are not available — both violate the stated hard constraint with real,
   already-shipped data (S4 workbook priorities), not a hypothetical edge case.
   If Option 3, this ADR's Decision 2/3 need a follow-up revision (or a
   second ADR) once Governor/Designer settle what the review surface looks
   like — the Decision 1/4/5 mechanics (Host-only, `host_backfills`-style
   marker, sync via `sendMissedOps`) still apply to whatever writes the
   confirmed clears, just triggered by a director's click instead of an
   unconditional startup scan.
1. **Marker id string**: I used `'priority-unknown-backfill-v1'` as the
   `host_backfills.id`. If a second, unrelated one-time backfill is ever
   needed later, this table is the reusable seam — worth confirming Governor
   wants that reuse now rather than a single-purpose boolean flag column
   elsewhere (I recommend the table; it's the smaller of the two once you
   assume a second backfill will eventually exist, but if this is truly
   believed to be the only backfill this app will ever need, a simpler
   boolean flag column on `device_identity` would also work and is slightly
   less machinery — product call, not a technical one).
2. **Timing relative to other Host-branch work in `chooseMode`**: I placed the
   call after `syncServer` starts; confirm there's no reason (e.g. a director-
   facing "first sync" spinner, or `first_sync_completed_at` bookkeeping
   already in that function) that this should instead run before or after a
   different step in that branch — I did not find one, but Governor/Maker
   should confirm nothing in that branch depends on `priority` values being
   present.
