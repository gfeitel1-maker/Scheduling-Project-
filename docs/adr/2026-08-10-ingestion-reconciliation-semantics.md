---
title: "ADR: Ingestion Reconciliation Semantics — OBSERVED / INFERRED / CONFIRMED / UNKNOWN"
status: accepted
date: 2026-08-10
decided: 2026-08-09
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/work/onboarding-reconciliation/RECONCILIATION_ARCHITECTURE.md, docs/adr/2026-08-06-inferred-activity-rules-at-ingest.md, docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md]
depends_on_external: [fix/fixed-event-reimport-tombstone]
related_discovery: docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md
program: ingestion-reconciliation
---

# ADR: Ingestion Reconciliation Semantics

**Status: ACCEPTED — product owner has approved D1–D7 as extensions of the existing
onboarding-reconciliation spine. Phase B (B0) may begin once `fix/fixed-event-reimport-tombstone`
merges to `main`. See "Product owner decisions (2026-08-09)" below for the record of what was
decided and why.**

## Context

The founding brief (`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`) asks Shoresh to
compress hundreds of schedule observations into a reconstructed camp model plus a *small number of
genuine decisions*, distinguishing four information states — OBSERVED, INFERRED, CONFIRMED, UNKNOWN —
where **UNKNOWN is valid and Shoresh must never manufacture certainty**.

Phase A discovery (`docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md`) found that the
reconciliation *mechanics* already exist and are largely landed via the prior
`onboarding-reconciliation` program: the field-delta `ReconciliationPlan` (`src/ingest/buildPlan.js`),
per-field import/human provenance (`operations.source`), `source_aliases` identity, held-conflict
resolution (T73), and the six-state Setup Readiness model (`src/engine/readiness.js`). It also found
three genuine gaps against the brief, and one active bug.

This ADR proposes the semantics that close those gaps **as extensions of the existing spine**. Its
governing constraint is the brief's and Reviewer's shared warning: **do not build a second parallel
model.** Where the prior program already decided something (foundations A–D, readiness six-state,
location slice S3), this ADR defers to it and cites it.

## Product owner decisions (2026-08-09)

The product owner reviewed OQ1–OQ6 (as originally posed in the proposed draft of this ADR) and
decided the following. These are now ACCEPTED and govern everything below; the "Decision" and
"Recommended decomposition" sections have been updated to match.

1. **Extend the existing onboarding-reconciliation spine — do not rebuild (resolves OQ6).**
   Phase B begins with a reconcile-baseline slice (B0) on top of the landed plan/provenance/readiness
   code, and the three genuine deltas (four-state vocabulary incl. first-class UNKNOWN, stop
   manufacturing certainty, evidence-survives-commit) layer on top of it. Every ticket must be framed
   as an extension of the prior program, never as a parallel system.
2. **The fixed-event resurrection bug is fixed separately, ahead of Phase B.** The "deleted fixed
   event resurrects on re-import" bug (discovery Red Hat Risk 1; the D5 tombstone work below) ships as
   its own standalone PR to `main` on `fix/fixed-event-reimport-tombstone` — a branch that already
   exists in this repo. It is **removed from Phase B ticket scope** (see B3, redefined below) and
   recorded as an **external prerequisite**: Phase B builds on that fix once it is merged to `main`
   and this integration branch rebases onto it.
3. **Keep all-or-nothing commit for now (resolves OQ5).** No incremental-commit primitive is scoped
   in this phase. The reconciliation report and focused decisions ship against the current
   hold-the-whole-import gate (`ingest.js` HELD sentinel). Consequence, recorded explicitly: true
   exception-driven review — "resolve one decision, the rest of the import already landed" — is
   therefore **partial** in this phase. A director can resolve a *held conflict* and re-commit (T73
   already supports that round-trip), but cannot commit the *understood* 90% of an import while a
   *different, unrelated* low-confidence decision remains open; the whole import still commits or
   holds as one unit. Incremental/partial commit is recorded as a **future follow-up**, not built now.
4. **Three technical recommendations accepted as-is (resolves OQ1–OQ3).** Investigation (see D1, D3,
   D4 below, and the group-scope-drift investigation) surfaced no concrete reason against any of the
   three:
   - (a) OBSERVED-vs-INFERRED is a property of the evidence record (D3), not a widened
     `operations.source` enum. **Accepted.**
   - (b) The evidence bundle is a host-local artifact with its own sub-ADR, not a synced entity.
     **Accepted.**
   - (c) UNKNOWN priority resolves to a safe default at generation time, engine untouched, no new
     engine bucket. **Accepted.**
