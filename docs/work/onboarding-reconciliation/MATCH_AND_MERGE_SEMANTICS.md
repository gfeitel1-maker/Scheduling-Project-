---
title: "Match & Merge Semantics — identity, field-merge, and idempotency rules"
document_type: synthesis
status: draft
created: 2026-08-08
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
program: onboarding-reconciliation
archive_when: superseded by an approved implementation plan
---

# Match & Merge Semantics

This is the second spine document for the onboarding-reconciliation program. Where
`RECONCILIATION_ARCHITECTURE.md` defines the `ReconciliationPlan` object and the transaction it feeds,
this document defines the *rules that populate it*: how a proposed item is matched to an existing
entity, when a field is updated versus left alone versus cleared, and how identical re-imports produce
zero writes. It is derived from the synthesis source §4 (match & merge semantics, research-grounded) and
re-confirmed against `electron/ops/ingest.js` (`seedNameMaps`), `electron/ops/operations.js`
(`detectConflict`), and `src/ingest/preview.js` (`buildPreview`, `normalizeName`).

No production behavior is proposed here. This is a pre-approval design artifact.

---

## 1. Identity resolution hierarchy (deterministic first, ordered, entity-scoped)

Matching a proposed item to an existing entity runs a **strict, ordered, deterministic hierarchy**. The
first tier that resolves wins; ambiguity never auto-resolves.

1. **Shoresh UUID** — the item already carries a stable Shoresh id (round-trip case).
2. **Source id** — a stable id the source system carries. *Dormant today*: the current file formats
   (Excel/CSV/text, per ADR 2026-08-01) carry no stable ids. This tier activates only with the S4
   enrichment workbook round-trip, which is Shoresh-generated and *can* carry ids.
3. **Confirmed alias** — a `source_aliases` row (foundation A) previously confirmed by a human maps this
   source label to a Shoresh entity.
