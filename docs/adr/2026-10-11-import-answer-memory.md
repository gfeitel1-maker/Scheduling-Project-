---
title: "Every import answer is remembered by signature and reused on re-import"
document_type: adr
authority: normative
status: proposed
implementation_state: not-started
date: 2026-10-11
decided:
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
amends: []
implements: []
related_adrs:
  - docs/adr/2026-10-09-setup-device-gates-lifted-to-any-admin-device.md
  - docs/adr/2026-08-09-s1b-host-local-aliases.md
  - docs/adr/2026-08-28-persisted-reconciliation-decisions.md
  - docs/adr/2026-09-03-compound-cell-interpretation.md
  - docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md
  - docs/adr/2026-09-19-multi-device-erasure-propagation.md
---

# Every import answer is remembered by signature and reused on re-import

## Owner request (2026-10-11, verbatim)

> "this question spot - what something is classified as, or if someone meant to not add something for a group, is the place where our machine or software learning should be coming in so that on a reimport or a new import with similar circumstances it is more confident. beyond that make sure that this is applying to fixed events as well. and all types of activities, or events."

**Success predicate.** (1) Import campB (`docs/work/specs/samples/campB-by-day.txt`), answer N questions, re-import campB: zero repeat questions; every remembered answer is applied and labelled "Remembered from your answer on <date>". (2) A variant file (a renamed day or time, an extra group) with matching circumstances: remembered answers apply, only genuinely new patterns ask. (3) Changing an answer later updates the memory. (4) Works for every entity kind: activity, fixed event, recurring event, special event, elective.

**Non-goals.** No ML, embeddings or scoring model. No new question kinds beyond the one classification affordance below. No change to what the engine infers. No migration of the five existing memory tables.

## 1. Inventory (what remembers an answer today)

Every row cites code in this tree (`origin/main` at 0b3465ea+). "Reused" = a re-import skips or pre-fills the question.

