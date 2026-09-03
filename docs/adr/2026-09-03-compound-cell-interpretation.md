---
title: "Ingest asks the director to interpret compound schedule cells, and remembers the answer per camp"
document_type: adr
authority: normative
status: accepted
date: 2026-09-03
supersedes: []
implementation_state: shipped
affects: [docs/work/tickets/T118-compound-cell-interpretation.md]
---

# Ingest asks the director to interpret compound schedule cells, and remembers the answer per camp

## Context

Pressure-testing ingestion against real camp files (docs/work/testing/ ingestion side;
`npm run ingest:sweep`) surfaced a class of cell the importer reads wrong, silently, with high
confidence. Real examples pulled from actual camp files during this investigation:

- `Lunch + Leave`, `Swim & Return`, `Lunch & Swim` (a camp's own schedule) — a real activity plus
  a short logistics wrapper (loading buses, changing) that the source schedule compressed into one
  cell because, per the owner: "it would not be worth anyone's time to create two 10-minute blocks
  around a 40-minute one."
- `Change/Snack`, `Change/Ga Ga`, `Change/SPLAT` (a different camp) — the same wrapper concept,
  different vocabulary (`Change`), confirming the wrapper WORD is camp-specific even though the
  underlying pattern (real activity + short transition) is universal.
- `Arts & Crafts`, `A/C` — NOT a compound pattern at all. One activity name that happens to contain
  a connector character. Any naive split-on-`&`/`/` rule wrecks these.
- `Climbing/Sports`, `Climbing/Outdoor Games` (a third camp's PDF) — a genuine third shape:
  co-equal alternatives in one shared slot ("either/or during a two-block period"), not a
  wrapper and not a fixed name.

### Root cause: the confidence model conflates "seen reliably" with "understood correctly"

`createConfidenceTier` (`src/ingest/buildPlan.js:69`) grants HIGH confidence — meaning silent,
unquestioned auto-accept — based on frequency alone: seen ≥2 times, or filling ≥1 unit-share of the
week. It has no signal for "this token has unresolved structure I never actually parsed." The
result, verified end-to-end against a real file (parsed → committed to a throwaway camp →
`buildSchedule` engine run):

- `Lunch + Leave`, seen 10 times, silently created as its own activity, HIGH confidence.
- `inferActivityRules` then fabricated a scheduling constraint from it: min 1 / max 3 times per
  week — a rule the director never stated, for a "thing" that isn't real.
- On a second, more damaged file (a PDF converted to text), the same failure mode compounded: a
  merged multi-line cell fragmented into 5 separate activities, one of which (`Swim`) was assigned
  a fabricated **min 6 / max 8 times per week** — physically impossible with one swim block a day.
  `buildSchedule` then reported **2,233 UNDERSERVED findings**, all downstream symptoms of the
  same import-time misread, none traceable back to the cause without re-deriving it by hand.

More sightings of an unparsed compound token currently *increase* confidence. That is backwards:
every additional sighting of `Lunch + Leave` is another occurrence the importer never actually
understood, not evidence that it did.

### Why this can't be solved with a universal word list or a generic split rule

A cross-camp probe (this investigation, not shipped code) tested both:

- **Splitting on connectors is not safe.** `Arts & Crafts` and `Ruach & Shabbat` are single
  activity names containing `&`. A syntactic splitter cannot distinguish these from `Lunch & Swim`
  without also asking a human.
- **The wrapper vocabulary is camp-specific, not universal.** Four camps in the sample used four
  different conventions for the same underlying concept (bus/transition wrappers) — `Leave`/
  `Return`/bare word (camp A), `Change` (camp B), inline timestamps (camp C, a PDF with the actual
  sub-block times written in the cell). A built-in word list would be wrong for most camps.
- **This is a local-first application.** There is no cross-camp aggregation, no shared backend, no
  telemetry pipeline — each camp's SQLite database is private to that device. A cross-camp
  frequency hint ("N other camps called this a wrapper") is not merely undesirable, it is
  architecturally impossible without building infrastructure this app deliberately does not have.
  This was considered and explicitly rejected.

One signal from the probe *did* generalize, and is the basis of the v1 detector below:
**a word that pairs with more than one distinct partner across compound cells in the same file is
a wrapper candidate; a word that always pairs with the exact same partner is evidence of a single
fixed name** (`Arts`↔`Crafts` never varies; `Change` pairs with `Snack`, `Ga Ga`, `SPLAT` — three
different real activities). This is cheap, pure counting, no guessing about meaning, and it
survived testing across every file in the sample without a false negative on the fixed-name case.
It does not, on its own, know which side of a wrapper pair is the transition word — a companion
signal (does the word ALSO appear as its own standalone block elsewhere in the file?) is needed to
pick the anchor.

### Precedent this reuses, not invents

Two existing seams solve structurally identical problems and are reused rather than duplicated:

1. **`electCanonicalSpellings`/`canonicalMap`** (`src/ingest/extractEntities.js:161`) — a *pure*
   function, no db access, that folds whitespace/case typo variants ("Lunch2" → "Lunch 2") and
   rides through `proposal.canonicalMap` into every caller of `activityNamesFromCell`
   (`extractEntities`, `inferFixedEvents`, `inferMultiBlockCandidates` — three call sites, the
   third caught by Red Hat review during that fix). Proves this codebase already has a working
   pattern for "compute a pure lookup from the raw file, thread it through extraction."
2. **`source_aliases` / `confirmAlias`** (`electron/ops/confirmAlias.js`, schema.sql:108) — a
   host-local, per-camp, admin-gated, NEVER-synced table that remembers "this observed string
   means that confirmed entity," written once by a director, read on every later import via
   `listAliasMap` (`electron/ops/ingest.js:247`). Proves this codebase already has a durable,
   camp-scoped, confirm-once-remember-forever primitive with the exact privacy properties this
   feature needs (never leaves the device, never crosses camps).
3. **The "Longer Blocks" chip pattern** (`src/screens/ImportScreen.jsx:1271-1341`,
   `docs/adr/2026-08-24-merged-cell-multiblock-ingest.md`) — the closest existing UI precedent:
   one card per distinct candidate (not per occurrence), an explicit two-choice decision, nothing
   pre-selected, an unresolved candidate ships nothing rather than a guessed default
   ("neither bucket is picked for the director").

## Decision

Ingest gets a new, narrow capability: **detect a compound cell pattern, ask the director once what
it means (per camp), and remember the answer.** Never auto-split, never auto-merge, never presume.

### 1. Detection — a new pure classifier (no db, no camp context)

`src/ingest/compoundCellPatterns.js` (new). Given the raw cell strings a parsed file already
produces, generate candidate compound patterns using connector characters (`&`, `+`, `/`, `w/`) as
a splitting heuristic for *candidate generation only* — never as a splitting action on real data.
For each candidate pair of parts:

- **Partner-diversity test.** A part that pairs with ≥2 distinct other parts across the file's
  compound cells is a wrapper/rotation candidate. A part that only ever pairs with the same single
  partner is evidence of one fixed name (`Arts & Crafts`) — do not generate a card for it.
- **Standalone-anchor test.** Among a flagged pair's parts, the one that ALSO appears as its own
  full, standalone cell elsewhere in the file is the likely real activity (the anchor); the one
  that never appears standalone is the likely wrapper/logistics word.
- Output: one candidate per distinct pattern (not per occurrence) — `{ pattern, occurrences, parts,
  anchorGuess, kind: 'unclassified' }`. This module answers "is this fixed, or does it vary" and
  "which side looks like the real activity" — it never answers "wrapper vs. rotation vs. as-written";
  that answer only ever comes from the director.

### 2. Persistence — a new per-camp learned-decision table, sibling to `source_aliases`

A new host-local table (schema TBD in the ticket — likely its own table rather than overloading
`source_aliases`'s shape, since the thing being remembered is "this pattern means X" rather than
"this string means that entity id"). Same guarantees as `source_aliases`: host-only, admin-gated,
`db.transaction()`, **never included in any sync payload, never replicated.** Written once per
confirmed pattern per camp; read on every later import so a confirmed pattern never asks again.

### 3. Extraction integration — read the camp's memory before extraction runs, not inside it

`extractEntities` stays pure — no db access is added to it, preserving its use in the CLI, the
sweep harness, tests, and both host/renderer contexts. Instead, the renderer loads the camp's
confirmed compound-pattern decisions via `localClient` at parse time — the same moment
`existingRecordsAll` is already fetched (`src/screens/ImportScreen.jsx:333`) — and passes them into
`extractEntities` as a plain lookup argument, exactly parallel to how `canonicalMap` already rides
through. A cell matching an already-confirmed pattern resolves silently and correctly; no card, no
question, no fabricated rule.

### 4. The director-facing surface

A new section on `ImportScreen`, "Cells We Weren't Sure About," inserted immediately after
"Longer Blocks" and before the Keep-vs-Replace section (`src/screens/ImportScreen.jsx:1341`) —
same visual family, same "nothing pre-selected, unresolved ships nothing" contract. One card per
undecided pattern, showing the literal cell text and real occurrence count, with an explicit
question and four choices: **one thing as written / a wrapper around [anchor] / these are
alternatives — either one / not sure, ask me later.** The fourth option is a real, permanent
escape hatch — no forced guess. Section renders nothing when no pattern is found (the common case).

Unlike "Longer Blocks" (whose decisions are ephemeral, re-asked every import), a resolved card here
does two things at commit: (a) folds into `buildCommitInputs` **upstream** of where `approved`
copies `proposal.entities` (`src/screens/ImportScreen.jsx:692`) — a "wrapper" verdict means the
wrapper string never ships as its own activity and no `activityRules` entry is fabricated for it;
an "alternatives" verdict means both parts become eligible in one shared slot rather than two
independently-required activities — and (b) writes the confirmed interpretation to the new
per-camp table so it is never asked again at that camp.

## Consequences

- The confidence model itself (`createConfidenceTier`) is **not** changed by this ADR. This adds a
  second, independent signal upstream of it (structural — "did I resolve this token at all") rather
  than trying to make frequency mean two things at once. Revisit `createConfidenceTier` directly
  only if a future case can't be handled as a detected pattern.
- v1 explicitly does not attempt the PDF-specific failure mode found during this investigation (a
  multi-line merged cell fragmenting into several separate grid rows during text-grid parsing,
  observed on a converted PDF). That is a distinct root cause — a text-grid parsing gap, not a
  compound-cell interpretation gap — and is out of scope here. Filed as a follow-up.
- PDF import is not supported at all today (`ImportScreen.jsx:970` accepts only
  `.xlsx,.xlsm,.xls,.txt,.csv,.tsv`). Not addressed by this ADR; a separate initiative if pursued.
- A learned decision is permanently camp-local. There is no cross-camp defaulting, hinting, or
  aggregation of any kind, by design (see Context) — this is a hard constraint, not a v1
  simplification to revisit later.
- The classifier can still misclassify the rotation/either-or case as a plain wrapper candidate if
  a file's compound cells happen to look identical in shape (multi-partner) to a real wrapper
  pattern — this is why the UI offers both interpretations as explicit choices rather than the
  classifier picking one; the human, not the heuristic, makes that call.
