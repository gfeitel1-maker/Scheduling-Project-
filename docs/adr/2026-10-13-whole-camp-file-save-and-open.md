---
title: "Whole-camp file: Save whole camp, and Open a saved camp into a brand-new camp"
document_type: adr
authority: normative
status: accepted
implementation_state: phase-2-built
date: 2026-10-13
decided: "Direction ruled by the owner 2026-10-13 ('Second device + camp file (Recommended)'). Mechanism accepted 2026-10-13 by the board keeper under the owner's delegated authority, with the architect's recommendation on every open question (see Acceptance)"
deciders: [product-owner]
program: data-durability
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - SECURITY.md
supersedes: []
amends: []
related_adrs:
  - docs/adr/2026-10-12-shared-signed-device-roster.md
related_tickets:
  - docs/work/tickets/T381-save-whole-camp-and-open-a-saved-camp.md
affects:
  - electron/main.js
  - electron/preload.js
  - electron/ops/projections.js
  - electron/ops/campScopedEntities.js
  - electron/ops/operations.js
  - electron/ops/answerMemory.js
  - electron/auth/hostHandoff.js
  - src/hooks/useDeviceMode.js
  - src/App.jsx
  - scripts/finalAudit/steps.mjs
---

# ADR: Whole-camp file

## Acceptance (2026-10-13)

Board keeper, under the owner's delegated authority: "ADR accepted, under the owner's delegated authority, with your
recommendations on all four". Recorded answers:

1. **Campers and elective assignment runs are excluded.** The file is unencrypted, so no children's names go in it. The
   save dialog says plainly that camper lists and elective choices are not included and need re-importing.
2. **Extension `.shoresh-camp`.**
3. **Caps:** the values below are proposals; the final values are set from a measured fixture with headroom and recorded
   here.
4. **Never merged into a non-fresh camp in v1.**

## Problem (evidence)

A backup (`writeUserBackup`, `electron/db/projectManager.js`) copies the encrypted database and Automerge bytes, including device keys, and `validateBackupPair` (`electron/db/backupRestore.js`) refuses a different camp id. It restores onto the computer that made it and nowhere else. If a camp's only laptop dies, the director has no way to rebuild the camp elsewhere. No existing export round-trips a whole camp: the workbook export and `workbookToSource` -> `commitIngest` cover setup only (`INGESTIBLE_ENTITIES`, `electron/ops/ingest.js`), and `buildCampDataWorkbook` is read-only.

## Owner ruling

Build **Save whole camp** and **Open a saved camp** for v1. Contents: setup (divisions, groups, days, blocks, activities, locations, events, electives with sets and bundles), both schedules (Generated and Manual) with saved versions, special days and placements, learned answers. Excluded: device keys, roster, authority, PINs, sessions; a new camp makes its own. The file is unencrypted and the save dialog says "This file isn't protected — keep it somewhere private." Opening happens from the start screen card "Start from a saved camp file" and creates a brand-new camp (new identity, director sets the PIN). Button labels are fixed: "Save whole camp", "Open a saved camp", "Start from a saved camp file". Standing rules: fresh camps only (no migration of old files, no cross-version tolerance beyond a refusal), no new data model.

## Candidate approaches considered

Divergence was run in compressed form (the 8 GB machine rules out a ten-agent fan-out; the direction is already owner-ruled, so only the mechanism is open). Four genuinely different mechanisms:

1. **Projection-shaped JSON envelope, replayed through the real write paths (chosen).** Rows are exactly the fields `PROJECTIONS` already declares; opening replays them through `appendOp` / `appendBulkReplaceOp`. Assumption: the registry is the complete, current statement of what a replicated field is.
2. **Re-use the workbook (`exportWorkbook` / `commitIngest`) and widen it.** Rejected: it is a lossy, human-shaped import format (classification, matching, review questions); making it carry schedules, versions and learned answers means building a second data model inside the spreadsheet and still running the importer's interpretation on data that is already clean.
3. **Ship the Automerge document bytes (a re-keyed fork of the doc).** Rejected: the document embeds camp id, authority log, roster and device keys; a fresh identity would require stripping and re-signing history. It also makes the file a sync artifact whose compatibility is the CRDT library's, not ours.
4. **Second-device only, no file.** Rejected by the owner: it does not survive losing every device.