4. **Exact normalized name** — `normalizeName` (trim / lowercase / collapse internal whitespace) matches
   an existing row's name. This is the *only* tier today's importer has, and it is preserved verbatim so
   the two import paths cannot disagree (`preview.js`: "Both paths must agree, or the same file imported
   two ways gives two different camps").
5. **Human-confirmed** — none of the above resolves unambiguously; the director is asked (the
   confirm-identity card), and their answer may be remembered as a new alias.
6. **New** — genuinely new; `op: create`, `entity_id: null`.

Two invariants govern the whole hierarchy:

- **Always scoped to entity type.** A location label never matches an activity name; a group never
  matches a tier. Matching is per `entity_type` (a field on `source_aliases`). This is a hard rule: the
  synthesis is explicit that "a location label never matches an activity name," and the map-assisted
  location work (S7) depends on it — a map label that happens to equal an activity name is a *flag for a
  human*, never an auto-created location.
- **Never auto-merge ambiguous.** If two existing entities could plausibly match, the resolver does not
  pick one — it produces a human-confirm item. This is a non-goal made structural: automatic fuzzy
  entity merges are explicitly out of scope.

A confirmed alias (tier 3) **must not silently outrank an exact-name match to a *different* live
entity** (tier 4). If the alias says label→A but an exact-name match points at a different live entity
B, that is a reviewable situation, not a silent alias win. Aliases are shown *each time they fire* (not
applied invisibly), are append-only (supersede/tombstone, never hard-delete), and are revocable.

---

## 2. Fuzzy matching is a suggestion-ranker only

Fuzzy string similarity is **never** an identity tier and **never** auto-commits. It appears only inside
tier 5 (human-confirmed) as a *ranker* — cheap string similarity that orders the candidates presented to
the director on the confirm-identity card. The director still decides.

Two independent reasons rule out anything stronger (synthesis §4):

1. **Scale is too small** for learned probabilistic models or blocking — the research patterns
   (Splink-style probabilistic matching, dedupe.io) are built for record volumes a camp will never
   reach. A camp has tens of activities, not millions of records.
2. **Fuzzy desyncs the op-log across devices.** Fuzzy matching is nondeterministic across library
   versions and inputs; if it drove commits, two devices replaying the same source could produce
   *different* ops, breaking the op-log's determinism. This is a second, independent reason beyond
   "don't auto-merge" — even a director-approved fuzzy *auto-commit* would be unsafe because the commit
   is replicated.

So: deterministic hierarchy decides; fuzzy only *ranks the human's choices*.

---

## 3. Blank vs null vs clear (the tri-state problem, and why S4 needs an explicit token)

An imported cell can mean three different things, and conflating them is the classic silent-data-loss
bug:

- **Blank / absent** — the source simply does not carry this field. **Default behavior: leave the
  current value untouched and emit *no op*.** This is deliberate and load-bearing: emitting no op means
  a blank cannot clobber a concurrent edit (it maps to `op: unchanged` for that field, which produces
  zero `appendOp` calls). This mirrors the Dataverse "unmapped columns are left untouched" pattern.
- **Null** — an internal representation; not a user-facing concept. Not a global mode.
- **Clear** — an *affirmative, visible, per-cell* intent to remove existing data. This requires an
  explicit sentinel (a `<clear>` token, or a dedicated column), never an empty cell.

The trap, stated precisely: **an empty spreadsheet cell is both blank and clear.** A plain `.xlsx` has
no encoding for the tri-state — an empty cell cannot distinguish "I didn't touch this" from "I want this
removed." Therefore the S4 enrichment workbook **must** ship an explicit clear token, and that encoding
must be **decided before S4** (it is a listed decision-gate item). The rejected alternative is a global
hidden mode switch (Salesforce's "Insert Null Values" flag) — a footgun for a non-technical director,
because it silently converts every blank in the sheet into a clear.

In the Plan, a clear is its own op (`op: clear`), gets its own firmer visual treatment in preview
(because it *removes* data), and travels to commit as the existing field-null / `__deleted__` op path —
so it is Trash-restorable and replicates like any other write.

---

## 4. Preview is a pure function returning a diff object, pinned to a base version

The preview is a **dry-run that is a pure function → diff object, carrying no ops**, and it is re-run
*verbatim* at commit. Preview and commit are provably identical because they are the same computation
over the same computed op-set (companion architecture doc §5). The current `buildPreview` in
`preview.js` is already this shape — a pure function that returns a decision object and writes nothing —
today limited to New-vs-Skip; the reconciliation layer widens its output to the full state set:
**New / Updated / Unchanged / Clear / Conflict**, each with field-level before→after.

Two properties the preview must hold:

- **Pinned to a base version.** The diff is computed against a pinned base generation of the camp. If a
  remote op lands in the review window and changes a row's state, the affected rows are
  recomputed/re-surfaced rather than silently going stale. This is the same "pin to base, warn on drift"
  discipline that foundation D uses for staleness, applied to the review session.
- **Legible at scale.** At 40–60 activities the preview is ledger-first: Unchanged collapses to a count,
  Conflicts and Ambiguous auto-expand and gate commit, Clear gets firmer treatment. (UX detail lives in
  the Designer's §9 material; named here only because it constrains what the diff object must expose:
  per-item state, per-field from/to, and a changed-only field list.)

---

## 5. Idempotency: identical source → all-Unchanged → zero ops

Re-importing an unchanged file must be a **no-op**. The mechanism is a **stable match key + a keyed
upsert**: every proposed item resolves (via the §1 hierarchy) to either an existing entity or a create;
when it resolves to an existing entity and every field already equals the proposed value, the item is
`unchanged` and contributes **zero ops**. An identical re-import is therefore all-`unchanged` and writes
nothing — no duplicates, no churn. This is fixture F4 (idempotent re-import → 0 rows) and is
machine-checkable.

Ordering is decided by **source generation, not arrival order** — the same source always produces the
same op-set regardless of when it is imported, which is what keeps the op-log deterministic across
devices (the same property §2 protects). `buildPreview` already demonstrates the no-op case: importing
the same file twice lands in `isNoOp`, and its comment names this "the common case."

Relationship imports (e.g. a group's parent unit) resolve by match key, parents before children;
unresolved references are their own error bucket, never a silent drop.

---

## 6. Cross-source per-field authority

Multiple source families can assert the *same* field (synthesis §8): a schedule source, a facility/map
source, a location-config source, a staffing source. The rule is **per-field authority by source
family**:

- Schedule sources are authoritative for placements, frequency, eligibility.
- Location/config sources are authoritative for location attributes.
- Staffing sources are authoritative for assignments.

When two families disagree on a field, that disagreement is a **first-class `conflict`**, not a
last-writer-wins overwrite. The Plan item must be able to **hold both competing values** — value A from
the schedule, value B from the facility list — with each field-delta's `source` tag recording which
family asserted `to`. This is why the field-delta shape carries `source` per field (architecture doc §3):
authority is resolved per field, per family, and surfaced to the director when families conflict.

---

## 7. Alias conflict is reviewable, not last-writer-wins (a real gap in `detectConflict`)

Two devices can independently confirm the *same* `source_label` to *different* entities (or the same
entity via different evidence). This is a genuine conflict, and it **must surface for human review**, not
silently resolve.

The load-bearing detail: **`detectConflict` in `operations.js` will not catch it.** `detectConflict`
keys on `(entity, entity_id, field)` — it compares an incoming op against the latest op for that exact
tuple (or, for a delete, the latest op for the entity across fields). Two divergent alias confirmations
are writes to *different* `source_aliases` rows (different `entity_id`s) or to a row that did not exist
when each device composed its write, so they do **not** collide under `detectConflict`'s per-field
model. Both would apply, and the later replay would win by arrival — exactly the last-writer-wins outcome
Constitution Article V forbids.

Therefore alias-conflict detection is its **own reviewable-conflict policy**, layered above
`detectConflict`, not something the existing field-level machinery provides. It is a named decision-gate
item (alias-conflict policy: reviewable, not LWW). Aliases remain append-only supersede/tombstone, so a
losing confirmation is never hard-deleted — it is superseded, and the conflict is presented for a human
to resolve.

---

## 8. Persisted provenance: an enum, three looks

Every reconciled row carries provenance as a **persisted enum, not a score** (foundation C): the per-row
`confirmed` and `source` columns, written through `appendOp`. The enum drives **three visual looks**
(the Designer's grammar, proposed as a DESIGN_STANDARD addition):

- **inferred** — muted treatment; Shoresh guessed this from the source.
- **confirmed** — full treatment; a human vouched for it.
- **unknown** — full treatment *plus* a "worth checking" cue. This third look is the one a naive design
  omits, and its absence is a real bug: **absence of evidence must not masquerade as a muted confident
  default.** "Unknown" generalizes the existing `eligibility_known` flag. A muted style says "low
  confidence, we inferred it"; an unknown field is not low-confidence-inferred, it is *unmeasured*, and
  must look different.

Post-commit, a still-inferred record keeps its muted look on its setup screen — trust state must not
evaporate the moment the op commits.

Why an enum and not a per-field confidence table: the op-log already persists field-level
author/device/timestamp (`operations.timestamp`, `author_user_id`, `device_id`), so field-level
provenance already exists. Only the *row-level trust state* is new, and two columns capture it. This is
the minimal-viable-lineage pattern (enum, not score).

---

## 9. Research sources cited (from synthesis §4)

The semantics above are grounded in these external patterns, cited so an implementer can check the
prior art:

- **Salesforce External-Id upsert** — the keyed-upsert / stable-external-key idempotency model
  (help.salesforce.com/s/articleView?id=000320964).
- **DUPLICATE_VALUE vs DUPLICATE_EXTERNAL_ID** — the two distinct duplicate failure modes (Gearset).
- **Dataverse alternate keys + unmapped-columns-untouched** — the blank-leaves-untouched default
  (learn.microsoft.com).
- **Airtable merge-on-a-field** — silent multi-update as a documented anti-pattern.
- **OneSchema / Flatfile / CSVBox** — fix-in-grid preview UX.
- **django-import-export** — `dry_run` + `RowResult` (new/update/skip/error/invalid) + `import_id_fields`
  + `skip_unchanged`: the closest prior art for the whole preview/idempotency model.
- **dbt snapshots** — SCD2 + `unique_key` merge (per-key upsert semantics).
- **Singer / Meltano** — `primary_key` + bookmark idempotency.
- **Splink** — probabilistic vs deterministic matching + a human-review band (why fuzzy stays a ranker).
- **dedupe.io** — human-in-the-loop dedup (why humans confirm, machines don't merge).
- **MPI (Master Patient Index)** — identity crosswalk + reversibility (why aliases are revocable).
- **minimal-viable-lineage** — enum, not score, for provenance.

---

## 10. Inconsistencies found

None. Every code-grounded claim was re-confirmed against the source on 2026-08-08:

- `detectConflict` (`operations.js` ~455–468) keys on `(entity, entity_id, field)` (with the delete
  cross-field extension), confirming the alias-conflict gap in §7 — divergent alias confirmations to
  different `entity_id`s do not collide there.
- `normalizeName` (`preview.js` ~44) is exactly trim/lowercase/collapse-whitespace, and `buildPreview`
  is a pure New-vs-Skip function with an `isNoOp` path, confirming §1 tier 4, §4, and §5.
- `seedNameMaps` (`ingest.js` ~269) resolves names→ids against the live DB inside the transaction,
  confirming the resolution point referenced by §1 and §5.