| Question kind | Where asked | Remembered today? | Reused on re-import? | Gap |
|---|---|---|---|---|
| Identity conflict ("this label is that record", `resolve_conflict`, `choice:'existing'`) | `src/ingest/reconciliationReport.js:100`; card in `src/screens/ReconciliationScreen.jsx` | Yes: `source_aliases` via `confirmAlias` (`electron/ops/confirmAlias.js:56`), called from `identityRememberCalls` (`src/screens/reconciliationTriage.js:255`) and `confirmRemembers` (`ReconciliationScreen.jsx:262`). Has `confirmed_by`/`confirmed_at`, supersede chain. | Yes: `buildPlan` alias tier (`src/ingest/buildPlan.js:818-848`) | Only `choice:'existing'`. `create` and `skip` are not remembered. No "Remembered on <date>" label anywhere. |
| Compound cell ("Lunch + Leave", `compound_cell_decisions`) | `src/screens/ImportScreen.jsx:216,229` | Yes: `compound_cell_decisions`, `confirmCompoundCellPattern` (`electron/main.js:603`) | Yes: `listCompoundCellDecisions` read at parse time (`ImportScreen.jsx:548`) | Keyed on literal cell text only; no label, no undo. |
| Two-row split suggestion (`dualUseNames`) | `ImportScreen.jsx:246-250` | Only the DECLINE: `declined_two_row_splits` (`electron/ops/declinedSplits.js:22`, read at `ImportScreen.jsx:802`) | Declines yes; ACCEPTED splits (and their suffix) no | Name-only key; accepted split is staged in `splitDecisions` and forgotten. |
| Location "not a place" (`location_unresolved`, held conflict) | held-conflict card | Only `not_a_place`: `location_word_decisions` (`electron/ops/locationWordDecisions.js:27`) | Yes, consult-before-hold in `electron/ops/ingest.js` | `existing`/`create` location choices rely on aliases only. |
| Value confirmation, create (`confirm_value`, `looks_right` / `edited`) | `reconciliationReport.js:125,204,414` | No store. State-derived: the row exists after commit, so the next plan says `unchanged` (`reconciliationReport.js` classifyItem). | Indirectly (not asked again) | Fine for `looks_right`. An `edited` value rides the activity-rule side channel, and is not remembered as an answer. `heldBackDecisions` (`reconciliationTriage.js:~325`) only persists UNANSWERED ones. |
| Overwrite vs keep (`confirm_change`, `accept` / `keep`) | `reconciliationReport.js:173,510,537` | No. `keep` writes nothing. | **No: re-asked while the file still disagrees** | Largest silent repeat. |
| Fixed event low confidence / partial (`confirm_value` on `fixed_events`) | `reconciliationReport.js:551,584`, id `fixedEventDecisionId` (`:228`) | Partly: a director REJECTION is a human-sourced delete tombstone (`rejectedSlotKeys`, `electron/ops/ingest.js:1300`; `reconciliationReport.js` skips `rejected`). | Rejections yes; "looks right" is state-derived | No "this is an activity, not an event" answer; classification is inferred only (`src/ingest/fixedEvents.js:200-260`). |
| Fixed event moved / scope drift (`confirm_change`, ack only) | `reconciliationReport.js:495-540` | No (acknowledgement, nothing to write) | No: re-acknowledged | Needs a remembered ack keyed on from/to. |
| All camp except group X (`all_camp_override`) | `reconciliationReport.js:657`; detector `src/ingest/allCampOverrides.js` | No store. `all_camp` widens the rule in `foldTriageInputs` (`reconciliationTriage.js:~230`); `as_written` writes nothing. | **No: file still shows the exclusion, so it re-asks** | Exactly the owner's example. |
| Elective candidate (`elective_candidate`, `confirm` / `decline`) | `reconciliationReport.js:611` | Confirm creates a set (state-derived). Decline: "writes nothing" (`reconciliationTriage.js:~215`). | Confirm yes; **decline re-asked** | Decline memory. |
| Multi-block "Longer Blocks", name-variant merge | `ImportScreen.jsx:207-208,227-228` | No (session state `multiBlockDecisions`, `nameVariantDecisions`; unticked = not written) | No | Both. |
| Unknown label / packed cell (`resolve_unknown_label`, `resolve_packed_cell`) | `src/screens/elective/assignment/AssignmentPanel.jsx:245-246` | No (journal only; `decisionJournal.js:112-130` explicitly defers) | No | Deferred on purpose until the journal shows a pattern. |
| Special event (one-day file) | `ImportScreen.jsx:505-529` (`proposeSpecialDay`, `buildSpecialDayPlan`) | No question is asked; plan is shown. | n/a | Classification (special vs regular) has no answer to remember. |
| Column mapping (elective preference sheet) | `AssignmentPanel.jsx:600` | Yes, **synced**: `camp_seedlings` via `rememberColumnMapping` (`electron/ops/rememberColumnMapping.js:33`) | Yes (`recallColumnMapping`, `src/ingest/mappingSeedling.js:189`) | Out of scope; stays as is. |

**Two corrections to the brief.** (a) `open_reconciliation_decisions` (`electron/ops/openReconciliationDecisions.js:78`) is a list of UNRESOLVED questions, deleted-and-replaced per commit. It is not an answer memory and nothing should be built on it as one; it only supplies the *content-addressed id idea* (`decisionId` / `fixedEventDecisionId`, `reconciliationReport.js:60,228`). (b) `import_decisions` (`electron/ops/decisionJournal.js`, `src/ingest/decisionJournal.js`) records what was asked and answered, per import, but stores compact `proposed`/`chosen` JSON with **no decision id and no signature**, so it cannot be replayed. It does reserve `seedling_key` and `learned_from_id` (`electron/db/schema.sql:266-280`), both NULL "until slice 3". This ADR is that slice.

**The structural finding.** A positive answer to a "create" question leaves the entity in the database, so the next plan sees it as `unchanged` and never asks. Memory is therefore needed only where an answer leaves no trace in entity state: `keep`, `decline`, `as_written`, "not an event", acknowledged drift, and the file's re-presented pattern (all-camp exclusion). That narrows the work, and it argues against storing positives a second time.

## 2. Options