A fifth variant, a SQLite table dump (`.dump` / row copy), was folded into 3: it bypasses the document, so projection and document would disagree, which the architecture forbids ("a write goes to the document first").

Confidence in the chosen mechanism: **high (about 85 percent)** on shape and load path; **medium** on the derived-id rewrite (it is the part with the most entities and the most ways to be subtly wrong, hence the exact round-trip test below). Evidence: every primitive named below exists and is already exercised by ingest, bulk replace and host handoff.

## Decision

### 1. File format

One JSON file, extension `.shoresh-camp`:

```
{ format: 'shoresh-camp', version: 1, exportedAt, appVersion, schemaVersion,
  camp: { name },
  entities: { <entity>: [ row, ... ] },
  learned: { tables: { <table>: [ row, ... ] }, counts: { <table>: n } } }
```

- `entities` keys are the modeled entity names from `PROJECTIONS` (`electron/ops/projections.js`), in no particular order; the importer sorts by `DOMAIN_SNAPSHOT_ORDER` (`electron/ops/campScopedEntities.js`). Each row holds the entity's `key` plus its declared `fields`, and nothing else. No new data model: the registry is the schema.
- `learned.tables` reuses the `{tables, counts}` shape that host handoff already serializes and validates (`electron/auth/hostHandoff.js`) for the seven host-local tables (`source_aliases`, `compound_cell_decisions`, `location_word_decisions`, `declined_two_row_splits`, `import_decisions`, `import_evidence`, `open_reconciliation_decisions`). The replicated `camp_seedlings` rides in `entities`.
- `schema_snapshots` slots stay a JSON string, as stored.
- Plain JSON, not zip: setup data is small. **Size bound (final, measured 2026-10-13):** 64 MiB hard cap checked on the file's byte length (a `stat` before the file is read into memory, then again inside the validator) before any parse, plus per-entity row caps (**30,000** rows per entity, **50,000** rows total) checked as the structure is walked.

  Measured with CPU time (`process.cpuUsage`), not wall clock, on synthetic camps written through the validator and loaded through the real write paths into a fresh camp:

  | Camp | Rows | File bytes | Load CPU | Validate CPU |
  |---|---|---|---|---|
  | Audit-size: 40 groups, 60 activities, 10 blocks, 10 saved versions | 4,184 | 8.4 MB | 3.9 s (1,873 ops) | 0.24 s |
  | Largest the app can schedule: 99 groups (the 5,000-slot bulk-replace limit per schedule), 150 activities, 10 versions | 10,233 | 20.8 MB | 7.7 s (3,909 ops) | 0.52 s |
  | The same with 30 saved versions | 10,253 | 52.8 MB | 12.0 s | 0.92 s |

  "The audit camp times ten" is not reachable: `MAX_BULK_REPLACE_ROWS` (5,000 rows per template) already stops a camp near 100 groups, which is an existing system limit the file correctly inherits (`too_large`). The caps therefore rest on the largest camp the app can hold: file cap 64 MiB is 7.6x the audit camp and 3.1x the largest camp with 10 versions (it refuses a largest-size camp holding more than about 35 saved versions, with a plain "too big" message); row caps are about 12x the audit camp and 4.9x the largest camp, and a hostile file at the row cap costs on the order of 40 s of load CPU, not an hour. Saved versions are the size driver (each is a full copy of the slots).
- The save path writes the temp file then renames, so a crash never leaves a truncated `.shoresh-camp` that looks complete; the envelope carries per-entity `counts` and the reader verifies them (truncation check, not tamper protection: the file is unauthenticated by owner ruling).

### 2. Identity: new camp, derived ids re-derived, random ids kept

Opening mints a new camp id through the normal `bootstrapCamp` (`electron/main.js`): new signing key, new first admin, new authority genesis and roster entry. Nothing from the file touches identity or authority.

