---
title: "A camp's column mapping is remembered and re-proposed"
document_type: ticket
status: open
created: 2026-09-29
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T281-remembered-axis-binding-per-camp.md, docs/work/tickets/T307-a-directors-column-correction-is-honoured.md, docs/work/tickets/T280-import-decision-journal-for-axis-bindings.md]
archive_when: "a director who maps a sheet's columns by hand and confirms, then imports a second sheet whose header carries those same column names, is shown that mapping ALREADY FILLED IN and told it was remembered, rather than mapping it again; a sheet missing any remembered header does NOT silently apply a narrowed binding but re-asks; a remembered binding is re-run through the same normalisation and readability gates as a fresh one on EVERY recall; the match key is provably derived from header text only and never from cell contents, asserted by a test that changes every cell and asserts the key is unchanged; changing a recalled mapping and confirming supersedes it; and the binding is a replicated entity with a DERIVED id so two devices confirming different readings produce a conflicts row rather than an arbitrary winner"
---

# T312 — A camp's column mapping is remembered and re-proposed

Slice of [T281](T281-remembered-axis-binding-per-camp.md) (umbrella **T278**), covering the **column-role**
half only. [T307](T307-a-directors-column-correction-is-honoured.md) made a director's correction
*honourable*; this makes it *durable*. T307's close records the gap in its own words: *"one import
obeys one correction; the next import of the same camp's next sheet asks again."*

## Why this is a slice and not T281

T281 is marked **BLOCKED — do not start** on two things. Both are now discharged for this slice:

1. **Owner rulings (ADR §9 Q3).** Taken 2026-09-29, before any schema version was picked, as T281
   requires:
   - **Persist?** Yes.
   - **Replicate?** **Yes** — a replicated entity, against the host-local precedent, per ADR §6.3's
     own recommendation. The mapping is a fact about the camp's *form*, not about a laptop.
   - **Id derived from what?** **`(camp_id, kind, match_key)`**. This is load-bearing rather than
     stylistic: conflict detection is keyed per `(entity, entity_id, field)`, so a per-confirmation
     `randomUUID` yields two records, **no conflict row, and an arbitrary winner**. Derived, two
     directors confirming different readings surface a `conflicts` row a human resolves.
   - **Scope of this slice:** column roles only. The day/period axis half stays in T281, because
     ADR §11.2 establishes axis binding as a *matching* problem against known entities and it likely
     wants a different mechanism.
2. **The design round (ADR §6.0)** — the profile record's field list, its key, and what constitutes a
   MATCH were unspecified. They are specified below.

**Sequencing (ADR §6.0):** *"the journal records axis-binding questions and their outcomes BEFORE any
profile is persisted."* `src/ingest/decisionJournal.js` and the `import_decisions` table already
exist, and `AssignmentPanel` already journals residue decisions. What is missing is the **mapping
confirmation itself** as a journalled question. This ticket adds that, which is T280's remaining
obligation for this one question kind — not all of T280.

## Design

### The record

Fills the reservation the schema already carries — `import_decisions.seedling_key` and
`.learned_from_id`, both commented *"unused (NULL) until slice 3"*, and `learned_from_id` names
`camp_seedlings` in a table that does not exist. A `kind` column is carried from the start so T281's
axis half lands in the same table rather than a second one.

```sql
CREATE TABLE IF NOT EXISTS camp_seedlings (
  id TEXT PRIMARY KEY,                    -- DERIVED from (camp_id, kind, match_key)
  camp_id TEXT NOT NULL REFERENCES camps(id),
  kind TEXT NOT NULL,                     -- 'preference_column_roles' in this slice
  match_key TEXT NOT NULL,                -- header text ONLY; never cell contents
  payload TEXT NOT NULL,                  -- compact JSON: roles keyed by HEADER TEXT
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'superseded'
  confirmed_by TEXT,                      -- plain TEXT user id, provenance only
  confirmed_at TEXT NOT NULL,
  superseded_by TEXT                      -- id of the row that replaced this one
);
```

Shape follows `source_aliases` deliberately, including `status`/`superseded_by` — that is this
repo's existing spelling of "a confirmed decision that can be replaced", and it supplies T281's
revocability without inventing a second idiom.

### The payload is keyed by HEADER TEXT, not column index

This is the whole mechanism. A binding that stored `nameIndex: 0` would break the moment anyone
inserts a column — which ADR §0 premise 4 explicitly promises to survive. Stored instead as:

```json
{ "name": "Camper", "externalId": null, "division": null,
  "ranks": [{ "rank": 1, "header": "Pick A" }, { "rank": 2, "header": "Pick B" }] }
```

On recall the headers are looked up **by text in the new file's located header row**, so inserted,
removed or reordered columns shift indices harmlessly.

### The match key, and the privacy constraint it must satisfy

ADR §6.0 rules *now*, as a privacy matter rather than a design preference, that the key be derived
from **header text, axis labels and geometry ONLY — never cell contents**: a fingerprint over cells
would cache children's names into a replicated table.

`headerMatchKey(headers)` — a pure function over the **set of headers carrying a role**, normalised
(trimmed, case-folded, whitespace-collapsed) and **sorted**, then hashed with the same multi-base
FNV-1a construction `submissionKeyFromRows` already uses, so no `node:crypto` is needed in the
renderer. It takes header strings and nothing else, which makes the privacy constraint a property of
the **signature**, not of the implementation's care.

Keying on the *roled* headers rather than the whole header row is what delivers premise 4: a file
that gains an unrelated `Notes` column still matches, because the columns the binding names are all
still there.

### MATCH, and DRIFT

- **MATCH** — every header named in the binding is present in the located header row of the new file.
- **DRIFT** — any named header is absent. The binding is **not applied, not narrowed**, and the
  director is asked. This is P38's lesson stated as a rule: renaming `#3` → `Third Choice` silently
  dropped rank 3 for 13 campers under `ok=true`, and a binding that quietly applies its surviving
  half reproduces exactly that.

A recalled binding is re-run through `mappingWithDirectorOverride` and `describeMappingReadiness` —
**the same normalisation and readability gates as a fresh correction**, per T281's archive_when. A
recall that does not come out readable is discarded rather than shown.

### It is RE-PROPOSED, never auto-applied

The recalled mapping arrives **pre-filled in `MappingCorrector`, with the director still pressing
Confirm**, and the screen says it was remembered.

This is the answer to ADR §6.1, the most serious failure this design can create — a confirmed-wrong
binding that re-applies pre-confirmed with no residue and no unlearn path. It cannot arise if the
binding never applies without a human looking at it. The saving is real regardless: six dropdowns and
two `+ Add Rank Column` presses become a glance and one press. The unlearn path is then free — the
director changes what they see, and confirming supersedes the old row.

## Non-goals

- **Not** the day/period axis binding. That stays T281, per the owner's scope ruling.
- **Not** auto-application, a confidence tier, or a strength function. ADR §6.0 notes a confidence
  tier with no strength function is a field, not an inference; re-proposal needs neither.
- **Not** all of T280. Only the mapping-confirmation question is journalled here.
- **Not** expiry on a coordinate-set change (T281 §13.6a). Column roles do not depend on the camp's
  coordinate set; that rule belongs to the axis half.
- **Not** a review surface listing every remembered binding. T281's archive_when wants one; it is
  not required for a binding that cannot apply unseen.