| | A. One device-local table keyed by signature (+ read adapter over the legacy five) | B. One new table per question kind | C. Synced: new `kind`s inside `camp_seedlings` | D. Derive from entity state only |
|---|---|---|---|---|
| Shape | `import_answer_memory`, one writer, one reader | ~6 tables, each with a writer module like `declinedSplits.js` | No schema change; rows replicate in the camp document | Compare file to rows; no store |
| Covers negatives (keep/decline/as_written/exclusion) | Yes | Yes | Yes | **No** (no trace in state) |
| Per-table fan-out | One migration, one rollback, one purge/handoff entry | Six of each: `localDb.js`, `schema.sql`, `vNN_down.js`, `purgeCollateral.js`, `hostHandoff.js`, `purgeSupportCommand.js`, parity tests | Zero schema, but touches nothing new | None |
| Second laptop | Re-asks once (device-local) | Same | Inherits answers | Inherits (state replicates) |
| Cross-device clash | None (local) | None | `deriveCampSeedlingId` makes two answers one row, so a disagreement becomes a `conflicts` row a human must resolve, for a mere preference | n/a |
| Authority | `groups.import`, same as the import it serves | Same | `camp_seedlings.write` is admin-only default-deny (`electron/main.js:775-786`) but import is staff-reachable, so staff answers would not persist | n/a |
| Against owner ruling 2026-10-09 | Consistent | Consistent | **Contradicts** "reconciliation, alias and split decisions stay device-local, with no replication" (`docs/adr/2026-10-09-setup-device-gates-lifted-to-any-admin-device.md`) | Consistent |
| Privacy | Names stay on the device | Same | Names replicate and are hard to erase (purge tombstones) | None |

**Recommendation: A.** Confidence after Red Hat revision: **medium (about 70%)**. High on the store shape, key/history mechanics and device-local placement (three precedents, one owner ruling, concrete fan-out cost of B, conflict cost of C, coverage hole in D). Medium on the baseline/near rules until measured against campB and a variant file, on the purge hook location (not yet located exactly), and on the one new UI affordance (classification), which belongs to Designer.

**Why not C, honestly.** The one real argument for C is that a camp with two import laptops re-answers once per laptop. That is a real cost, but it is small, bounded (one re-ask per signature per device), reversible, and exactly what the owner already accepted for aliases and splits. **Revisit trigger:** if the owner reports re-asking on a second laptop as a recurring annoyance, add `import_answer_memory` as a synced `kind` family under `camp_seedlings` with a derived id and a documented last-writer-wins carve-out; the signature and answer shapes below are designed to move unchanged.

**Divergence note (adhd).** Options A to D were generated in-context rather than as isolated parallel agents, because the machine is overloaded and the owner's brief already framed A to C. D (state-derived) is the one that changed the design: it showed positives need no store.

## 3. Decision: `import_answer_memory`, signature-keyed, device-local

### 3.1 Signature: key, baseline, and what is deliberately left out

`signatureOf(decision) -> { qkind, parts, baseline, refs }`, pure, in `src/ingest/answerMemory.js`. It builds no hash. The key is built in ONE server-side function (`electron/ops/answerMemory.js`), used by both the write handler and the matcher, so the two cannot compute it differently.

**Rule that governs everything below.** `parts` are the inputs the answer provably depends on; together they form the exact key. `baseline` is a snapshot of everything that *cannot be proven irrelevant* at answer time. On recall, **any baseline mismatch downgrades EXACT to NEAR** (preselected, still asks). Nothing is ever applied silently on a guess.

**Normalizers (named, one per job).** Names: `normalizeName` (`src/ingest/preview.js:14`: trim, lowercase, collapse whitespace runs). It is deliberately NOT `whitespaceInsensitiveName` (`preview.js:23`), which removes all whitespace and would make "Lunch 2" and "Lunch2" one key; `normalizeName` keeps them distinct and is what `confirmAlias.js:78` already uses, so alias lookups and memory agree. Days: `canonicalDay` (`src/ingest/extractEntities.js`). Blocks: `start-end` minutes (`src/ingest/blockTimeText.js`). Sets (groups, days): sorted, then JSON-encoded as an array (never a delimiter-joined string, so `["A,B"]` and `["A","B"]` cannot collide). **Long parts are hashed, never truncated:** any single part over 64 characters becomes `h:` + its full SHA-256 hex; the key stays bounded and two long parts that share a prefix still differ.

