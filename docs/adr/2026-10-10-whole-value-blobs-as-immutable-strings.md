---
title: "Whole-value JSON blobs in the camp document are stored as ImmutableString"
document_type: adr
authority: normative
status: accepted
implementation_state: implemented
date: 2026-10-10
decided: 2026-10-10
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
amends:
  - docs/adr/2026-07-28-first-pairing-domain-sync-and-template-identity.md (template_slots_scopes holds each scope's slot set as one register; that register is now an ImmutableString, not Automerge Text)
implements: []
related_adrs: [docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
---

# Whole-value JSON blobs are stored as ImmutableString

## Context

Two values in the camp document are whole JSON blobs that are only ever replaced whole: a
template's bulk-replaced slot set (`template_slots_scopes[template_id]`, written by every
regenerate and manual bulk save) and a saved schedule version (`schedule_snapshots.slots`).
They were already meant to be single last-writer-wins registers. Automerge 3 stores a plain JS
string as collaborative Text, one op per character, so each write added hundreds of thousands of
ops to permanent history. An imported camp measured on 2026-10-10 held 2.9M ops in 229 changes,
nearly all from these two, and spent 5.5s of CPU in `A.load` at every launch, growing with every
regenerate and snapshot.

## Decision

- Both blobs are written as `ImmutableString` (`A.RawString`): one op per write, the same
  last-writer-wins register the design already intended. Text gave no merge benefit, because the
  value is never edited in place.
- The write seams are `applyBulkReplace` and `storedValue(entity, field, value)` in
  `electron/automerge/campDocument.js`, used by the field write path and by conflict resolution
  (`resolveConflictInDoc`). The set of whole-value fields is `WHOLE_VALUE_FIELDS`; adding one is a
  one-line change and must meet the same test: replaced whole, never edited in place.
- Readers always receive a plain string. `plainValue` converts at the document accessors
  (`readRecord`, and the projector's bulk-replace scope read). Text values written before this
  change stay readable as they are, so a document can hold both forms.

## Consequences

- A regenerate or a snapshot is a handful of ops, so history stops growing by the size of the
  schedule each time.
- History already written as Text is not rewritten, so an existing camp keeps its current load
  cost. Shrinking an existing camp would need compaction (a fresh history), which changes sync
  and was ruled out; pre-production camps are recreated instead.
- Concurrent writes of the same blob behave as before: last writer wins, the loser stays visible to
  `A.getConflicts`, and an identical value from both sides is not a conflict (Automerge returns an
  ImmutableString from `getConflicts` as a plain string).
