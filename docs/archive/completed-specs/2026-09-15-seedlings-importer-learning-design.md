---
title: "Seedlings: the importer learns from what the director confirms"
document_type: spec
status: superseded
created: 2026-09-15
task_class: architecture
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
related_tickets: [docs/work/tickets/T157-camp-acquired-knowledge-pattern.md]
related_adrs: [docs/adr/2026-09-13-game-integration-boundary.md]
---

<!-- doc-refs:historical -->
> **Archived 2026-09-18 by the post-ship cleanup audit.**
>
> This document and the T173 ticket below it existed ONLY on two unmerged branches
> (`claude/T173-seedlings-importer-learning`, `claude/T173-seedlings-importer-learning-slice2`),
> which were deleted. Neither is current instruction. They are preserved here so the work is
> re-cuttable, because deleting the branches would otherwise have erased the ticket entirely.
>
> **Slice 1 SHIPPED** and is on `main` (PR #418) — `src/ingest/decisionJournal.js`,
> `electron/ops/decisionJournal.js`, and the `journalEntriesFor` wiring in
> `src/screens/ReconciliationScreen.jsx`. The branch copies were byte-identical to what merged.
>
> **Slices 2–4 were never built, and their premise is now known to be wrong.** The owner asked for
> a real import so they could be designed on journal evidence. Eight real camp workbooks were driven
> through the real ingest path and produced **zero journal rows** — see
> `docs/work/evidence/2026-09-15-real-import-journal-probe.md` (PR #434). The reconciler classified
> the entire corpus as already-understood, so the importer never asked anything. A learning layer on
> top of decisions that are never surfaced has nothing to learn from.
>
> **The redirected next slice** — what a future T173 should actually be cut as — is the gap that
> probe surfaced instead: a typo'd re-import (`Music` → `Musik`) silently creates a duplicate and
> asks nothing. The app already decides silently, and a wrong silent decision is indistinguishable
> from a right one. Design input is #434, not the spec below.
>
> Do not rebase the deleted branches if they are ever recovered: both independently minted schema
> migrations v62–v64 for device-side journal/failure tables, and `main` converged on a *different*
> consolidated shape (one `projection_failures` table, not three). Re-authoring against the shipped
> schema is the correct path, not conflict resolution.
<!-- /doc-refs:historical -->


# Seedlings: the importer learns from what the director confirms

**Owner ask, 2026-09-15:** *"the importer one — stop needing a human for obvious
cases through a learning process. call it a kernel, call it a nugget, call it a
seedling. there has to be a way to have the software learn from decisions and
imports and inputs from a user."*

## What "obvious" turned out to mean

Asked which questions the importer shouldn't need to ask, the owner picked three
of four — and notably **not** *"I already told you"*. The five existing
decision-memory mechanisms already handle exact repeats within a camp. The pain
is elsewhere:

| | Meaning | Needs learning? |
|---|---|---|
| **You could've worked it out** | The answer is already in the camp's own data | **No.** Look before asking. |
| **Spot the pattern** | Three similar cases confirmed; the fourth shouldn't be asked | **Yes.** |
| **Every camp does this** | Day abbreviations, time formats | **No.** The parser is under-taught. |

## The finding that shaped the design

**The signal to learn from does not exist yet.** `import_evidence` records why the
importer *proposed* something. The five decision tables record *positive
confirmations* of four narrow question types. Nothing records which questions
were asked, how often, what was chosen among options, what was left unanswered,
or — most commonly, and entirely invisibly — what was silently accepted.

Four narrow tables of yes-answers is a cache, not a training signal.

## Where it plugs in

There is no new screen. `src/ingest/reportToLanes.js`'s `laneFor(decision)`
already routes every decision to **express** (high confidence, shown but calm),
**standard** (needs a look) or **hold** (a human must answer). The owner's chosen
posture — *pre-answer, never unasked* — is that surface. What is missing is
knowledge feeding it.

```
import → extract → decisions
                      ↓
                   RECALL        seedlings annotate: answer + why + how well known
                      ↓
                reportToLanes    a known answer lands in express, pre-filled
                      ↓
               director reviews
                      ↓
                   JOURNAL       what was asked, what they did
                      ↓
                    SOW          confirmations become seedlings
```

### The constraint reading the code surfaced

Some decisions are `hold` **by authority, not by uncertainty**:

- `all_camp_override` — *"only they know whether that group had a trip that week"*
- `elective_candidate` — *"'never silent' is the whole point of the nudge"*

No amount of confirmation history may promote these. The app cannot learn
whether a bunk went on a trip.

**Invariant 1 — learning may only promote what is held for uncertainty, never
what is held for authority.** Enforced by the registry being a data structure
(below), not by conditionals scattered through recall.

### A consequence of "never silent"

Because nothing is ever applied unseen, the confirmation count stops being a
*permission* question and becomes a *display* one. A seedling may pre-fill from a
single confirmation; the count only changes how strongly the screen asserts it.
This removes the hardest tuning decision — "how many confirmations before it may
act" — from the design entirely.

## Data model

Two new tables, host-local, never replicated — the same class as the five they
sit beside (`docs/current/WHERE_DATA_LIVES.md`'s SQLite-only group).

### `import_decisions` — the journal

One row per decision **presented**, not per decision answered.

```
id, camp_id, import_id, kind, seedling_key,
lane        'express' | 'standard' | 'hold'    as presented
proposed    compact JSON — what the app suggested
outcome     'accepted' | 'changed' | 'rejected' | 'unanswered'
chosen      compact JSON — what the director ended with
learned_from_id, decided_at, actor_user_id
```

`outcome='accepted'` is the row that matters most: the director glancing at a
suggestion and moving on. It is the most common outcome in the app today and is
currently invisible.

### `camp_seedlings`

```
id, camp_id, kind, seedling_key,
answer                 compact JSON
times_confirmed        INTEGER  default 1
times_overridden       INTEGER  default 0
consecutive_overrides  INTEGER  default 0
first_confirmed_at, last_confirmed_at, last_applied_at,
state                  'active' | 'retired'
retired_reason
UNIQUE(camp_id, kind, seedling_key)
```

**`consecutive_overrides` earns its place.** A seedling the director keeps
correcting is worse than none — it is confidently wrong and taxes attention every
import.

**Invariant 2 — two consecutive overrides retire a seedling and the question
comes back.** Two corrections in a row does not mean the director is
inconsistent; it means the KEY IS TOO COARSE and the app is generalizing across
cases that are not the same. Returning to asking is the correct response to being
wrong twice.

### The generalized key

`seedlingKeyFor(kind, decision)` is a small explicit registry reusing keys the
code **already computes**:

- divisions → the stem `src/ingest/inferDivisions.js` extracts
- location words → the existing normalized `word_key`
- name merges → the existing normalization class

A kind with no meaningful generalization returns `null` and is never learned.
The registry is also where Invariant 1 lives: the authority-hold kinds are
excluded there, in data.

### Deliberately NOT touching the existing five

`source_aliases`, `compound_cell_decisions`, `location_word_decisions`,
`declined_two_row_splits` and `open_reconciliation_decisions` keep working
unchanged. Seedlings cover only kinds with no dedicated home; the journal records
that the existing five fired and whether the director overrode.

This avoids storing the same answer twice, and it keeps T157's finding intact:
the differences between those five are doing real work, and folding them in is a
decision to make later **on journal evidence** rather than on a guess today. T157
is closed by this spec — not because a sixth mechanism appeared, but because its
second trigger fired: a capability was wanted that requires the shared
abstraction.

## Behaviour

**Recall** (pure, total). Unknown kind, or no generalizable key → unchanged.
Otherwise: active seedling, else camp state, else still a question. The
annotation carries the answer **and its reason**. Any error computing a key is
treated as "not known" — **Invariant 3: recall can only fail toward asking.**

**Sow** (pure):

| what happened | effect |
|---|---|
| accepted the pre-filled answer | `times_confirmed++`, `consecutive_overrides = 0` |
| changed it | `times_overridden++`, `consecutive_overrides++`, answer updated |
| left unanswered | nothing — they did not decide |
| `consecutive_overrides` reaches 2 | retire; the question returns |

**How well it is known** is display only: one confirmation reads *"you told me
this once"*; several, *"you've told me this N times"*; a camp-state match, *"this
already exists in your camp"*.

## Failure behaviour

Learning is not data, and the failure modes say so.

- A journal write that fails **must not fail the import** — and must not vanish
  either. Contained, tagged with an incident id, recorded durably; the shape
  T148 established after the same defect class was found in the write path.
- A seedling that cannot be applied degrades to asking, never to a wrong answer.
- A retired seedling is never applied.
- An import that crashes mid-review simply teaches less. Nothing to repair.

## Testing

- `recall` and `sow` are pure — table-driven per kind, no SQLite, no IPC.
- **The load-bearing test:** no authority-hold kind can ever be promoted, written
  over the registry so that **adding a new decision kind fails the suite until
  someone classifies it**. Same shape as `migrationDomainState.test.js`, which
  caught a real omission the week it landed.
- Two consecutive overrides retire the seedling and the question returns.
- A journal write failure does not fail an import.
- Non-vacuity is demonstrated, not assumed: each guard test is shown failing
  against the unguarded code before it is committed.

## Slices

1. **Journal only — ships dark.** Records; changes nothing visible. This is what
   makes every later slice designable on evidence rather than guesswork.
2. **DEFERRED, pending journal data** — see below.
3. **DEFERRED, pending journal data.**
4. **DEFERRED, pending journal data.**
5. **Vocabulary thickening** — *"every camp does this."* Independent of the
   others and of the journal; may be done any time.

### Why 2–4 are deferred rather than scheduled (found 2026-09-15, while building)

Slice 2 was *"you could've worked it out"* — consult the camp's own data before
asking. **Its premise is mostly wrong, and checking took ten minutes.**

`reconciliationReport.js` already does this:

```js
const HIGH_IDENTITY_TIERS = new Set(['new', 'exact_name', 'uuid', 'confirmed_alias'])
...
if (confidence === CONFIDENCE.HIGH) return { outcome: 'understood', decision: null }
```

An exact name match produces **no decision at all**. Neither does a confirmed
alias, a uuid match, or a genuinely new item. The importer already looks before
it asks, and already stays silent when identity is certain. The questions that
survive to the director are the ones where the tier really is MEDIUM or LOW.

So whatever is left of *"you could've worked it out"* must be cases where the
tier is uncertain but the camp's data settles it anyway — and there is currently
**no evidence about what those are**. Building slice 2 on the assumption would be
precisely the guesswork this spec exists to avoid: the journal was proposed
because four tables of yes-answers is not a signal, and then designing the next
slice without the signal would repeat the error one level up.

The same argument applies to 3 and 4. The design of the seedling layer is
settled (the model, the invariants, the retirement rule); which KIND to teach
first is an evidence question, and the evidence arrives with slice 1.

**This is the sequencing the owner's "both, in one design" asked for — the whole
model designed at once, the build order decided by data.** What changed is only
that the first slice now has to land before the second can be specified, rather
than the two being planned together.

## Explicitly out of scope

- No model, no embeddings, no training. The app must be able to answer *"why did
  you think that?"* with a sentence — *"you told me this on 3 July, and twice
  since."* That sentence is the product.
- No cross-camp learning. Camps differ; T147's evidence is that *"slingshots is
  at the archery range, not the slingshot range."*
- No change to the scheduling engine, which stays deterministic and explainable.