Ids come in two kinds (verified against the derive modules):

- **Random UUIDs, kept verbatim** (globally unique, so a fresh camp cannot collide, and keeping them preserves every soft reference with no rewriting): cohorts, groups, tiers, time blocks, activities, fixed events, events and event children, template slots, schedule snapshots, elective set activities and bundle children where minted by the UI.
- **Derived ids that embed the camp id, directly or through a parent derived id, and must be re-derived:** `deriveScheduleTemplateId` (`electron/ops/scheduleTemplateId.js`), `defaultWeekId` (`src/ingest/defaultWeek.js`), `deriveDayId` (`electron/ops/dayId.js`), `deriveLocationId` (`electron/ops/locationId.js`), and in `electron/ops/electiveDerivedIds.js`: `deriveElectiveSetId`, `deriveSpecialDayId`, `deriveSpecialDayActivityId`, `deriveSpecialDayTimeBlockId` / `Slot` / `deriveSpecialDayPlacementId` (chain through their parents), `deriveCampSeedlingId`, and the elective run-family ids.

Mechanism: the importer processes entities in `DOMAIN_SNAPSHOT_ORDER` and keeps one `oldId -> newId` map. For each row, if its id parses as a known derived form, it is re-derived from the new camp id and the (already remapped) parents; otherwise the id is kept. Every reference field is then rewritten through the same map in one pass. A string-replace of the old camp id is deliberately **not** used: several derivations hash or escape the camp id through `opaque()`, so substitution would produce ids no derive function would ever mint, and a later re-import would then create duplicates beside them.

Important consequence of derived ids: a fresh camp already owns some rows after bootstrap (the seven weekday rows from `seedDays`, possibly a default week and template pair). The importer resolves these by natural key (weekday number, week ordinal, template kind) and **adopts the existing row's id into the map** instead of inserting a second one, the same rule the derive modules' own comments state ("callers resolve an existing row by day_of_week, not by re-deriving").

Snapshots: `schedule_snapshots.slots` is JSON embedding group/day/block/activity ids. Because most of those are random UUIDs and kept, only the derived ones (day, location, special day, elective set) need rewriting; this uses `remapSnapshotSlots` (`src/utils/snapshotRemap.js`), which already resolves by name, driven from the same old-to-new map. A slot whose id resolves to nothing is dropped and counted in the post-load report, never silently kept dangling.

### 3. Load path: through the real write paths

New admin-gated IPC, `shoresh:load-camp-file`, available only while the camp is "freshly bootstrapped and empty" (no groups, activities, schedule slots; checked server-side, not by the renderer). The renderer flow, as built: start screen -> `shoresh:pick-camp-file` (native dialog, `stat` size check before the read, full validation, all in the main process; the parsed file is held there, single-use, and only a basename, the camp name and counts go back) -> camp name, admin name and PIN form (the normal bootstrap form, prefilled) -> existing `bootstrapCamp` -> login -> `shoresh:load-camp-file` (no file argument; it consumes the held pick) -> `refreshCamp`. **The file is picked and validated BEFORE the camp is bootstrapped**, so a bad file never leaves a half-made camp; the "Try another file" action exists only for failures before bootstrap, and a failure after it (the load itself) offers only "Start over". All validation happens in the main process; the renderer never holds the file or its path.

Order and primitives:

1. Parse and validate the whole file first (section 5). Nothing is written if validation fails.
2. Replay entities in `DOMAIN_SNAPSHOT_ORDER`. Field-shaped entities go through `appendOp` (`electron/ops/operations.js`) with `localWriteClient.write`'s unique-field collision check; bulk-replace-scoped entities (`BULK_REPLACE_ENTITIES`) go through `appendBulkReplaceOp` with the remapped scope id. Both mirror to the Automerge document, so document and SQLite agree by construction. Each row gets a deterministic `client_write_id` (`camp-load:<loadId>:<entity>:<id>:<field>`), so a retry of the same load is idempotent.
3. Learned answers: `camp_seedlings` is an ordinary entity; the seven host-local tables are written by a handoff-style replace with the new camp id substituted, reusing the handoff validator (which currently checks `r.camp_id === campId`; the loader passes the new camp id after rewriting, it does not relax the check).
4. Run the parity assertions the projector already has, then emit one `camp.loaded` audit event with per-entity counts.

