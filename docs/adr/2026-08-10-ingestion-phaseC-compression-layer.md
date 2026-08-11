---
title: "ADR: Ingestion Phase C — Compression Layer (reconciliation model + decision generation)"
status: proposed
date: 2026-08-10
decided: null
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md]
depends_on_external: []
related_discovery: docs/work/specs/2026-08-10-ingestion-phaseA-discovery.md
program: ingestion-reconciliation
---

# ADR: Ingestion Phase C — Compression Layer

Sub-ADR under the parent (`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md`), covering the
brief's **PHASE C — COMPRESSION LAYER**
(`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`, "IMPLEMENTATION ORDER"): *"convert
ingestion results into understood / needs-attention / missing-unknown / changed → generate
director-facing decisions from unresolved uncertainty."* Phase D (screens) is out of scope; this ADR
designs a pure data layer only.

## Premise verification (re-checked against `work/ingestion-phasec` on main `3fc7582`)

The program's premises have drifted twice before, so every input this design depends on was
re-confirmed against current code rather than trusted from memory:

- **`buildPlan.js` already produces a typed item list** — `src/ingest/buildPlan.js:125` `buildPlan()`
  pushes items with `op` one of `create` (`:349`), `update` (`:248`), `clear` (`:268`), `unchanged`
  (`:286`), and `conflict` (three reasons: `missing_target` `:381`, `alias_divergence` `:419`,
  `ambiguous_identity` `:456`). Every non-conflict item carries `evidence: { tier, matched_name }`
  (`:255`), and update/clear items carry a per-field delta `fields[field] = { from, to, source: 'import' }`
  (`:231`, `:238`). **Confirmed: this is an aggregation over an existing typed shape, not something
  Phase C must invent.**
- **Confidence is a real, reusable primitive** — `src/ingest/confidence.js`: `CONFIDENCE.{HIGH,MEDIUM,LOW}`
  (`:9`), `classifyConfidence` (`:13`), `autoAccepts` (`:24`, HIGH-only today). MEDIUM is defined but no
  current call site emits it (`mediumThreshold` defaults to `highThreshold`, per the file's own
  comment) — **Phase C is free to use the MEDIUM tier in its own bucketing math even though no
  upstream site currently classifies into it; the vocabulary already exists, nothing needs adding.**
- **Setup Readiness is a six-state read**, `src/engine/readiness.js:177` `getReadiness(collections,
  signals)` → `{ key, label, screen, kind, state, message }[]`, `state ∈ {ready, needs-attention,
  missing, optional, not-applicable, in-progress}`. `OPTIONAL_AREAS` (`:76`, Fixed Events, Day
  Overrides) and `FORWARD_AREAS` (`:137`, structurally capped at `optional`) are exactly the brief's
  "NOT IN SOURCE / optional setup areas" bucket — **confirmed reusable as-is, no new area concept
  needed.**
- **`import_evidence` is a real, queryable table** — `electron/db/schema.sql:130`, keyed
  `(camp_id, entity_type, entity_id, field)` unique-latest (`:145`), read via
  `listImportEvidence(db, camp_id, {entity_type, entity_id})` (`electron/ops/ingest.js:296`) →
  `{..., support: <parsed JSON>}`. **Confirmed: the evidence handle a decision needs to carry is
  exactly this tuple — `{entity_type, entity_id, field}` — resolvable through an existing read path,
  not a new one.**
- **C1b (anchor slot drift → MOVED) is real and already computed inside `commitIngest`** —
  `electron/ops/ingest.js:1010-1080`. It is a read-only pre-pass producing `fixedMoved.push({name,
  reason})` entries (`:1080`), reported alongside `fixedSkipped`/`fixedPartial`, and is **not** part
  of `plan.items` — it lives in the fixed-events report object `buildPlan` returns separately
  (`plan.fixedEvents` in, `{fixedCreated, fixedUnchanged, fixedMoved, fixedPartial, fixedSkipped}` out
  of the commit). **Confirmed: this is a second, parallel source of CHANGED-shaped facts that Phase C
  must fold in explicitly — it will not show up by iterating `plan.items` alone.**