| qkind | Question kinds | `parts` (exact key) | `baseline` (mismatch -> NEAR) | Deliberately excluded, and why |
|---|---|---|---|---|
| `classify` | fixed-event `confirm_value`, weekly recurring, `elective_candidate`, "is this an activity" | name, proposed class (`daily_fixed` / `weekly_recurring` / `elective` / `activity`), day set, block minutes, group scope (`all` or sorted group ids) | location id (if any), the full set of groups present in the file for that cohort, the group count | file name, sheet name, import time, row order, cell formatting: none feed `fixedEvents.js` classification (`:200-260`), so none can change the right answer |
| `exclusion` | `all_camp_override` | name, sorted EXCLUDED group ids, day, block minutes | **the attending set** (group ids), `occurrences`, what each excluded group has instead (`insteadByGroup`) | `totalGroups` (derived from attending + excluded) |
| `value` | `confirm_value` `edited`; `confirm_change` accept/keep | entity, entity id, sorted field list, hash of the offered `to` value | **the stored value at answer time** (what was kept or overwritten) | the offered `from` (it is the stored value, already in baseline) |
| `drift_ack` | fixed-event moved / scope drift | name, from, to | the stored slot (days, block, scope) at answer time | none beyond file-level noise as above |
| `split` | two-row split, accepted (declines stay in `declined_two_row_splits`) | name | the two patterns' day sets and blocks | none |
| `merge` | name-variant merge, multi-block | sorted variant set | the canonical target entity id | none |
| `residue` | unknown label, packed cell | label text (hashed if long) | ids of the camp activities the label could map to | none |

**Consequence for predicate (2), stated plainly.** A renamed day spelling or a reformatted time stays exact (normalized away). **An extra attending group is NOT exact**: for `exclusion` the attending set is in the baseline, so the card is NEAR: the old answer is preselected and one tap confirms it. A new excluded group, a different weekday, a different offered value: also NEAR. This is a deliberate trade: a wrong silent auto-apply is worse than one extra tap. See Open question 4.

**Entity ids, validated on recall.** Each row stores `refs`: the resolved ids behind every name in `parts` (`{ groups: [...ids], activity: id, location: id, aliases: { label: aliasRowId } }`). On recall every ref must (a) still resolve to a live row of this camp, (b) whose `normalizeName(name)` still equals the signature's name, and (c) for an alias-resolved name, the active `source_aliases` row id must equal the stored one. A group deleted and re-created with the same name has a new id, so it fails (a)/(b); an alias re-pointed fails (c). Failure means NEAR. The matcher never auto-applies on a name alone.

### 3.2 Schema delta

Next schema version is **v95**. Evidence: `CURRENT_SCHEMA_VERSION = 94` (`electron/db/localDb.js:44`), `electron/db/rollback/v94_down.js` is the highest rollback, every worktree under `~/dev/shoresh/.claude/worktrees/*` reads 94, and `origin/main` reads 94. Re-check with the allocator and a fresh all-worktree scan at implementation time.

```sql
-- Host-local ... NEVER included in any full-sync payload, DIRECT_CAMP_ENTITIES or PROJECTIONS.
CREATE TABLE IF NOT EXISTS import_answer_memory (
  id            TEXT PRIMARY KEY,   -- fresh randomUUID() PER ANSWER (the confirmAlias.js:92 pattern), never derived from the key
  camp_id       TEXT NOT NULL REFERENCES camps(id),
  qkind         TEXT NOT NULL,      -- classify | exclusion | value | drift_ack | split | merge | residue
  key_hash      TEXT NOT NULL,      -- full SHA-256 of (camp_id, qkind, canonical parts); the lookup key
  name_key      TEXT NOT NULL,      -- normalizeName(name), for near lookup
  parts         TEXT NOT NULL,      -- JSON, long values hashed; display and audit
  baseline      TEXT NOT NULL,      -- JSON snapshot (3.1)
  refs          TEXT NOT NULL,      -- JSON resolved ids (3.1)
  camp_shape    TEXT NOT NULL,      -- hash of (group ids, day ids, block ids+minutes) at answer time (3.6)
  last_shown_shape TEXT,            -- the camp_shape at the last time this row's card was shown (3.6); NULL = never shown
  answer        TEXT NOT NULL,      -- JSON, same shape ReconciliationScreen's answers use
  answered_by   TEXT,               -- user id
  answered_by_name TEXT,            -- display-name snapshot, fallback when the user is gone
  answered_at   TEXT NOT NULL,
  import_id     TEXT,               -- import_decisions.import_id
  superseded_by TEXT,               -- id of the row that replaced this one
  forgotten_at  TEXT
);
-- the content hash is unique ONLY among live rows, so history rows may repeat it
CREATE UNIQUE INDEX IF NOT EXISTS idx_iam_active ON import_answer_memory (camp_id, qkind, key_hash)
  WHERE forgotten_at IS NULL AND superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_iam_near ON import_answer_memory (camp_id, qkind, name_key);
```

