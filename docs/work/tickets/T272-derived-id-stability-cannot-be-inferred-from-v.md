---
title: "Derived-id stability cannot be inferred from the shared V constant"
document_type: ticket
status: open
created: 2026-09-26
task_class: database-sync
archive_when: "a reader can determine whether a derived id's shape has changed without reading git history — either V is split per id-kind, or a stale-id detector reports rows whose id does not match what the current code derives, or the owner has accepted the risk and a documented dev-database reset step exists"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-26-per-cell-elective-preferences.md]
---

# T272 — Derived-id stability cannot be inferred from the shared `V` constant

## The trap

`electron/ops/electiveDerivedIds.js` carries a module-level `const V = 1` shared by all five
id-deriving functions. Its header states that bumping `V` is *"a deliberate, visible re-keying of
every row of that kind — it is not a free change."* Any reasonable reader takes the contrapositive:
an **unbumped** `V` means the derivation did not change.

**On the T265 branch it changed twice while `V` stayed at 1.** Established from git history by Red
Hat, not inferred:

| commit | shape of `deriveElectivePreferenceId` |
|---|---|
| `main` | 3 components — `(run_id, camper_id, choice_id)` |
| `2988b432` | 4 components — `occurrence_id` added |
| `cc52695e` | 5 components, two arms — `'occ'` / `'all'` over a length-prefixed join |

So the assurance the header offers is one the code does not keep.

## Why it was not fixed in T265

`V` is shared across **occurrence, choice, offering, preference and assignment** id derivation.
Bumping it to fix one re-keys four unrelated entity kinds. That tradeoff is real, and declining it
inside a correctness ticket was the right call — recorded here so the decision is visible rather than
looking like an oversight.

## Why "no live camp data" does not cover this

The standing pre-production condition is true of production and **false of three real consumers**:

- a developer's own `~/Library/Application Support/shoresh-dev` database that already ran an elective
  commit before T265;
- an already-paired second device holding a synced Automerge document carrying round-1- or
  round-2-shaped ids;
- any committed fixture asserting a literal id string.

**The consequence is silent duplication, not a loud failure.** `elective_preferences` has no `UNIQUE`
constraint — by stated convention, the derived `id` PRIMARY KEY *is* the uniqueness invariant. So a
re-derivation that no longer matches an existing row inserts a **second row** rather than overwriting
the first. Nothing reports it.

This is the same shape as [[feedback_measure_the_repo_not_the_checkout]]: a condition that reads as
covering everything, checked against only one environment.

## What this ticket decides — deliberately no recommendation

This is a judgement about developer workflow, not about correctness, so it wants the owner or a
designer rather than a default:

1. **Split `V` per id-kind**, so one derivation can be re-keyed without dragging four others.
2. **Add a stale-id detector** that reports any row whose stored id does not match what the current
   code derives from its own fields.
3. **Accept it**, with a documented "clear your dev database after pulling this" step.

## Not in scope

**The two-arm encoding itself is correct and must not be changed here.** Security verified `join()`'s
length-prefixing is genuinely injective, including against an `occurrence_id` literally spelling
`'all'` or `'occ'`. Only the *versioning story* around it is misleading.

## Not urgent — the trap is already disarmed

T265 round 4 amended the module header to state plainly that a reader must check git history rather
than infer stability from `V`. This ticket removes the trap; it does not fix a live defect.