- **C1a (group-scope drift on a recognized anchor slot) is documented as read-only-CHANGED, ADD-only**
  — parent ADR D5a (`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md:300-317`): "read-only
  diff of T72's recognized-unchanged... ADD-only to the report shape, with no commit-path write." Its
  exact report field name/threshold is left as an **open question in the parent ADR** (`:341`, "C1a
  report copy"), not yet landed as a named field in `ingest.js`'s return shape as of this commit — grep
  for `C1a` in `electron/ops/ingest.js` returns nothing except comment references naming it
  conceptually. **This is a genuinely open premise: Phase C's CHANGED-folding for group-scope drift
  depends on a field this sub-ADR cannot name precisely yet — flagged as an open question below,
  not assumed.**
- **D4 (priority de-manufacturing) has shipped** — `src/ingest/activityRules.js:17-45`: priority is
  now `'high'|'low'|undefined` where `undefined` (key omitted) means UNKNOWN; new imports never
  manufacture a value. This means the brief's "legacy-priority surfacing" requirement is specifically
  about **rows written by import runs that pre-date this change** — `activities.priority IS NOT NULL
  AND operations.source = 'import'` for the `priority` field, i.e. a value that was stamped as if
  confirmed but never actually was. No dedicated query for this exists yet; Phase C's decision
  generation needs it as an explicit read (see Slice C2b below).
- **Protected-field provenance (human vs. import) is a live-DB check, not part of `buildPlan`'s pure
  output** — `docs/adr/2026-08-10-ingestion-reconciliation-semantics.md:164`: `isProtected =
  !!latest && latest.source !== 'import'`, computed in `ingest.js` against `operations` at
  plan-preview time. `buildPlan.js` itself is pure and does not know field provenance; it only knows
  `from`/`to`. **Confirmed: to distinguish "this update overwrites a director's confirmed value" (real
  CHANGED) from "this update refines an old import-sourced guess" (routine, not CHANGED), Phase C needs
  provenance as an explicit input the caller supplies — it cannot derive this from `plan.items` alone.**

## The reconciliation model

A pure function, no IO, no React, no IPC:

```
buildReconciliationReport(input) -> { buckets, decisions, meta }
```

### Input shape (everything the caller must gather beforehand — reuse only, nothing new to write)

```
{
  planItems: plan.items,                 // buildPlan.js output, unchanged
  fixedEventsReport: {                   // ingest.js's existing report fields, passed through as-is
                                          // (real, unprefixed shape — electron/ops/ingest.js's
                                          // `fixedEvents: { created, unchanged, skipped, partial,
                                          // rejected, moved }`, not the prefixed names used earlier
                                          // in this doc's drafting)
    created, unchanged, skipped, partial, rejected, moved
  },
  fieldProvenance: Map<"entity:id:field", 'import' | 'human'>,
                                          // caller-supplied, built from the SAME isProtected primitive
                                          // ingest.js already runs pre-commit (D5/Policy-A) — reused,
                                          // not reimplemented
  readiness: getReadiness(collections, signals),   // readiness.js output, unchanged
  legacyPriorityActivities: { entity_id, name }[], // rows where activities.priority IS NOT NULL AND
                                          // the priority field's provenance (via fieldProvenance, or a
                                          // direct operations query the caller already has reason to
                                          // run) is 'import' — pre-D4 manufactured values
  evidenceLookup: (entity_type, entity_id, field) => EvidenceRow | undefined,
                                          // thin wrapper the caller builds once from listImportEvidence,
                                          // so the pure function never touches the DB itself
}
```

`planItems`, `fixedEventsReport`, and `readiness` are exactly what the existing importer already
produces for today's ImportScreen — nothing about their shape changes. `fieldProvenance` and
`legacyPriorityActivities` are the only two inputs the caller must additionally assemble, and both are
thin re-uses of primitives that already exist (`isProtected`'s query, and a straightforward
`operations` filter respectively) — **no new domain writes, no new persistent shape.**

### Output shape

```
{
  buckets: { understood: number, needsAttention: number, notInSource: number, changed: number },
  decisions: Decision[],
  meta: { generatedAt: string, planItemCount: number }   // meta is diagnostic only, never load-bearing
}