**Atomicity.** The camp is fresh, so the failure policy can be blunt: run steps 2 and 3 inside a single SQLite transaction where the writers allow it (`appendBulkReplaceOp` already does its own, so the outer transaction nests via savepoints). The document mirror is the part a SQLite rollback cannot undo, so on any failure the loader does not try to compensate row by row. It **marks the camp "load incomplete"** (a device-local flag, set before step 2 and cleared after step 4) and the UI offers one action: "Start over", which switches to a brand-new empty profile file beside the current one (`shoresh:start-over-camp-file`, the same `reinitialize` that create-project uses) and returns to the start screen. It deletes nothing: the abandoned profile stays on disk, unreferenced. It is refused (`not_applicable`) for a camp that holds real setup data and has no incomplete-load marker. `shoresh:get-camp` reports `loadIncomplete`. A camp whose flag is set cannot be used for anything else, so a half-loaded camp never reaches a director as if it were whole. The renderer shows what failed in plain words (section 5 error shape).

**Op-log cost.** Every field is an op, so a large camp writes tens of thousands of operations; `docs/current` notes import write cost was previously fixed (T309) by batching. The loader uses the same batched-transaction path ingest uses, and the ticket must measure CPU time (not wall clock) on a ten-times audit camp before the cap values in section 1 are fixed. If the measured cost is unacceptable, the fallback is bulk-replace for more entities, not a bypass of the op log.

### 4. Scope

Included: everything the owner listed, plus `camp_maps`, `week_*_exclusions`, `events` and `event_*` (setup data), `schedule_weeks`, both `schedule_templates` with their `template_slots` and `schedule_snapshots`, `special_days` family and placements, elective sets, activities, bundles, periods and tiers, learned answers.

Excluded (never written to the file): `users`, `tombstones`, `camp_authority_log`, `device_roster`, `conflicts`, `camps.signing_secret` and `signing_public_key`, and every device-local table (`devices`, `host_signing_key`, `host_handoff*`, `device_identity*`, `operations`, `audit_events`, `authority_cache`, `roster_cache`, `applied_authority_log`, `punch_*`, `peer_*`, `last_import_undo`, `projection_failures`, `login_attempts`). A guard test enumerates the schema and fails on any table that is neither exported nor on this exclusion list, so a future table cannot be silently left out or silently leaked.

**Campers, camper identity keys and elective assignment runs are EXCLUDED in v1 (accepted; Acceptance 1).** They are children's names and personal data; the owner's list does not name them; and the file is unencrypted by ruling. The cost: a director who restores onto a new computer re-imports the camper list and re-runs elective assignment. The save dialog says so ("Camper lists and elective choices aren't included; import them again after opening."). The format could carry them later (the entities are in `PROJECTIONS`), but including them would put children's names in an unencrypted file and needs a new owner ruling.

### 5. Validation and hostile input

The file is a trust boundary (`org-interface-contracts`): it arrives from disk, possibly from someone else.