"Active" = `superseded_by IS NULL AND forgotten_at IS NULL`. There is no status column to drift from the index.

Migration block guarded `>= 94 && < 95` (not a bare `< 95`, the form the v82 block in `electron/db/localDb.js` documents), in BOTH `electron/db/localDb.js` and `electron/db/schema.sql`, plus its `schema_migrations` row. **Rollback required:** `electron/db/rollback/v95_down.js` drops the table and both indexes **and deletes the `schema_migrations` row** (`DELETE FROM schema_migrations WHERE version >= 95`, the `v94_down.js:33` form). Memory is not preserved across a downgrade; a test asserts this (4.8). `npm run schema:check` is the required pre-push step.

### 3.3 Every list that must change (host handoff decided)

**Decision: the table is NOT handed to a successor host.** It is per-person answer memory, not host state, and a successor re-asking once per signature is cheap. This differs from the five existing stores, which DO travel (`electron/auth/hostHandoff.js:23-31`), and the difference is intentional, so each list below is updated on purpose rather than by omission:

| File | Change |
|---|---|
| `electron/automerge/purgeCollateral.js` `PURGE_WIPED_TABLES` (`:23`) | ADD (wiped on purge) |
| `electron/auth/hostHandoff.js` `HANDOFF_TABLES` (`:23`) | NOT added |
| `electron/auth/hostHandoff.hostOnlyTables.guard.test.js` | the scan (`:19`) matches any table whose schema.sql comment starts "Host-only/Host-local", so `import_answer_memory` MUST go in `ALLOWED_EXCLUSIONS` (`:16`) with a reason, and in the "finds the tables" expected list (`:35`). The header comment is NOT reworded to dodge the scan. |
| `electron/auth/hostHandoffTestSupport.js`, `electron/auth/hostHandoff.test.js`, `electron/sync/automerge/hostHandoffWire.test.js` | each enumerates `source_aliases`; add an assertion that the handoff payload does NOT carry the new table |
| `electron/automerge/hostOnlyExclusion.test.js` | list it as a host-only table kept out of sync payloads |
| `electron/ops/undoReferences.schemaParity.test.js` | add per its rule (Maker reads the rule; it matches on `source_aliases`) |
| `electron/ops/operations.js:131,254` | add the generic-write deny: `import_answer_memory cannot be written through the generic op-log path` |
| `electron/automerge/purgeSupportCommand.js:38`, `electron/automerge/hostKeyPreservation.js:30`, `electron/main.js:532` (comments), `electron/main.test.js`, `electron/main.t351AdminDeviceLift.test.js` | update the enumerations |
| `electron/db/` | new `importAnswerMemory.migration.test.js` (model: `sourceAliases.migration.test.js`), `v95_down.test.js` |

I read the entries above that cite a line (`purgeCollateral`, `hostHandoff`, the guard test, `operations.js`); the test and comment files I located by grep for `source_aliases` and did not open, so Maker confirms each one's exact rule.

### 3.4 Read path

One site for the review queue: dry-run reconcile in `electron/ops/ingest.js`, which already reads host-local stores. After `buildReconciliationReport`, `matchImportAnswers(db, campId, decisions)` attaches:

```
decision.recalled = { match: 'exact'|'near', memoryId, answer, answeredAt, answeredBy, differsBy?: ['attending set'] }
```

