---
title: "ADR: Carry field provenance in the document — a hand edit says so about itself"
document_type: adr
status: accepted
authority: normative
implementation_state: complete
date: 2026-09-09
decided: 2026-09-09
deciders: [product-owner]
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/plans/2026-09-07-stage6-cutover-plan.md
related_tickets: []
related_adrs:
  - docs/adr/2026-09-08-flat-record-shape.md
  - docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
  - docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
supersedes: []
affects:
  - electron/automerge/campDocument.js
  - electron/automerge/seed.js
  - electron/sync/automerge/liveDoc.js
  - electron/ops/ingest.js
program: shoresh-future-architecture
---

# ADR: Carry field provenance in the document

## The decision

The shared camp document gains a `field_provenance` collection: one flat key per field a **human**
has edited. Import writes carry no marker, and clear any marker present.

## Why — a director loses work, silently, today

ADR 2026-08-08 (S2a) promises that a hand edit survives a later re-import. It is implemented by
reading the latest operation's `source` from the `operations` table:

```js
// electron/ops/ingest.js:479
if (latest && latest.source === 'human') continue
```

Stage 6 replaced the transport. `applyWrite(doc, { entity, entity_id, field, value })` carries field
VALUES only — no `source`, no `author_user_id`, no `device_id`. A field that arrived by document
merge has no operation row on the receiving device, so:

- at `:479` the field reads as never-hand-edited, and the re-import overwrites it;
- at `:452` it is worse — `!!latest && latest.source !== 'import' ? 'human' : 'import'` evaluates to
  `'import'`, so the system does not merely forget the correction was human, it **positively records
  it as having come from the spreadsheet**. A wrong record, not a missing one.

The director's experience: fix a group name on the iPad, re-import next season's spreadsheet on the
office computer, and the correction is reverted. **Silent in both directions** — the person who made
it watches it replicate correctly; the person who re-imports sees a clean, successful import. Neither
is shown anything. It surfaces later as "didn't I already fix that?"

The owner's own assessment, recorded because it is the right frame: *"I really don't think that this
matters a whole lot."* Probably true on FREQUENCY — re-import is roughly a once-a-season action, and
the bug needs a hand edit on one device plus a re-import on another. The argument for doing it now is
not urgency, it is **timing**: the document format is shared by every device and pinned by a frozen
genesis, so adding a collection while the project is pre-production is nearly free, and adding one
after real camps hold data is not.

## What is stored

A new genesis collection, `field_provenance`. Its keys join entity, entity id and field with the
**same NUL delimiter `FIELD_DELIM` already uses** for record keys — written here as `<NUL>` because a
literal NUL in a document is invisible and makes the file unsearchable by ordinary `grep`:

```
field_provenance["activities<NUL>act-17<NUL>name"] = "human"
```

Three properties, each deliberate:

**Sparse.** Only human-edited fields have a key. Absence means "not human-owned", which is the
overwhelmingly common case — a camp's data is mostly imported. The document therefore grows in
proportion to how much a director has personally corrected, not to the size of the camp.

**Flat, one register per field.** Same reasoning as the flat record shape (ADR 2026-09-08): a plain
map key is a single CRDT register, so two devices marking the same field converge as an ordinary
per-key resolution rather than a structural merge that can drop one side.

**Set on human writes, CLEARED on import writes.** The marker tracks the LATEST write's ownership,
which is exactly what `latest.source === 'human'` meant. A director accepting an imported value
(S2b's `stale`-accept resolution passes `source: 'import'`) hands ownership back to the importer, and
the marker must go with it. A marker that only ever accumulated would freeze a field permanently
against re-import — a different bug with the same appearance.

## Why it must be in the genesis, not created lazily

This is the load-bearing constraint, and getting it wrong would reintroduce a bug this document layer
has already been burned by.

`campDocument.js`'s genesis comment records it plainly: an earlier revision topped up
`createEmptyDoc()` at runtime with `d[entity] = {}` for collections the frozen root lacked. When two
devices each run that, it is a **concurrent create of the same map key from two actors**. Automerge
keeps one side deterministically and records the other as a conflict visible only through
`A.getConflicts`, which nothing here reads. Confirmed empirically at the time: two devices, one
`template_slots` row each under different ids, merged to ONE row — the other silently gone.

A lazily-created `field_provenance` collection would be that bug again. So the collection joins
`GENESIS_ENTITIES`, and `GENESIS_B64` is regenerated — the **fourth** regeneration, on the same terms
as the previous three: pre-production, no live camps on this sync engine, existing `.automerge` files
may be discarded. That acceptance is not free forever and this ADR does not extend it; it is
available precisely because no real camp has data yet.

`template_slots_scopes` is already a non-entity collection in that list, so a non-entity name is
established precedent rather than a new shape.

## How it is read

`fieldProvenance(db, entity, entityId, field)` becomes the single answer to "did a human set this",
replacing two direct `latestOp(...).source` reads in `ingest.js` (`:452`, `:479`).

It consults the document first and falls back to the op-log. The fallback is not legacy tolerance —
it is what keeps a Host's existing hand edits protected across the cutover, and what keeps the answer
correct on a device whose document has not loaded yet.

## What this does NOT fix

Two other `latestOp` call sites in `ingest.js` — `commitPlan:798` (capturing prior values so an
ingest can be undone) and `ingestUndo:2378` (a staleness check before applying an inverse write) —
also fail on a received merge. They are **not** provenance problems: they need the op ROW to exist,
not its source. That is the local history ledger (the narrowed Stage 6d), which also fixes Trash and
Restore on a receiving device and is the exit criterion for deferred integration scenario 18.

Recorded because it is what makes these two slices separable — and because a `grep` for `source`
would not have surfaced those two sites at all. `graphify affected latestOp` did.

## Alternatives considered

**Do nothing.** Rejected on the wrong-record argument: `:452` actively asserts a false provenance, and
anything reading it downstream treats that as authoritative.

**Synthesize op rows on merge receipt, carrying a `source`.** This is the ledger, and it cannot answer
this question: the document carries no provenance, so a synthesized row would have to INVENT a value.
`'human'` would wrongly protect every imported field; `'import'` would drop the protection entirely.
There is no truthful value available — which is precisely why provenance must live in the document,
and why this ADR is sequenced ahead of the ledger.

**Surface every differing field at re-import and let the director choose.** Consistent with the
owner's conflict policy ("flag it and make someone choose"), and a reasonable shape for genuine
disagreements. Rejected HERE because without the marker it cannot distinguish a hand edit from a
stale value, so it would prompt on every differing field — hundreds of decisions instead of the
handful that are real. The marker is what makes such a prompt possible later; it does not preclude it.

## Consequences

- One more thing to get right on every write path. `applyWrite` gains a `source` parameter; a caller
  that omits it leaves ownership unchanged rather than silently claiming either side.
- The seed path (`seedAllFromSqlite`) must read existing provenance from the op-log, or the Host's
  accumulated hand edits lose their protection at the moment of cutover — the exact failure this ADR
  exists to prevent, arriving through the back door.
- `GENESIS_B64`'s pinning test must be updated with an explicit justification, never silently. Its own
  comment is emphatic that a changed expectation is a compatibility break being hidden unless the
  change is deliberate and explained. This is the deliberate, explained case.