- Reject on: not valid JSON; `format !== 'shoresh-camp'`; `version` unsupported; `schemaVersion` newer than the running app (older is accepted only if the field list maps, see below); byte length over the cap; row counts over the caps; per-entity `counts` mismatch.
- **Allowlist from `PROJECTIONS`**: an entity not in the exported set (or on the exclusion list) is rejected; a row field not in that entity's declared `fields` or `key` is rejected, not ignored; value types are checked against the projection (string / integer / boolean / null / JSON-string for `slots`), including max lengths for text fields. A file with `users`, `camp_authority_log` or `device_roster` is rejected outright, so a hand-edited file cannot inject an admin or a device.
- **Ids are references and nothing else.** A `__proto__`/`constructor` key anywhere is rejected; ids must match a conservative character class and length; ids are never used as paths, SQL, or object keys without a `Map`. The importer parses with plain `JSON.parse` of an already size-checked string and never evaluates anything.
- **Closed reference set:** every reference field must point at an id present in the file (or be null where the field is nullable); a dangling reference rejects the whole file with the first offending entity/field named. Duplicate ids in one entity reject.
- Row mutations go only through the same `appendOp` paths a human edit uses, so `sanitize` rules, unique-field checks and `authorize()` apply unchanged; the IPC is gated by `authorize()` as an admin write.
- Error shape: `{ ok: false, reason: <code>, detail: { entity?, field?, count? } }`, with reasons from a fixed list (`not_a_camp_file`, `too_large`, `newer_version`, `unknown_entity`, `unknown_field`, `bad_type`, `dangling_reference`, `count_mismatch`, `camp_not_empty`, `load_incomplete`). The UI maps each to a sentence a director can act on. The file path is never echoed beyond its basename.

Save-side: the exporter reads through the registry only (an explicit allowlist, not "all columns"), so a new secret column can never ride out by accident; a test asserts no exported field name matches `secret|pin|token|key|salt|hash` and that `camps` contributes only `name`. Saving is admin-gated.

### 6. Equality test (round-trip)

Red-first, in this order: write the failing test for the round-trip, then the exporter, then the loader.

Export camp A (a fixture exercising every included entity, both schedules, saved versions, a special day with a placement, an elective set with bundles, learned answers). Open the file into a **fresh profile** (new userData). Then, for every table in the exported set (derived from the same list the guard test uses, not hand-picked):

- Row counts equal.
- Rows compared after **id normalization**: random UUIDs must be byte-equal; derived ids are compared by their derivation key (camp-id component replaced by a placeholder) and the old-to-new map must be total over them; reference fields are compared after mapping.
- `schedule_snapshots.slots` compared structurally after the same mapping.
- `users`, `device_roster`, `camp_authority_log`, `camps.signing_*` must be **different** (they are the identity that must not carry over): a negative assertion that none of A's keys or users appear in B.
- The Automerge document and SQLite must agree in B (the existing parity helper plus `tableRowCounts` over `MODELED_ORDER` from `electron/automerge/rebuildSupportCommand.js`; and a full `rebuildIntoFreshDb` from B's document equals B's SQLite).
- Stability: opening the same file twice yields two camps that are equal to each other after normalization (determinism), and re-saving B and diffing against the file for A yields an empty diff after normalization (idempotent save).

There is no existing every-table comparison helper; the ticket adds one (in test code, importing the production list rather than reimplementing it).

Hostile-input tests: one per rejection reason in section 5, plus a prototype-pollution file, a file at cap+1 byte, a file with a dangling reference, a file carrying a `users` entity, and a mid-load failure injected after N rows (asserts "load incomplete" flag and that Start over leaves a clean profile).

### 7. Final-audit step 20 outline (18 is the guide-screens step, 19 the removed-device step)

In `scripts/finalAudit/steps.mjs`, following step 15 (bootstrapping a camp on a peer) and `launchPeer()` (`scripts/finalAudit/driver.mjs`, fresh userData): build the audit camp through the real UI, click **Save whole camp**, record Generated and Manual placement counts, event count and the Locations list; launch a peer on a **new userData**, choose **Start from a saved camp file**, set a PIN, open the file; assert that Generate and Manual counts, events and Locations match, that both schedules open without a "load incomplete" state, that a regenerated schedule still places (derived ids resolve), and that no PIN or device from the first camp exists in the second. Evidence: screenshots of the dialog warning text, the start-screen card and both schedules, per `feedback_show_me_the_running_ui`.

## UI requirements (`DESIGN_STANDARD.md`)

Save and open are async with multi-second states. Per DESIGN_STANDARD section 5 (feedback) and section 8 (transitions): "Save whole camp" shows an in-place progress state and a confirmation naming the file and counts; "Open a saved camp" shows staged progress (reading, checking, loading, done) and a specific failure panel using the error reasons above, with "Try again" and "Start over". The reduced-motion equivalent keeps the same text states and replaces animated progress with a determinate text count; reduced motion is never no feedback. Failures surface in the UI (no silent write failures) and use flags, not banners. The start-screen card is a peer of the existing mode-select options, not a hidden menu item. No disabled "coming soon" controls.