- **Lookup:** by `key_hash` among active rows. EXACT only if baseline matches AND `refs` validate (3.1). Otherwise, same `name_key` + `qkind` among active rows gives NEAR. Else no `recalled`.
- **Exact** seeds `answers[id]` through the same code a click runs, so `isDecisionResolvedFor` and `applyResolutions` need no new branches. A recalled answer re-passes `isEditableDecision` / `isBackedConfirmChange` and the entity-live check; refusal means ask normally.
- **Near** preselects as a suggestion; it does not count as an answer and the card keeps its lane.
- **Preview-time kinds** (`split`, `merge`, `residue`) call one new IPC `matchImportAnswers({ signatures })` (gated `groups.import`, like `listCompoundCellDecisions`, `electron/main.js` ~l.790); matching stays server-side, so the key function exists once.
- **Replace mode:** recall runs for the kinds that do not depend on stored state (`classify`, `exclusion`, `split`, `merge`, `residue`); `value` and `drift_ack` do not arise in replace.
- Legacy five stores keep their own writers and readers; `recalledOf(legacy)` adapters give them the same label and Forget. Migrating them is not done here.

### 3.5 Write path

- **When:** `ReconciliationScreen.apply()` adds a sibling of `confirmRemembers` and `recordImportDecisions`: pure `answerMemoryCalls(decisions, answers)` -> `localClient.rememberImportAnswers({ calls })`, after a successful non-held commit, best-effort; failure surfaces via the existing "Couldn't remember" note and never fails the import.
- **What is written.** `looks_right` is **never written**, for any qkind: a confirmed create leaves its row, so the next plan says `unchanged` (the section 1 finding); storing it would create a second source of truth. Written: `edited`, `accept`/`keep`, `decline`, `all_camp`/`as_written`, `ack`, accepted splits, "Not an event" classification, merges, residue resolutions. Never an UNANSWERED decision.
- **Fresh answers** (no recall) are written by default. **Answers on a NEAR card are written only through an explicit "Remember this" action, default off.** Tapping through writes nothing, This is the only way a near suggestion graduates to exact. Two kinds of near behave differently: (a) a **`name_key` near** (same name, different key) has a different `key_hash`, so "Remember this" inserts a new live row and supersedes nothing; (b) a **baseline-mismatch near** has the SAME `key_hash` as a live row, so "Remember this" must SUPERSEDE that live row in the same transaction (retire old, insert new with the new baseline and `camp_shape`), leaving exactly one live row. Inserting without retiring would trip the partial unique index.
- **An exact-recalled answer left alone writes nothing.**
- **Replace mode:** answers given during a Replace import ARE written; they are the director's answers to that file.
- **Handler:** `rememberImportAnswersHandler`, `requireAuthorized(... 'groups.import')`; `camp_id` from `SELECT id FROM camps LIMIT 1`, never the caller; one `db.transaction`; key, baseline and refs recomputed/validated server-side against live rows; qkind and entity types from fixed allow-lists; parts length-capped (hashing handles long ones).
- **Change (the `confirmAlias.js:96-108` order):** compute `newId = randomUUID()`; `UPDATE old SET superseded_by = newId`; `INSERT` the new active row; all one transaction. The old row is retired BEFORE the insert, so the partial unique index never trips, and there is no self-loop because `newId` is always a fresh id. Re-confirming the same answer is a no-op returning the existing id.
- **Forget:** `forgotten_at = now`. The row stays for audit. A later answer to the same signature inserts a fresh row with no conflict.
- **Interface contract (`org-interface-contracts`):** idempotent (same-answer no-op); concurrent retry safe (one transaction + partial unique index); unknown outcome safe (a retry re-reads the active row first); error shape `{ ok:false, error }`; authority `groups.import`; outside `PROJECTIONS`/`authorize()` registry on purpose; the file is a trust boundary, hence allow-lists and server-side recomputation. Forgetting does not undo a committed import (that is the existing grace-window undo).

### 3.6 Provenance, visibility, staleness, erasure

