---
title: "Concurrent creation of the same entity silently loses one device's fields"
document_type: evidence
status: active
created: 2026-09-08
task: docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md
archive_when: the defect is fixed or the owner accepts it with a recorded rationale
---

# Concurrent creation of the same entity silently loses one device's fields

**Found by:** the Stage 6a integration harness, once it started joining devices for real (scenario
08). **Not caused by the join flow** — the join flow is only what made two genuinely independent
devices write at the same time for the first time.

**Status: reported, not fixed.** Fixing it is a change to how the document models records, which is
an ADR-level decision affecting all 28 modeled entities and the frozen genesis. Constitution Article
II rules 4 and 8. A wrong reconciler here is worse than a known defect.

## What happens

Two devices concurrently create **the same entity id** and set **different fields** on it. On merge,
one side's fields are discarded entirely. Both devices then agree on the wrong answer, so nothing
looks broken anywhere.

This is not a race and not a network problem. It reproduces with no libp2p, no SQLite and no
timing — pure document operations against the shared genesis:

```js
const genesis = createEmptyDoc()
let a = A.clone(genesis), b = A.clone(genesis)
a = applyWrite(a, { entity: 'activities', entity_id: 'x1', field: 'name',     value: 'Archery'  })
b = applyWrite(b, { entity: 'activities', entity_id: 'x1', field: 'location', value: 'Lakeside' })
const merged = A.merge(A.clone(a), b)
```

```
A alone    : {"name":"Archery"}
B alone    : {"location":"Lakeside"}
MERGED     : {"location":"Lakeside"}          <-- "Archery" is gone
conflicts  : {"30@8e7c…":{"name":"Archery"},"30@ff5f…":{"location":"Lakeside"}}
```

The lost data is not destroyed — it sits in `A.getConflicts`, **which nothing in this codebase
reads**. That is the same sentence the Stage 5 handoff already had to write about the shared-genesis
regression, and it is the same failure mode one level down.

**Which side loses is arbitrary, and one side ALWAYS loses.** Over 200 merges of the snippet above:

```
name wins: 88    location wins: 112    both survive: 0
```

Measured independently by both sessions working on this (the other got 99 / 101 / 0). Two things
follow, and the second is the one that closes off any tradeoff:

- The winner follows the randomly generated actor ids, not write order. This is not "the later edit
  wins", which a director could at least learn the shape of — it is a coin toss, and both devices
  agree on the same wrong answer.
- **There is no lucky case.** Not one merge in 400 preserved both fields. So this cannot be
  characterised as a rare interleaving to be tolerated; concurrent creation of a record loses one
  side's work every single time.

## The comparison that decides what this means

The same two writes through the **op-log** path apply additively and lose nothing:

```
op-log  : {"id":"x1","name":"Archery","location":"Lakeside"}
CRDT    : {"location":"Lakeside"}   (or {"name":"Archery"} — see above)
```

Independently reproduced by the outgoing Stage 5/6 session, which ran the op-log half.

This is the whole point. It is not a CRDT quirk to be documented and lived with: **the cutover as
specified trades a correct behaviour for a lossy one.** That makes 6b (flip the default) and 6d
(remove the op-log) a *correctness regression* rather than a mechanism change, which is a materially
different decision and not one an agent should make.

## Why it was invisible until now

`applyWrite` creates the entity's container before setting a field. Two devices doing that
concurrently are two devices assigning a fresh object to the same key, and Automerge keeps one and
conflicts the other — taking the loser's fields with it.

The existing module-load subset guard in `campDocument.js` was built for exactly this hazard at the
**collection** level (`d[entity] = {}` from two devices, each keeping one side). It does not and
cannot cover the **record** level, where the key is a runtime id that can never be in a frozen
genesis.

Nothing caught it because no test ever had two independent devices create the same record at the
same time. Unit tests write from one device; every earlier integration test seeded the second
device's identity by hand and effectively serialised it. **The harness only started producing this
once a Client joined for real** — which is a fair argument for the harness port being worth doing
before anything is deleted, as the Stage 6 plan says.

**The generalisable lesson, and the reason ~5,000 green tests missed it:** *test scaffolding that
serialises two participants hides every concurrency defect in the thing under test.*
`seedCampIdentity` was load-bearing in a way nobody intended — it was written to work around a
missing join flow, and it silently removed the concurrency from every multi-device scenario. Worth
carrying past this bug: the next such shortcut will do the same thing.

## Why it matters for a camp

Two staff adding the same activity on two devices in the same minute is ordinary camp behaviour, not
an edge case. The result is one of them silently losing their work, with a schedule that looks
complete on both screens. Article V: *the engine surfaces conflicts; it never resolves them
silently.* This resolves one silently, in the worst direction.

It also blocks the cutover as specified: this is data loss that the op-log did **not** have (field-
level ops from two devices merged additively), so flipping the default (6b) and removing the op-log
(6d) would be a regression in correctness, not just in mechanism.

## Options, with the tradeoffs, for the owner's decision

1. **Post-merge conflict reconciliation.** After every merge, walk each entity map, read
   `A.getConflicts`, and union the fields of every conflicting version into the winner. Contained
   (~40 lines, one place in the merge path) and directly answers "nothing reads getConflicts."
   Changes convergence semantics, so it needs to be deterministic across devices and reasoned about
   carefully — two devices must reconcile to the *same* result.
2. **Flatten the record shape** so a field is its own top-level key (`activities/<id>/name`) and no
   per-record container is ever created. Removes the hazard by construction rather than repairing it
   afterwards. Touches the projector, the genesis, and every entity — the largest change, and the
   most permanent fix.
3. **Serialise record creation through the Host.** Smallest code change, but it reintroduces a
   central writer, which is the property the CRDT migration exists to remove. Not recommended.

Recommendation: **(1) now, with (2) considered on its own merits later** — (1) is bounded, testable
against the reproducer above, and unblocks 6b; (2) is the better end state but is a data-model
migration that should not be bundled with the cutover. Both this session and the outgoing Stage 5/6
session landed on (1) independently, for the same reason. That is a data point, not a decision — it
remains the owner's call.

**A requirement on whichever option is chosen.** The existing subset guard's value was never that it
read conflicts correctly; it was that it converted a silent-data-loss class into a *loud* failure at
module load. Any reconciler must ship with the equivalent — something that makes an unread conflict
impossible to ignore. A fix that merely handles `getConflicts` correctly today is a fix that gets
deleted in two years by someone who cannot see what it was for.

## Current state in the tree

- `test/integration/run.automerge.js` reports **2/3**, with scenario 08 failing. That is left honest
  and visible rather than quarantined; the runner is **not wired into `npm run verify`**, so the
  gate is unaffected and is not being falsely greened.
- Two genuinely separate bugs found alongside this one **are** fixed, in the join-flow slice:
  per-peer send ordering in `transport.js`, and `applyLocal` still using the whole-document push
  that Stage 5 had already documented as not reliably deliverable.