## Interface-contract check (`org-interface-contracts`)

- **Idempotency / retries:** satisfied: deterministic `client_write_id` per row; re-running a failed load on the same fresh camp is safe; a second load into a non-empty camp is refused (`camp_not_empty`).
- **Concurrent retries:** a freshly bootstrapped camp has one device; the IPC takes a single-flight lock so two clicks cannot interleave.
- **Unknown outcome:** a crash mid-load leaves the "load incomplete" flag set; on next launch the app shows the Start over choice rather than a half-camp.
- **Error shape:** fixed `{ok:false, reason, detail}` above.
- **Authority boundary:** `authorize()` admin gate; no entity that carries authority or identity is accepted from the file; writes use the registry paths so `PROJECTIONS` registration is the single source.
- **Trust boundary validation:** section 5.

## Consequences

- One new file format and four IPC channels (`shoresh:save-camp-file`, `shoresh:pick-camp-file`, `shoresh:load-camp-file`, `shoresh:start-over-camp-file`); no schema change in v1 (the "load incomplete" flag lives in existing device-local settings storage; if none fits, the ticket adds one device-local row and runs `npm run schema:check`).
- The `PROJECTIONS` registry gains a second consumer. Adding a replicated field then changes the file automatically; the schema-enumeration guard makes adding a table without deciding "exported or excluded" a failing test.
- The file is unencrypted; the director can email it. That is the owner's accepted tradeoff, stated in the dialog.
- Docs: a new subsection after "Restoring from a backup" in the director's guide, owned by this work (title: "Moving your camp to a new computer"); a separate worker changes the Restore copy and the guide's backup paragraphs. `docs/current/WHERE_DATA_LIVES.md` gains a line that the camp file is an export of replicated and learned data and is not a sync or backup mechanism. `SECURITY.md` gets a short entry for the unprotected file.
- Backups remain the same-computer, encrypted, full-fidelity safety net; the camp file is the cross-computer, portable, identity-free one. The guide must say which to use when.

## Residual risks (stated)

- Derived-id coverage: a derived id kind missed by the rewrite survives with the old camp id embedded. The exact round-trip test plus the "total map" assertion are the defense; Red Hat should attack this first.
- Large camps: op-log write cost and the document size grow with the number of imported rows; mitigated by batching and a measured cap.
- Unauthenticated file: anyone can craft a valid-looking file; the allowlist and closed-reference checks contain what it can do to "put plausible setup data into a fresh camp", which the director then sees and can discard.
- Format drift: `schemaVersion` newer is refused; older schema versions are accepted only if every field in the file is still in the registry (otherwise `unknown_field`). There is no migration, per the fresh-camps rule.

## Open questions (owner / keeper)

1. **Campers and elective assignment runs: exclude in v1 (recommended) or include?** Excluding means re-import of the camper list and a re-run of elective assignment after moving to a new computer. Including means an unencrypted file with children's names (the dialog would need stronger wording). Recommendation: exclude; confidence medium-high.
2. **File extension and picker:** `.shoresh-camp` (recommended) vs `.json`. A distinct extension prevents opening an arbitrary JSON; cost is none beyond naming.
3. **Size and row caps:** 64 MiB / 1,000,000 rows are proposals; the ticket sets final values from a measured fixture.
4. **Should opening a file ever be allowed into a non-fresh camp (merge)?** Recommendation: no, ever, in v1. Merge is a different feature with conflict semantics.
5. **Guide subsection title and placement** after "Restoring from a backup": confirm with the worker changing the backup paragraphs that the two do not overlap.
6. **Review plan:** Security (no secrets leave; hostile file rejected; size bound) and Red Hat (derived-id rewrite, mid-load failure) are required before merge per the ruling; this ADR flips to `accepted` when questions 1-3 are answered.