- **Provenance.** Label: "Remembered from your answer on 12 Oct" when the current user answered; "Remembered from Dana's answer on 12 Oct" otherwise (name read from `users` by `answered_by`, falling back to `answered_by_name`; "a former user's" if neither). When another user's answer applies, the card says whose it is and still offers Change and Forget to anyone holding `groups.import`.
- **Visibility.** Exact recalls are never silent. (a) Every import shows a summary, "N answers remembered — review", linking to the Remembered group. (b) The Remembered group is collapsed by default, EXCEPT: on the first recall after the camp's groups, days or blocks changed since the row was answered (row `camp_shape` != current shape), those cards are expanded and say "Your camp changed since you answered". **Definition:** a recalled row expands when the current camp shape differs from `last_shown_shape` (NULL counts as `camp_shape`, the shape at answer time). After the review screen shows the card, the handler sets `last_shown_shape` to the current shape, so it expands once per camp change, not on every import.
- **Staleness.** Cosmetic change: normalized away. Structural change: baseline or key mismatch, so NEAR or no match. Entity deleted, re-created or alias re-pointed: ref validation fails, so NEAR. No time expiry; the date is on the label.
- **Erasure (T233, `docs/adr/2026-09-19-multi-device-erasure-propagation.md`).** Hashing does not erase: a hash of a short name is recoverable by dictionary. Decision: **rows are deleted, not hashed.** When a purge tombstone is applied (the projector's tombstone path, `electron/automerge/projector.js` ~`:331`, and any local purge), every `import_answer_memory` row of the camp whose `refs` contains the purged id, **or whose `refs.aliases` points at a `source_aliases` row whose `entity_id` is the purged id**, is hard-deleted, in ANY state (active, superseded, forgotten), including `parts`/`baseline` free text. **When a user is erased:** `answered_by` is nulled and `answered_by_name` is replaced with "a former user" on every row that user answered; the answers themselves stay (they are camp configuration, not the person's data). A full purge wipes the table (`PURGE_WIPED_TABLES`). Maker confirms the exact hook point; the requirement is the behavior, tested in 4.7. Hashing in 3.1 is for bounded keys only and carries no privacy claim.
- **Journal.** `journalEntriesFor` marks an exact-recalled decision `ACCEPTED` with `import_decisions.learned_from_id` = memory row id. No new outcome value.
- **UI standards (DESIGN_STANDARD §5, §8).** The label is static. Change, Forget and Remember this are async: immediate pressed state, inline pending, result shown on the card; the reduced-motion equivalent is a text/weight change on the same element (never no feedback). Cards moving into or expanding the Remembered group are view transitions under §8 with the same rule. No banners: use the existing flag/note channel. The "Not an event" classification control is the one new control and needs Designer first.

## 4. Test plan (red-first; fixture `docs/work/specs/samples/campB-by-day.txt`)

Pure tests follow `src/ingest/reviewQuestionCopy.campB.test.js`; DB tests use the in-memory template DB helper. Each is written failing first.