5. **Fixed-event group-scope drift on re-import (OQ4) — resolved below with evidence**, see D5.

## Decision

### D1 — The four states are DERIVED from existing signals, not a new stored enum

We do **not** add a `state` column. OBSERVED/INFERRED/CONFIRMED/UNKNOWN are computed at read time from
signals that already exist (or are added minimally by D2–D3):

| State | Derivation | Backing signal |
|---|---|---|
| **CONFIRMED** | field's latest op has `source='human'` | `operations.source` (schema v29) — already exists |
| **INFERRED** | `source='import'` AND value came from a heuristic rule (activityRules/fixedEvents), not a literal grid fact | requires the OBSERVED-vs-INFERRED tag of D2 |
| **OBSERVED** | `source='import'` AND value is a literal fact read from the source (a name that appeared, a cell) | requires D2 tag |
| **UNKNOWN** | field never written — column NULL, no op | already representable; the fix is that the importer must *stop writing manufactured values* (D4) |

This reuses `RECONCILIATION_ARCHITECTURE.md` Foundation C (per-row `source`/`confirmed`, "enum not
score") and extends it with exactly one new distinction — OBSERVED-fact vs INFERRED-rule — which that
program collapsed. A separate confidence/state table is rejected: the op-log already persists
field-level author/device/timestamp, so state is derivable, and a parallel table is precisely the
duplication the brief forbids.

**OQ1 — RESOLVED, ACCEPTED (b):** the OBSERVED-vs-INFERRED distinction is a property of the
persisted evidence record (D3) that the read layer joins against, not a widened `operations.source`
enum. This keeps `operations.source` stable (nothing downstream that switches on `source` needs to
learn a third/fourth value) and puts the "why" next to the evidence it annotates.

### D2 — Confidence is one primitive, computed in the domain, driving director attention

Today three incompatible schemes exist: `activityRules.js:82` (priority threshold 0.8),
`fixedEvents.js:46` (`confidence:'high'|'low'`), `preview.js:107-111` (`lowConfidence` boolean). We
introduce **one** confidence primitive (a small domain module, e.g. `src/ingest/confidence.js`, or a
field on `buildPlan` items — the existing `evidence` field is the natural home) that these call sites
normalize into, with three tiers mapping to the brief's attention model:

- **HIGH** → reconstruct silently; appears only in the UNDERSTOOD count. No decision surfaced.
- **MEDIUM** → a "Looks right / Edit" proposal (not a form).
- **LOW / CONFLICT** → a focused decision surfaced in NEEDS ATTENTION.

The auto-accept policy currently living in the UI (`ImportScreen.jsx:130,284-299`) moves into this
domain module so a future CLI/MCP inherits it (brief: "no critical semantics exclusively in UI").
This is DOMAIN (a contract other stages consume) but requires no schema change.

### D3 — Evidence survives commit (persist the observation bundle)

Today the observation layer (`extractEntities.js` `seenCounts`/`activityPages`;
`fixedEvents.js:66-79` `occupied`/`operatingDays`) is transient and discarded when the import session
ends, so "Why does Shoresh think this?" is **unanswerable after commit** — directly violating the
brief's transparency principle. We persist a per-import-run evidence record keyed to the entities/fields
it justifies, so the reconciliation report and progressive-disclosure "why?" panels read real evidence.

This is the one genuinely **new persistent data shape** and the part most likely to need its own
focused ADR under the Constitution's ADR bar. It must be host-local or synced consistently with how
`source_aliases` is handled; it must not become a second provenance system (it *annotates* provenance,
it does not replace `operations.source`).

**OQ2 — RESOLVED, ACCEPTED (host-local):** the evidence bundle is a host-local artifact, projected for
read, not a synced entity like `source_aliases`. Evidence is large and import-run-scoped and does not
need to drive engine behavior. Revisit only if multi-device "why?" becomes a requirement. The exact
storage shape (file vs. table, retention/GC policy) is still deferred to the D3 sub-ADR (B4) — this
resolves *where the data lives relative to sync*, not its physical shape.

### D4 — Priority stops being manufactured; UNKNOWN never reaches the engine as a fake value

`activityRules.js:82` forces every activity to `high|low` from prevalence (`share>=0.8`) — the brief's
explicit `frequent != high priority` violation, written to the engine-consumed `activities.priority`
column indistinguishably from a director's choice. We change inference to emit **UNKNOWN priority when
evidence is insufficient** and never write a manufactured value pre-confirmation.

Because `buildSchedule.js:302` (`runRound` filtering `priority==='high'|'low'`) cannot accept a third
value, we resolve UNKNOWN priority to a **safe default at generation time, outside the engine and
outside the stored column** — treat absent priority as low-but-flagged-NEEDS-ATTENTION. The engine is
untouched; the column stays NULL until a director confirms; the report surfaces the decision. The
symmetric treatment applies to frequency (`min/max_per_week`): carry confidence, and stop `ingest.js:600-604`
force-defaulting `min_per_week=1` where that manufactures a binding constraint.

**OQ3 — RESOLVED, ACCEPTED (a):** generation-time default, engine untouched, for Phase B. Revisit
option (b) — a real engine bucket — only if directors report needing unknown-priority activities to
schedule *distinctly* from low-priority ones, which is a scheduling-behavior request this ADR does
not anticipate from the brief.

### D5 — Confirmed decisions survive re-import uniformly; rejections are durable

Extend the protected-field list (`ingest.js:179`, currently activities-only) to `groups.tier_id`,
tiers, and fixed events, so CONFIRMED persists across re-import for every entity — the explicit backing
for the brief's "confirmed decisions survive re-import," not an incidental side effect.

> **B3 CORRECTION (2026-08-10, resolved as already-satisfied).** This D5 premise was **stale** — the
> exact diff-scope-vs-conflict-hold conflation B0 flagged. The Policy-A protection gate is **already
> field-agnostic**, not activities-only: `ingest.js` `isProtected = !!latest && latest.source !== 'import'`
> fires for any field of any update/clear item. `COMPARABLE_COLUMNS` (`ingest.js:174`) is the **diff
> scope**, not the protection list, and already lists `groups`/`tiers`. Verified: `groups.tier_id`
> human-protection was already implemented and fully tested (`ingest.unit-provenance.test.js` — hand-edit
> survives + real change reconciles); fixed-event protection was already implemented and tested
> (`ingest.t72.test.js` recognize-and-skip **+ PR #35** rejection tombstone); tiers have **no diffable
> field** on re-import (buildPlan excludes index-derived `sort_order`, S2c §2), so a recognized tier is
> always `unchanged` and has no clobber path. Broadening `COMPARABLE_COLUMNS` would be **harmful** (it
> would newly diff `sort_order` and manufacture spurious re-order conflicts). **B3 is therefore closed
> as already-satisfied by S2b + T72 + PR #35, with regression tests added** (`ingest.b3-protection.test.js`)
> locking the "CONFIRMED survives re-import for every entity" predicate — **no** production-code change,
> **no** `COMPARABLE_COLUMNS`/gate broadening, **no** schema migration.

**The deleted-fixed-event resurrection bug (discovery Red Hat Risk 1, HIGH) is fixed separately,
external to this ADR's Phase B scope**, per product owner decision 2 (above): a director's rejection
of an inferred fixed event must leave a durable tombstone so re-import does not silently recreate it
(`deleteRecord.js:236-240` hard-deletes; `ingest.js:687-695` rebuilds from live rows only). That fix
lands on `fix/fixed-event-reimport-tombstone` as a standalone PR to `main`, reusing the append-only
supersede/tombstone discipline already used for `source_aliases`. **B3 depends on that PR merging to
`main` and this branch rebasing onto it.**

### D5a — Fixed-event group-scope drift on re-import (OQ4, resolved with evidence)

**Investigation.** The current behavior — a changed group scope on an already-recognized fixed-event
slot is silently left untouched on re-import — is not an oversight; it is a deliberate, documented
decision made in `docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md` ("T72"), implemented at
`electron/ops/ingest.js` in the per-day anchor fan-out (`anchorSlotKey`, comment: *"Group-scope changes
on an existing slot are recognized here and left untouched (anchor updates are out of scope per ADR
§4)"*).

T72's own rationale, read in full, is narrower than "drift doesn't matter" — it is a **duplication-avoidance**
decision:

- T72's anchor identity key is `(camp_id, cohort_id, day_id, time_block_id, normalizeName(name))` —
  deliberately **excluding** `is_all_groups`/`group_ids`.
- The ADR is explicit about why: *"including `group_ids`/`is_all_groups` in the key is what
  reintroduces the duplication T72 exists to kill. If a director's file later widens or narrows a
  fixed event's group set, a group-inclusive key would compute a different key and create a second
  row beside the old one — the exact silent duplicate the ticket forbids."*
- T72 then chose recognize-and-skip (no duplicate, no update) as *"the smallest responsible fix that
  satisfies the ticket's success predicate,"* and named the cost explicitly in its own "Open question
  for Governor": drifted group scope is a **known, accepted limitation**, deferred — in T72's own
  words — to *"a later anchor-reconciliation slice."*

That later slice is this program. T72 was never a position that group-scope drift is unimportant; it
was a scoping decision that fixing duplication and fixing drift-visibility are two different problems,
and T72 solved only the first, on the explicit understanding that the second would be picked up later
by whatever body of work owns reconciliation and re-import semantics — i.e., by this ADR.

**Recommendation: nuanced middle — surface as CHANGED, do not apply.** Add a **read-only comparison**
in the compression/report layer (Phase C, not Phase B): for every anchor slot the T72 loop recognizes
as already-existing (i.e. it takes the skip branch), diff the import's resolved `(is_all_groups,
group_ids)` against the live row's stored values. If they differ, emit a CHANGED item into the
reconciliation report ("Mifkad's group scope in this file differs from what's configured — Pool: was
all groups, source says 4 of 6 groups"). **Do not write anything to the anchor row.** This is
deliberately *not* the "minimal anchor-scope update" that T72's own open question already considered
and rejected as out-of-scope for that ticket — accepting that update path now would (a) touch the
commit path T72 was careful to keep create-or-skip-only, (b) need its own staleness/Policy-A-equivalent
protection semantics (a director may have hand-edited the anchor's scope since import), and (c) is
exactly the kind of "pull the deferred update forward" scope creep the brief and Reviewer both warn
against. Surfacing as CHANGED needs none of that: it reads the same live row the skip branch already
looked up, costs nothing at commit time, respects owner decision 3 (no incremental-commit — this is a
report annotation, not a partial write), and directly satisfies the brief's re-import philosophy
("what changed" must be visible) without reopening T72's duplication-avoidance guarantee. Confidence:
high — the T72 identity key stays untouched, the comment at the skip branch stays accurate as written,
and the new behavior is additive to Phase C (C1 report aggregation), not a Phase B commit-path change.
An actual anchor-scope *update* capability (apply the new scope, with its own conflict semantics)
remains a future follow-up, exactly as T72 already flagged.

### D6 — The reconciliation report is an aggregation over existing outputs (PRESENTATION)

UNDERSTOOD / NEEDS ATTENTION / NOT IN SOURCE / CHANGED is a read view, not an importer rewrite (Q4):
- UNDERSTOOD ← HIGH-confidence plan items (`create`/`unchanged`).
- NEEDS ATTENTION ← LOW/CONFLICT items + held conflicts.
- CHANGED ← `update`/`clear` items with a `from`≠`to`.
- NOT IN SOURCE ← `readiness.js` FORWARD_AREAS (location/staffing), **not** the plan.

It reuses `ReconciliationLedger.jsx`'s `LedgerSection` pattern with a new semantic-category aggregation
above it, and becomes the **primary post-import destination**, demoting per-entity tick-walls and
`ActivityRuleRow` forms to on-demand "advanced/inspect" affordances reached from a decision.

### D7 — Future facility-map: preserve room, build nothing

No `locations` table now (Q10/Q11). Keep `activities.location` as free text; keep `readiness.js`
FORWARD_AREAS treating location as optional-not-blocking; never infer-and-write location from a schedule
grid. First-classing (`activity_locations` + nullable `location_id` soft-migrate) is the prior program's
slice **S3** — deferred, not pulled forward. One-line forward note: a future `locations` ingestible type
grows at `source_aliases.entity_type` / `INGESTIBLE_ENTITIES` (`extractEntities.js:22-24`).

## Consequences

- **Positive:** director workload becomes proportional to genuine uncertainty; "why?" is answerable
  post-commit; the priority/`frequent` anti-pattern is removed; the rejection-resurrection bug is fixed
  (external, ahead of Phase B); group-scope drift becomes visible without reopening T72's duplication
  guarantee; no parallel model is created; the security envelope is untouched.
- **Costs / risks:** D3 (evidence persistence) is new storage needing its own sub-ADR and migration;
  D4 requires care that generation-time defaults never leak back into stored columns; B3 depends on an
  external branch merging first; keeping all-or-nothing commit (owner decision 3) means Phase D's
  exception-driven review is partial, not the brief's full "resolve one, the rest already landed" —
  this is an accepted, explicit scope limit, not an oversight. All changes are additive/reversible
  except the evidence-persistence migration.
- **Explicitly NOT decided here (deferred to prior program or later):** location first-classing (S3),
  staffing model (S6), map/paste adapters (S7), MCP/CLI (seam only), engine enforcement of new
  constraints (its own slice), incremental/partial commit (future follow-up per owner decision 3),
  anchor group-scope *update* (future follow-up per D5a).

## Finalized Phase B/C/D decomposition (domain before UI)

Dependency-ordered; each slice is test-first at its seam, on a child worktree off this integration
branch, merged to the integration branch (never straight to `main`) after review + Verifier gate.

**External prerequisite (not a Phase B slice, but gates B3):**
- `fix/fixed-event-reimport-tombstone` — standalone PR to `main` fixing the deleted-fixed-event
  resurrection bug (discovery Red Hat Risk 1). Owned separately, ahead of this program. Once merged,
  this integration branch rebases onto `main` before B3 starts.

**Phase B — DOMAIN (must land before any UI):**
- **B0 — Reconcile & confirm baseline.** Diff this brief against `docs/work/onboarding-reconciliation/`
  landed state; confirm which spine pieces are on `main` vs the onboarding branch. *Blocks everything.*
- **B1 — One confidence primitive** (D2). Unify the three schemes; surface `eligibility_known`. Extract
  auto-accept policy out of `ImportScreen.jsx`. Depends: B0.
- **B2 — Priority/frequency de-manufacturing** (D4). UNKNOWN priority; generation-time default; stop
  min_per_week force-default. Test: `frequent != high priority`; UNKNOWN stays UNKNOWN. Depends: B1.
- **B3 — Protected-field broadening** (D5, tombstone work removed from scope). ~~Broaden `ingest.js:179`
  to `groups.tier_id`, tiers, fixed events.~~ **CLOSED 2026-08-10 as already-satisfied** — the "broaden
  the activities-only list" premise was stale (see D5 CORRECTION): the Policy-A gate is already
  field-agnostic and every named entity is already protected (S2b `groups.tier_id`; T72 + PR #35 fixed
  events; tiers have no diffable field). Delivered as **regression tests only** (`ingest.b3-protection.test.js`)
  locking the predicate — no production change, no schema migration. Test: CONFIRMED survives re-import
  for every entity. Depends: B0 **and** `fix/fixed-event-reimport-tombstone` merged to `main` (both met).
- **B4 — Evidence persistence** (D3, sub-ADR). New storage + migration. Depends: B1.
- **B5 — OBSERVED-vs-INFERRED tag** (D1/OQ1, accepted as evidence-record property). Depends: B4.

**Phase C — COMPRESSION LAYER (read/aggregation):**
- **C1 — Semantic-category aggregation** over `plan.items` + confidence + readiness → the four report
  buckets, including CHANGED via `from`≠`to` and NOT-IN-SOURCE via FORWARD_AREAS. Depends: B1–B5.
- **C1a — Group-scope-drift CHANGED signal** (D5a). SHIPPED as read-only detection
  (`electron/ops/ingest.js`, tested in `electron/ops/ingest.scope-drift.test.js`): for a slot T72's
  recognize-then-skip finds already live, the incoming resolved scope (`is_all_groups`/`group_ids`,
  gated on `droppedGroups === 0` so a partial group resolution never reports a false drift) is diffed
  against the live row's scope (captured in the same live-anchor scan that builds `anchorSlots`, as a
  parallel `slotKey -> { is_all_groups, group_ids }` map). A difference is reported as
  `outcome.fixedEvents.scopeChanged`, an array of `{ name, reason }` mirroring `moved`'s shape — reason
  reads e.g. `"scope changed from all groups to Bunk 1"`. `scopeChanged` is ADDITIVE to `unchanged`, not
  a replacement for it — B3 protection (`ingest.b3-protection.test.js`) already locks a hand-narrowed
  live scope re-imported against its original file as counting `unchanged`, so scope drift is reported
  alongside that count, never instead of it (unlike `moved`, which does suppress `unchanged`/create,
  because moved is a slot-identity match, not an orthogonal annotation). No op is ever appended for a
  scope difference and the anchor row is never mutated — same read-only posture as C1b. The MOVED
  pre-pass in C1b runs first and `continue`s before this branch, so a slot that pairs as a move never
  also reports scope drift, even if its scope also changed (case 6 of the scope-drift suite). Depends:
  C1 (same aggregation pass), and does not depend on B3/the tombstone fix (it reads existing anchors, it
  does not touch deletion/creation). The C1 fold into the report's CHANGED bucket (`reconciliationReport.js`)
  is NOT part of this slice — `scopeChanged` exists on `commitIngest`'s outcome only, not yet surfaced
  in the reconciliation report UI.
- **C1b — Slot-identity-drift MOVED signal** (Red Hat finding during B3 review; ticket
  `C1b-anchor-slot-drift-moved-signal.md`). T72's recognize-then-skip matches an anchor by EXACT slot
  identity (`cohort_id, day_id, time_block_id, normalizeName(name)`), so a live anchor a director moved
  via AnchorsScreen (`day_id`/`time_block_id` only — `cohort_id` and `name` never change) is invisible to
  it: re-importing the original file used to mint a silent duplicate at the old slot. A set-cardinality
  pre-pass, partitioned by `(cohort_id, normalizeName(name))` and computed once after the live-anchor
  scan/teardown, pairs a group's single unmatched live slot against its single unmatched file slot and
  reports the file slot as `fixedEvents.moved` (`{ name, reason }`, matching `skipped`/`partial`'s shape)
  instead of creating; every other cardinality (0:N, N:0, N:M with either ≥2) falls through to the
  existing create/skip/reject behavior unchanged, and a tombstoned file slot never re-enters the pairing
  pool (a human rejection stays a rejection). Read-only: no op is ever appended to the anchor row — like
  C1a, this is ADD-only to the report shape, with no commit-path write and no actual move reconciliation
  (that heavier slice stays out of scope). Depends: C1 (reads T72's recognized live-anchor set; sibling
  of C1a, not a dependency of it — the two diff different dimensions of the same slot).
- **C2 — Director-decision generation** from LOW/CONFLICT + held items ("Looks right / Edit"). Depends: C1.

**Phase D — EXPERIENCE (presentation):**
- **D1 — Reconciliation report as primary destination** (D6), reusing `LedgerSection`; demote tick-walls.
- **D2 — Focused decision resolution** cards; progressive "why?" reading persisted evidence.
- **D3 — Setup Readiness integration** for NOT-IN-SOURCE ("Ready to build a week. Locations not configured.").
- Note (owner decision 3): D2's decision resolution operates within the all-or-nothing commit; it is
  "resolve a held conflict, then re-commit the whole import" (T73's existing round-trip), not
  "commit the understood 90% while one unrelated decision stays open."

**Phase E — VALIDATION:** real import, re-import same, modified import (CHANGED, including group-scope
drift), incomplete import (UNKNOWN), multi-source enrichment, regression suite, UI/UX audit against the
success test (decisions, not fields).

## Open questions for the product owner

All six original open questions (OQ1–OQ6) are resolved — see "Product owner decisions (2026-08-09)"
above and the inline resolutions in D1, D3, D4, and D5a. Remaining questions, all narrow and
implementation-level (none block starting B0):

1. **B4 sub-ADR scope:** the physical shape of the host-local evidence artifact (single JSON blob per
   import run vs. a lightweight local table; retention/GC policy for old import runs) is still open and
   belongs in B4's own sub-ADR, per OQ2's resolution. Not a blocker for B0–B3.
2. **C1a report copy:** the exact wording/threshold for the group-scope-drift CHANGED item (e.g.
   whether a one-group difference out of twelve reads the same as "half the groups changed," or needs
   a magnitude cue) is a presentation-layer judgment call for whoever writes D1/D2 UI copy — flagged
   here so it isn't silently decided in code.
3. **Rebase timing:** confirm whether this integration branch should rebase onto `main` as soon as
   `fix/fixed-event-reimport-tombstone` merges (recommended, keeps B3 unblocked promptly) or wait for a
   batch of unrelated `main` changes — an operational/scheduling call, not a technical one.