Decision = {
  id: string,                    // stable, derived from (entity, entity_id, field | 'root') — see
                                  // dedup rule below, so re-running the function over the same plan
                                  // yields the same decision ids (Phase D can key UI state on it)
  kind: 'confirm_value' | 'resolve_conflict' | 'confirm_change' | 'confirm_legacy_priority',
  entity: string,                // 'activities' | 'anchor_activities' | 'groups' | ...
  entityId: string | null,       // null only for create/ambiguous-identity items with no live row yet
  entityName: string,
  field: string | null,          // null for whole-row decisions (e.g. ambiguous_identity)
  confidence: 'high' | 'medium' | 'low' | 'conflict' | 'changed', // 'changed' is confirm_change's
                                  // marker (fixed-event moves) — a distinct categorical value, not a
                                  // tier, same role 'conflict' plays for resolve_conflict
  proposedValue: unknown,
  unknowns: string[],            // field names Phase B left UNKNOWN on this row (e.g. ['priority'])
  evidence: { entity_type: string, entity_id: string, field: string } | null,
                                  // a HANDLE, not inlined evidence — Phase D/CLI dereferences it via
                                  // the same listImportEvidence the caller already used to build
                                  // evidenceLookup
  reason: string,                // human-readable, reuses the exact strings buildPlan/ingest.js
                                  // already produce (conflict.reason, fixedMoved.reason, etc.) —
                                  // Phase C does not invent new copy
}
```

## Bucketing + decision-generation logic

Walk `planItems` once, plus the two side-channels (`fixedEventsReport`, `legacyPriorityActivities`),
plus `readiness`. Every plan item lands in exactly one bucket-contributing outcome; **bucket counts are
never separately tallied — `buckets` is computed as a fold over the same classification pass that
produces `decisions`, so the two outputs cannot drift out of sync by construction** (this was the one
point every ADHD frame converged on independently — regulator, 3am-oncall, and inversion all named
"two numbers describing one reality" as the failure mode to design out).

1. **`op: 'conflict'`** → always a decision, `confidence: 'conflict'`, never counted as understood.
   `kind: 'resolve_conflict'`. Reason is `item.reason` verbatim (`missing_target` /
   `alias_divergence` / `ambiguous_identity`) — the existing vocabulary, unchanged.

2. **`op: 'unchanged'`** → always `understood` (zero delta by definition; `evidence.tier` here reflects
   *identity*-match confidence, not content confidence, so it never gates a decision).

3. **`op: 'create'`** → classify by `item.evidence.tier` translated through `classifyConfidence`-shaped
   logic:
   - HIGH → `understood`.
   - MEDIUM → one decision, `kind: 'confirm_value'`, `confidence: 'medium'`.
   - LOW → one decision, `confidence: 'low'`.
   Any field the item carries as UNKNOWN (per D4 — `priority` omitted, `min_per_week` unset) is listed
   in `unknowns`, but an UNKNOWN field alone does **not** force a decision if the row's identity
   confidence is otherwise HIGH — the brief is explicit that UNKNOWN is a valid resting state, and
   Phase B's generation-time default (D4, "safe default outside the engine and outside the stored
   column") already means an unconfirmed priority does not block schedule-building. A row is
   `notInSource`-flavored, never a manufactured decision, when the *only* unknown is priority/frequency
   with no other confidence concern.

4. **`op: 'update' | 'clear'`** → for each field in `item.fields`, look up `fieldProvenance.get(entity:
   entity_id:field)`:
   - `'human'` → this delta overwrites a director's confirmed value. **CHANGED**, always a decision
     (`kind: 'confirm_change'`), regardless of the item's identity-confidence tier — a real value
     changing under a confirmed field is exactly the case D5/Policy-A exists to make visible, not
     silently apply.
   - `'import' | absent` → routine refinement of a previously-inferred value. Falls through to the same
     HIGH/MEDIUM/LOW classification as `create` above.
   Multiple protected-field deltas on the **same row** fold into **one** `confirm_change` decision
   listing every changed field, not one decision per field (the dedup-by-root-cause rule below).

5. **Fixed-event side channel** (not reachable via `planItems`; field names are ingest.js's real,
   unprefixed shape — `moved`, `partial`, `skipped`, `created`, `unchanged`, `rejected`):
   - `moved` entries → one `changed` decision each, `kind: 'confirm_change'`, `confidence: 'changed'`,
     `field: null`, `reason: entry.reason` verbatim (already human-readable, e.g. "moved from
     Mon/Morning to Tue/Morning" per `ingest.js:1080`'s construction).
   - `partial` entries → `needsAttention`, `kind: 'confirm_value'` (a partially-resolved row, not
     a value conflict).
   - `skipped` entries → **not** a decision. These never got far enough to become an entity; they
     surface as import-run diagnostics (already shown in today's import summary), not as unresolved
     director judgment. Explicitly excluded so the decision count stays honest to the brief's "small
     number of *genuine* decisions."
   - `rejected` entries → **not** a decision either, same reasoning as `skipped`: these are slots the
     director already tombstoned in a prior session, re-encountered on reimport. Re-surfacing one as a
     fresh decision would re-litigate a settled choice, which C1b's read-only posture forbids.
   - `created` / `unchanged` → `understood`.

6. **`notInSource`** — every readiness row with `state === 'optional'` (covers both `OPTIONAL_AREAS`
   with zero rows and all `FORWARD_AREAS`, per `readiness.js`'s own state machine) contributes one to
   the `notInSource` count. This is **not** a decision — the brief's example ("Locations — Not found...
   [Add another source] [Skip for now]") is an action surface Phase D builds, not a human judgment
   Phase C needs to force. `notInSource` count is therefore bucket-only, no corresponding `decisions[]`
   entries, by design (mirrors the regulator frame's point that absence-of-evidence must be
   distinguishable from evidence-of-absence, but does not require manufacturing a decision to say so).

7. **Legacy priority surfacing** — for each row in `legacyPriorityActivities`, one decision,
   `kind: 'confirm_legacy_priority'`, `field: 'priority'`, `confidence: 'low'` (never HIGH — a
   pre-D4 value was never actually judged), `proposedValue: <the stored value>`,
   `unknowns: []` (the value exists, its *authority* is what's in question), and **no** clear action
   —surfaced strictly for confirm-or-edit, matching the brief's "respecting the (a)/(b)/(c) ambiguity —
   never auto-clear." These count toward `needsAttention`, never `understood`, until a director acts.

### Dedup-by-root-cause

Before counting, decisions sharing an `(entity, entityId)` pair collapse into one — a row with three
protected-field deltas is one `confirm_change` decision carrying three fields, not three. This was the
strongest cross-frame convergence (logistics: "waybill consolidation"; inversion: "dedup by root cause
before counting"; game design: "boss fights bundle several decisions into one judgment") and it is also
what makes the brief's target number ("4 decisions", not "40 fields") achievable. `id` is derived from
`(entity, entityId)` (or `(entity, null, reason)` for identity-conflicts, which have no `entityId` yet)
so the same underlying uncertainty always regenerates the same decision id across repeated runs —
load-bearing for Phase D to key resolved/dismissed UI state against later, and for a future CLI/MCP
caller to reference a specific decision by a stable handle.

### `understood` count

Derived, not tracked separately: `planItems.length - decisions.length (attributable to planItems) -
conflictCount already inside decisions` ... concretely, `understood` = the count of items that reached
step 2/3/4 above and did **not** produce a decision, plus `fixedCreated.length + fixedUnchanged.length`.
The brief's "374 observations / facts reconciled" is this number.

## Where it lives

`src/ingest/reconciliationReport.js` — a pure module, sibling to `buildPlan.js` and `confidence.js`,
same directory Phase A/B already established as the domain layer that both a future UI and a future
CLI/MCP can import without touching Electron IPC or React. It imports `CONFIDENCE`/`classifyConfidence`
from `confidence.js` (reuse, not reimplementation) and imports nothing from `src/components/` or
`electron/`. The caller (today: `electron/ops/ingest.js`'s preview/commit path; later: a CLI/MCP
command) is responsible for gathering the input object — this module never queries the DB, never
imports `better-sqlite3`, never imports React.

## Files/modules affected

- **New:** `src/ingest/reconciliationReport.js` (the pure function + its internal classification
  helpers), `src/ingest/reconciliationReport.test.js`.
- **New, small:** a `legacyPriorityActivities` query (likely `listLegacyPriorityActivities(db,
  camp_id)` alongside `listImportEvidence` in `electron/ops/ingest.js`) and a `fieldProvenance` builder
  that reuses the existing `isProtected` check's underlying query rather than re-deriving it.
- **Unchanged:** `buildPlan.js`, `confidence.js`, `readiness.js`, `import_evidence` schema, C1b's
  `fixedMoved` computation — all consumed as-is.
- **Not touched:** any UI component, any IPC handler beyond the caller assembling Phase C's input
  object, the engine (`buildSchedule.js`).

## Reused vs. new

**Reused:** the entire `plan.items` shape and its five ops; `CONFIDENCE`/`classifyConfidence`;
`getReadiness`'s six-state model and `OPTIONAL_AREAS`/`FORWARD_AREAS`; `import_evidence` +
`listImportEvidence` as the evidence-handle dereference path; the `isProtected` provenance check;
C1b's `fixedMoved`/`fixedPartial`/`fixedSkipped` report fields; every `reason` string already produced
by `buildPlan.js`/`ingest.js` (no new copy invented at this layer — Phase D owns copy).

**New:** the classification/bucketing/dedup function itself (genuinely new — no existing code converts
these five inputs into one director-facing shape); the `legacyPriorityActivities` query (new but
trivial — filters existing columns, no schema change); the `fieldProvenance` map builder (new
plumbing, reuses an existing query's *logic*, not a new concept).

## Slice decomposition (dependency order)

- **C1 — the aggregator.** `buildReconciliationReport` covering rules 1–4 and 6 only (plan items +
  readiness; no fixed-event side channel, no legacy priority yet). **First buildable slice.** First
  test seam: feed it a hand-built `planItems` fixture covering all five ops at all three confidence
  tiers plus a readiness fixture with one optional-empty area, assert `buckets` and `decisions[]`
  against exact expected counts and dedup behavior. This slice alone is independently useful — it is
  the part every later slice extends, and it has zero dependency on C1a's still-open report field.
- **C2a — fold in C1b (fixed-event MOVED/PARTIAL/SKIPPED).** Depends on C1. Test seam: a
  `fixedEventsReport` fixture with one `fixedMoved` and one `fixedPartial` entry, assert they surface
  as `changed`/`needsAttention` decisions with `reason` passed through verbatim and `fixedSkipped`
  correctly excluded.
- **C2b — legacy-priority surfacing.** Depends on C1 (uses the same decision shape). Independent of
  C2a — can build in parallel with it. Adds the `legacyPriorityActivities` query + rule 7. Test seam:
  a fixture with one activity whose priority was stamped with `source: 'import'`, assert exactly one
  `confirm_legacy_priority` decision and that it is never auto-cleared.
- **C3 — fold in C1a (group-scope drift), once its report field lands.** Blocked on the open question
  below — the parent ADR has not yet named the exact field C1a emits. This slice cannot start until
  that lands (either as a fourth side-channel array analogous to `fixedMoved`, or as a per-item flag
  on existing `plan.items` — the parent ADR's open question determines which, and that determines
  whether C3 extends the aggregator's plan-item walk or adds a fourth side-channel like C2a did).
- **C4 — `fieldProvenance`-aware CHANGED classification for ordinary update/clear items (rule 4's
  `'human'` branch).** Depends on C1. This is the one rule that requires the caller to supply
  provenance data that today's `ingest.js` computes but does not currently expose in a form Phase C can
  consume directly — worth its own slice because it is the one place this design asks the *caller* to
  do new plumbing (reusing `isProtected`'s query) rather than the module itself.

C1 → {C2a, C2b, C4} in parallel → C3 (external dependency). Phase C is "done" (ready for Phase D to
consume) once C1, C2a, C2b, and C4 land; C3 can follow once its blocking premise resolves without
changing any of C1/C2a/C2b/C4's output shape (it only adds to the `changed` bucket and `decisions[]`,
never removes or restructures).

## The C-vs-D line

Phase C produces `{ buckets, decisions, meta }` and stops. It does not:
- render anything, choose copy/wording beyond passing through existing `reason` strings, decide layout,
  or decide progressive-disclosure interaction (the "Why?" click-to-expand is Phase D wiring the
  `evidence` handle to `listImportEvidence`, not Phase C computing an answer).
- persist a `decisions[]` resolution — resolving a decision is still an ordinary commit through the
  existing plan-commit path (accept/edit → `buildPlan`'s resolution mechanism, `T73`'s
  `resolutionFor`), not a new write path this ADR introduces.
- decide *when* the report regenerates (on every keystroke of a preview edit vs. once per import run)
  — that is a Phase D/caller performance decision, not a Phase C architectural one, since the function
  is cheap and pure either way.

Anything past "here is the classified shape" is Phase D.

## Non-goals

- **No UI, no components, no copy design.** Every string in this design is either passed through
  verbatim from existing code or a placeholder (`kind` enum values) Phase D will render, not word.
- **No incremental commit.** The parent ADR and brief both keep all-or-nothing commit (`docs/adr/
  2026-08-10-ingestion-reconciliation-semantics.md`'s Policy-A discipline); "exception-driven review"
  means the *review surface* is exception-driven, not that Phase C introduces partial-apply. A director
  resolving one decision still goes through the existing whole-plan commit, just with that one field's
  resolution folded in via `resolutionFor` (T73's existing mechanism) — no new partial-write primitive.
- **No engine change.** `buildSchedule.js` is untouched; D4's generation-time default already handles
  UNKNOWN priority outside the engine.
- **No new domain writes, no new persistent shape** beyond the two thin, non-schema-changing query
  additions listed above. `import_evidence`, `operations`, `source_aliases` are all read-only from this
  layer's perspective.
- **No versioned/JSON-Schema'd wire contract for the future CLI/MCP.** The 3am-oncall ADHD frame
  proposed schema-versioning the output at the return boundary; rejected as premature — there is no
  second consumer yet, and adding a version field with no second implementation to validate against is
  speculative hardening against a future that Phase D/E will define concretely. Revisit if/when a CLI/
  MCP consumer is actually built (brief explicitly defers that work).
- **No content-hashed evidence handles.** The regulator/3am frames both suggested content-hashing
  evidence records so a decision fails loudly if its evidence has since changed. Rejected as
  over-engineering for this slice: `import_evidence`'s unique-latest index
  (`camp_id, entity_type, entity_id, field`) already means "the evidence for this field" has exactly
  one current row — a `{entity_type, entity_id, field}` handle plus a fresh `listImportEvidence` read
  at dereference time gives the same freshness guarantee without a new hashing scheme. If evidence
  history/versioning becomes a real requirement later, that is a `import_evidence` schema question, not
  something this compression layer should paper over with a hash today.

## Open questions for Governor / product owner

1. ~~**C1a's report field is not yet named.**~~ **RESOLVED — see "Resolved" section below.**
2. **Where does `fieldProvenance` get built, exactly?** This design asks the caller (today,
   `electron/ops/ingest.js`) to assemble a `Map` from the same query `isProtected` already runs
   per-field, per-item, inline. Should that become a small named export (`buildFieldProvenanceMap`)
   Phase C's caller-side glue re-imports, or is inlining it into the one call site enough? Small
   question but affects whether C4 touches `ingest.js` (extract) or adds new code (assemble inline) —
   product-owner or Governor judgment call on how much refactor-while-you're-there is welcome in this
   slice.
3. **Does `legacyPriorityActivities` need a one-time migration-shaped sweep, or is a plain query at
   report-generation time sufficient?** Given camps that imported before D4 shipped may have dozens of
   manufactured priorities, is surfacing them all as individual decisions (post-dedup, one per activity)
   the right first cut, or should Phase C's C2b slice batch them into a single "N legacy priorities need
   review" decision the way it dedups per-row deltas? The brief's "small number of decisions" principle
   argues for batching; this ADR left them as one-per-activity (rule 7) because batching many
   *unrelated* activities under one decision id breaks the "resolve one, see the effect" model rule 4/
   dedup relies on (each activity's priority is independently judged) — but this is a product call on
   how aggressive Phase C should be about legacy debt specifically, worth confirming before C2b builds.
4. **Should `notInSource` ever carry Phase C decisions**, or is bucket-only (as designed) correct for
   the whole Phase C/D split? The brief's own example shows *actions* ("[Add another source] [Build/use
   camp map] [Skip for now]") attached to a `notInSource` line — this design treats those as Phase D
   affordances over a readiness row, never as `decisions[]` entries, on the reasoning that "skip for
   now" isn't an unresolved uncertainty requiring judgment, it's a no-op. Confirm that reading matches
   intent before Phase D is briefed to build against it.

## Resolved (Governor / product owner, 2026-08-11)

- **C2b decision kind, 2026-08-11 (round 2):** shipped as `review_legacy_priority`, not the draft
  `confirm_legacy_priority` used at lines ~138/223/298. A `proposedValue: null` row is a review
  prompt, not a confirmation, so the kind name should say so — this supersedes the enum value at
  those lines for the legacy-priority decision only.
- **C1 approved to build.** Shipped as `src/ingest/reconciliationReport.js` +
  `src/ingest/reconciliationReport.test.js`, covering rules 1, 2, 3, 4, 6 only (plan items + readiness).
- **Open question 3 (legacy-priority surfacing granularity), resolved for C2b:** BATCH — one
  consolidated "N priorities need review" decision, not one-per-activity. This reverses this ADR's
  original rule-7 draft (one decision per activity); C2b must implement the batched form. Does not
  apply to C1, which does not touch legacy priority at all.
- **Open question 4 (notInSource decisions), resolved: CONFIRMED as designed.** `notInSource` is
  bucket-only and generates zero `decisions[]` entries, for both C1 and every later slice. "Missing
  optional" is never treated as "misconfigured."
- **Open question 1 (C1a's report field name), RESOLVED 2026-08-11 — SHIPPED as C3.** Ingest-side field
  is `fixedEvents.scopeChanged` (`Array<{ name, reason }>`, byte-identical shape to `moved`) —
  `electron/ops/ingest.js:1256` pushes onto `fixedScopeChanged`, `:1347` attaches it to the report as
  `fixedEvents.scopeChanged` (the early-return stub at `:1330` already includes `scopeChanged: []`). The
  report-side fold (C3, `src/ingest/reconciliationReport.js`) consumes
  `input.fixedEventsReport.scopeChanged` and classifies each entry into the CHANGED bucket as a
  `confirm_change` decision with `'changed'` confidence — read-only, surface-only, never auto-applied,
  `proposedValue` stays null — mirroring the C2a `moved` fold exactly (same `addFixedEventDecision`
  call, same `kind`). Dedup uses the existing `(entity, kind, reason, name)` key
  (`fixedEventDecisionId`), no new dedup path: two identical `scopeChanged` entries fold to one decision
  while both count toward `buckets.changed`, same as `moved`; a `moved` and a `scopeChanged` entry for
  the same event key distinctly because their real reason strings always differ ("moved from…" vs
  "scope changed from…"). Covered by `src/ingest/reconciliationReport.test.js`, describe block "C3
  (fixedEventsReport.scopeChanged)". C3 is now shipped, closing this ADR's last open Phase C slice.
- **Open question 2 (where `fieldProvenance` gets built), resolved: EXTRACT.** When C4 is built, the
  `isProtected`-style per-field query in `electron/ops/ingest.js` should be pulled into a small reusable
  helper (e.g. `buildFieldProvenanceMap`) rather than inlined at the one call site, so the map-building
  logic has one definition Phase C's caller-side glue imports. C1 does not build this — it has no
  `fieldProvenance` input — but the decision is recorded here for C4 to honor.