1. **Signature and collisions (pure).** Same decision twice: identical key. Equal after normalization: "Thurs"/"Thursday", "2:25-3:15 PM"/"02:25-03:15", "ARCHERY"/"archery", extra spaces. **Must NOT collide:** "Lunch 1"/"Lunch 2", "Lunch 2"/"Lunch2" (distinct by design under `normalizeName`), "Swim"/"Swim Return", "Alufim 1"/"Alufim1", "Arts & Crafts"/"Arts and Crafts" (`normalizeName` does not fold "&" and "and", by design: a spelling difference asks rather than guesses), groups `["A,B"]` vs `["A","B"]`, two 200-character parts sharing a 100-character prefix (hashed, not truncated).
2. **Predicate 1 (campB round trip).** Report on campB; assert which qkinds it produces (a supplemental fixture covers the rest; the test fails if neither supplies one). Answer all N through the real handler; rebuild on the same bytes. Assert: identical decision ids, every answered decision `recalled.match === 'exact'`, none unresolved, each with `answeredAt` and an author, `looks_right` answers absent from the table.
3. **Predicate 2 (variants).** Day renamed + time reformatted: exact. **Extra attending group: NEAR** (preselected, unresolved). New excluded group: NEAR. New activity pattern: asked, no recall. Count of asked cards = count of genuinely new or changed-baseline patterns.
4. **Predicate 3 (history).** A -> B -> A: three rows, distinct ids, no `superseded_by` self-reference, exactly one active, final recall is A. Forget then re-answer: old row `forgotten_at`, new active row, no unique violation. Same answer twice: one row. Near card tapped through: zero rows written; `name_key` near with "Remember this": one new live row, the old untouched; **baseline-near with "Remember this": the old row gets `superseded_by`, exactly one live row remains and it carries the new baseline**; the next import is exact.
5. **Predicate 4 (every kind) + guard.** One round trip per qkind and per decision kind in section 1. Exhaustiveness guard: every `kind` the report emits is mapped or on an explicit `NOT_REMEMBERED` list with a reason; plant an unknown kind and require failure.
6. **Stale ids.** Delete a group in an excluded set and re-create it with the same name: NEAR. Re-point the alias: NEAR. Trash an activity: no match. A recalled `edited` value the editable gate refuses: asked.
7. **Erasure.** Drive the real entry point, `upsertTombstonesEntity` in `electron/automerge/projector.js`, with a verified tombstone. Purge an entity id that appears in `refs`, and separately one reachable only through an alias row's `entity_id`: all rows containing it, in every state, are gone; a row with other ids is untouched. Erasing a user nulls `answered_by`, sets `answered_by_name` to "a former user", and keeps the answer. Full purge empties the table.
8. **Migration.** `v94 -> v95`; `v95_down` drops the table, indexes AND the `schema_migrations` row; a downgrade then re-upgrade yields an empty table (memory discarded). Guard-test, handoff-wire, exclusion, parity and purge-list tests all updated as in 3.3 and asserting the table is absent from the handoff payload.
9a. **Replace then add.** An answer written during a Replace import is recalled (EXACT, labelled) by a later additive import of a matching file.
9. **Trust and authority.** No `groups.import`: refused. Payload `camp_id` ignored. Oversized or malformed parts: `{ ok:false }`, no row. Replace-mode answer is written; replace-mode recall applies only to the state-independent kinds.
10. **Visibility.** Summary count correct; a camp-shape change expands exactly the affected cards; another user's answer shows their name.
11. **Visual.** One browser-mock frame with exact (labelled, in the Remembered group), near (preselected, asking) and a camp-changed expanded card.

### 4.1 Plant list for the Verifier (each must turn a test red)

1. A signature that **ignores the attending set** (extra attending group must flip to NEAR).
2. A key that **drops the baseline** (changed stored value must flip to NEAR).
3. A **supersede loop or self-loop** (`superseded_by = id`, or A -> B -> A reusing a row id).
4. A **stale entity id** accepted (group deleted and re-created with the same name still EXACT).
5. A normalizer that is case-sensitive, or one that uses `whitespaceInsensitiveName` ("Lunch 2" == "Lunch2").
6. A key part truncated instead of hashed.
7. `looks_right` written to the table.
8. Rollback that leaves the `schema_migrations` row.
9. Erasure that hashes instead of deleting, or that misses an alias-only reference.
10. "Remember this" on a baseline-near that inserts without retiring the live row.
11. `last_shown_shape` never updated (card expands on every import).

## 5. Consequences

- Repeat questions end for every kind in section 1 whose answer leaves no trace in entity state, under one deterministic, explainable rule, visible, attributed and reversible.
- One more device-local table to carry in the lists in 3.3 (paid once, not six times). It does not travel with hosting: a successor host, and a second laptop, re-answer once per signature. Revisit trigger for synced storage is in section 2.
- Near-by-default on any baseline change makes some repeats one-tap rather than zero-tap. Accepted: a wrong silent apply is the worse failure.
- Not decided here: moving the legacy five stores into the new table.

## 6. Open questions for the owner (product, not technical)

1. **Classification control.** Add "Not an event, treat as an activity" on the fixed-event card? Recommended: yes. Confidence: medium-high.
2. **Staff answers.** Staff with `groups.import` write and can Change/Forget memory too; labels show whose answer it is. Recommended: yes. Confidence: medium.
3. **Where Forget lives.** Card only for v1. Recommended. Confidence: medium.
4. **Extra group = one tap, not zero.** Predicate (2) as worded ("an extra group ... remembered answers apply") reads as zero taps. This design makes it one confirming tap, because the attending set is part of what the answer was about. Recommended: accept. Confidence: medium. The alternative (exact despite a changed attending set) is the failure Red Hat flagged.
