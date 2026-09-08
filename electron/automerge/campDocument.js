// Automerge generalization slice (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md):
// generalizes Stage 1/2's single-entity (`days_of_operation`) Automerge
// document layer to every entity in DIRECT_CAMP_ENTITIES — the simple,
// id-keyed, per-field camp-scoped entities (electron/ops/campScopedEntities.js).
// Deliberately excludes host-only tables (e.g. compound_cell_decisions),
// parent-scoped tables (e.g. week_activity_exclusions), and the one
// bulk-replace entity (template_slots) — those are out of scope for this
// slice and applyWrite/etc. throw rather than silently modeling them.
//
// The document shape mirrors the op-log's (entity, entity_id, field, value)
// semantics per entity, exactly as Stage 1 did for one entity, so the
// projector (projector.js) can replay each field through the EXISTING
// applyProjection — SQLite projected from this document is byte-identical to
// SQLite projected op-by-op today, structurally, not by re-proving parity for
// every input (regression-proven in projector.test.js).
//
// This module is PURE: no SQLite, no IPC, no Electron. Nothing imports it
// outside these automerge/* files yet.
import * as A from '@automerge/automerge'
import { coerceOpValue, DELETE_FIELD } from '../ops/operations.js'
// BULK_REPLACE_ENTITIES/validateBulkReplaceRows come from campScopedEntities.js, NOT operations.js
// (which re-exports them) — see that file's comment: importing them via operations.js here would be
// a circular module dependency (operations.js imports liveDoc.js, which imports this file).
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES, BULK_REPLACE_ENTITIES, validateBulkReplaceRows } from '../ops/campScopedEntities.js'
import { PROJECTIONS, sanitizeMutuallyExclusiveRow } from '../ops/projections.js'

// Back-compat: Stage 1 code and tests reference these two names for the
// original single-entity slice. STAGE1_FIELDS is derived from PROJECTIONS so
// it cannot silently drift from the op-log's field list.
export const STAGE1_ENTITY = 'days_of_operation'
export const STAGE1_FIELDS = PROJECTIONS[STAGE1_ENTITY].fields

// day_overrides.ensureExists (electron/ops/projections.js) reconstructs its
// four NOT-NULL FK columns from sibling fields, the same "reconstruct then
// insert once all are known" pattern as week_activity_exclusions/
// special_day_slots/etc. (projections.js's ensureWeekJoinRow and its
// hand-written equivalents). That pattern now accepts an optional `knownRow`
// — the full document row for this id, always fully known at once — which
// the projector (projector.js's upsertEntity) supplies, so it never needs to
// query the `operations` table at all. day_overrides is therefore no longer
// deferred; DEFERRED_ENTITIES is kept as an (empty) export so callers that
// reference it (campDocument.js/projector.js/seed.js's assertModeled guards)
// don't need a separate code path if a future entity needs deferring again.
export const DEFERRED_ENTITIES = new Set()

// Parent-scoped entities slice (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, Stage 5
// continuation): the document layer now ALSO models every PARENT_SCOPED_ENTITIES key
// (campScopedEntities.js) — the 10 join/child tables reached through a parent id (week_id,
// special_day_id, elective_set_id, event_id) use the EXACT SAME flat doc[entity][row_id] shape as
// the direct camp-scoped entities; the parent key is just an ordinary field in PROJECTIONS[entity].
// fields, so applyWrite/applyProjection/delete-reconcile all work unchanged.
//
// template_slots is the 11th key and is special: it is included here too (individual per-cell field
// edits use this SAME flat shape, exactly like ScheduleScreen's writeFields() already does today via
// the op-log), but it is ALSO registered in BULK_REPLACE_MODELED_ENTITIES below for the SEPARATE
// wholesale-regenerate primitive — mirroring operations.js's own two-primitive design for this one
// table (appendOp/applyProjection for a single cell vs. appendBulkReplaceOp/
// applyBulkReplaceProjection for "replace every row for this template"). See applyBulkReplace below.
// `camps` and `users` (Stage 6 prep, docs/work/plans/2026-09-07-stage6-cutover-plan.md): added
// EXPLICITLY here, not via DIRECT_CAMP_ENTITIES — they are deliberately NOT in that registry.
// DIRECT_CAMP_ENTITIES/DOMAIN_SNAPSHOT_ORDER (campScopedEntities.js) drive the legacy WS
// first-pairing full_sync snapshot and its DIRECT_CAMP_ENTITIES<->DOMAIN_SNAPSHOT_ORDER parity
// assertion; `camps` and `users` already have their own bespoke handling in that WS path
// (syncClient.js's isValidFullSyncCamp/INSERT OR REPLACE INTO camps/users) and are not camp_id-
// scoped "domain" entities in the sense that registry models (camps IS the camp; users is
// authentication/identity, not schedule data). Folding them into DIRECT_CAMP_ENTITIES would also
// pull them into assertDirectEntityParity's requirement of a DOMAIN_SNAPSHOT_ORDER position, which
// is the wrong lever for a security-sensitive, structurally-different pair of tables — see this
// file's PROJECTIONS.camps/users usage and the camps-singleton-convergence handling in projector.js
// (upsertEntity/deleteReconcileEntity) for why they need their own reasoning instead of inheriting
// the generic camp_id-scoped-entity treatment.
//
// Why model them at all: the op-log replicates `users` today (localAuth.js's createUser ->
// write({entity:'users',...})) and would replicate `camps.name` if any code ever wrote it (nothing
// does yet). Stage 6 retires the op-log/WS entirely, and this document layer is the only thing left
// that would carry that replication forward. Without this, a counselor added on one device could
// never log in on any other device post-cutover, and a camp rename (a feature this app doesn't have
// yet, but the singleton `camps` row itself already needs to sync its `name` field the same way any
// other camp-scoped record does) would never propagate. See hostOnlyExclusion.test.js for the
// fields that must NEVER follow (`camps.signing_secret`, `host_signing_key`, and every other
// genuinely host-only/device-local table) and this file's applyWrite/projector.js for why
// `camps` gets bespoke merge-safety treatment `users` does not need.
const EXTRA_MODELED_ENTITIES = ['camps', 'users']

export const MODELED_ENTITIES = new Set(
  [...DIRECT_CAMP_ENTITIES, ...Object.keys(PARENT_SCOPED_ENTITIES), ...EXTRA_MODELED_ENTITIES].filter(
    (entity) => !DEFERRED_ENTITIES.has(entity)
  )
)

// The one entity that ALSO has a wholesale-replace primitive, alongside its ordinary flat
// per-field shape above. Derived from operations.js's own registry (not a separately hand-
// maintained set) so this can never silently drift from what appendBulkReplaceOp actually allows.
export const BULK_REPLACE_MODELED_ENTITIES = new Set(Object.keys(BULK_REPLACE_ENTITIES))

// The doc collection name a bulk-replace entity's scope-level rows live under —
// `template_slots_scopes` for `template_slots`. A distinct top-level collection from the entity's
// own flat collection (`template_slots`), never the same key, so the two primitives can never
// collide on a single document field.
function bulkReplaceCollectionName(entity) {
  return `${entity}_scopes`
}

function assertModeled(entity) {
  if (DEFERRED_ENTITIES.has(entity)) {
    throw new Error(
      `campDocument: '${entity}' is deferred (see DEFERRED_ENTITIES) — its ensureExists reads the ` +
        `op-log, which the doc-replay path never writes; needs its own doc-native row-construction slice`
    )
  }
  if (!MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `campDocument: '${entity}' is not a modeled camp-scoped entity (see MODELED_ENTITIES) — ` +
        `host-only and bulk-replace-ONLY entities are out of scope for this document layer`
    )
  }
}

// SHARED GENESIS (docs/adr/2026-09-06-productionize-automerge-libp2p-sync.md, prior art:
// experiments/future-arch/cr-sqlite-libp2p/cr4-node.mjs). Every device's doc must start from ONE
// identical Automerge root: A.from() runs on each device independently, so two devices calling
// A.from(shape) each mint their OWN root map with its own actor-id-scoped op history — even with
// byte-identical `shape`, A.merge of two such roots keeps only one side's root map and silently
// drops the other's entire entity collection (see this file's header comment / the ADR for the
// confirmed regression). A.clone(A.load(bytes)) of the SAME saved bytes, by contrast, gives every
// device a document descending from the exact same root change, so root-level merges are conflict-
// free by construction.
//
// The bytes must therefore never be regenerated at runtime — GENESIS_B64 below is a FROZEN
// constant, computed once and pinned, the same way campIdHash.test.js pins a wire-compatibility
// vector. This guards against:
//   - Deriving genesis from `A.from(shape)` at every app startup would reintroduce the split this
//     fix exists to close — the SAME reasoning above, just moved from "two devices" to "two
//     versions/builds/machines of the app", which is the actual deployment shape (every install
//     independently boots this code). A build-time-deterministic derivation would still need
//     every future build to reproduce the identical bytes forever, which is a strictly harder
//     promise to keep than "never regenerate; ship the fixed constant" — Automerge's own encoding
//     is not a documented stable-forever function of its input, so nothing guarantees a future
//     Automerge version encodes the same shape to the same bytes. A hardcoded constant sidesteps
//     that entirely: it is what it is, forever, regardless of library internals.
//
// PARENT-SCOPED ENTITIES SLICE — GENESIS MUST CONTAIN EVERY MODELED COLLECTION, NOT JUST SOME OF
// THEM (CRITICAL FIX). An earlier revision of this file topped up createEmptyDoc() at RUNTIME with
// `d[entity] = {}` for any entity beyond the (smaller, Stage-1-era) GENESIS_ENTITIES list. That is
// the exact same bug class the shared-genesis mechanism above exists to close, reproduced one level
// down: when two devices EACH independently run `d[entity] = {}` for a collection the frozen root
// doesn't already contain, that is a CONCURRENT CREATE of the same map key from two different
// actors. Automerge does not merge the two maps' contents — it keeps ONE side's map deterministically
// and records the other as a conflict, visible only via `A.getConflicts`, which nothing in this
// codebase reads. Confirmed empirically: two devices, each `createEmptyDoc()`, each writing one
// `template_slots` row under DIFFERENT ids, merged to ONE row — the other device's row silently
// gone, structurally identical to the root-split bug this whole GENESIS mechanism exists to close.
//
// The fix: GENESIS_B64 now encodes EVERY collection this document layer models — every entry in
// GENESIS_ENTITIES below (all of MODELED_ENTITIES, flat AND parent-scoped) plus the bulk-replace
// scope collection(s) (BULK_REPLACE_MODELED_ENTITIES, mapped through bulkReplaceCollectionName) —
// so every device's very first document already has an identical, shared, non-empty-map-creating
// collection for each. No device ever creates a collection independently; there is nothing left to
// top up. createEmptyDoc() below is now just `genesisDoc()` — no runtime A.change at all.
//
// This intentionally, explicitly REGENERATES GENESIS_B64 and changes its root hash relative to the
// prior revision. That invalidates any already-persisted `.automerge` file from a build with the
// smaller genesis (its root no longer matches; a merge against a fresh doc from this build would
// split exactly as described above). This project is pre-production with no live users/camps on
// this sync engine yet (see the parent-scoped entities slice's own task brief), so that is
// accepted and deliberate, not an oversight — existing `.automerge` files may be discarded. A
// FUTURE regeneration of GENESIS_B64, once real camp documents exist, would NOT be free the same
// way; that is exactly why GENESIS_ENTITIES is a frozen, hand-maintained list going forward rather
// than something derived from MODELED_ENTITIES at build or run time (see the subset guard below).
//
// SECOND REGENERATION (doc-native ensureExists slice): day_overrides moved from DEFERRED_ENTITIES
// into MODELED_ENTITIES (its ensureExists is now doc-native — see projections.js's `knownRow`
// parameter), so it needed adding to GENESIS_ENTITIES and GENESIS_B64 needed regenerating again, for
// the exact same reason as the parent-scoped entities slice above. Same acceptance: still
// pre-production, no live camps, existing `.automerge` files may be discarded again.
//
// THIRD REGENERATION (users/camps modeling slice, Stage 6 prep): `camps` and `users` added to
// MODELED_ENTITIES above (see that comment for why), so both need adding here and GENESIS_B64
// needed regenerating again, same reasoning and same acceptance (pre-production, existing
// `.automerge` files may be discarded) as the two prior regenerations above.
//
// GENESIS_ENTITIES is a frozen snapshot of every collection GENESIS_B64 encodes, sorted for
// determinism: MODELED_ENTITIES (flat entities) plus BULK_REPLACE_MODELED_ENTITIES's scope
// collection name(s). It exists so the assertion below can catch, at import time, in every
// environment, the exact mistake that caused this bug: an entity added to MODELED_ENTITIES (or a
// new bulk-replace entity) without a matching addition to GENESIS_ENTITIES + a regenerated
// GENESIS_B64. Do NOT "fix" a failure of that assertion by editing GENESIS_ENTITIES alone — the
// bytes below must be regenerated to match, or the exact bug described above reappears for
// whatever entity was added.
const GENESIS_ENTITIES = [
  'activities',
  'anchor_activities',
  'camp_maps',
  'camps',
  'cohorts',
  'day_overrides',
  'days_of_operation',
  'elective_set_activities',
  'elective_sets',
  'event_groups',
  'event_slots',
  'event_time_blocks',
  'events',
  'groups',
  'locations',
  'schedule_snapshots',
  'schedule_templates',
  'schedule_weeks',
  'special_day_slots',
  'special_day_time_blocks',
  'special_days',
  'template_slots',
  'template_slots_scopes',
  'tiers',
  'time_blocks',
  'users',
  'week_activity_exclusions',
  'week_group_exclusions',
  'week_location_exclusions',
]

// Frozen base64 of A.save(A.from(shape)) for GENESIS_ENTITIES above, each mapped to `{}`. See
// campDocument.test.js's genesis-pinning test — if that test's expectation ever needs to change to
// pass, that is a wire/document-compatibility break being HIDDEN, not fixed; see that test's own
// comment.
const GENESIS_B64 =
  'hW9Kg+AQDgYAvgIBEM8F1/pFtxLq6DHX2sWnGskBJKXbpv69Pfj4/7nonMba9e+Gkhu7DOvuc/DWCfJjwmsGAQIDAhMCIwZAAlYCBx3RASECIwI0AUICVgKAAQJ/AH8Bfx1/lqP91AZ/AH8HVZBtT8MwDIQ/dWjsRSrSNP6dlaUHjZbWUc4t9N+jpiqEb/Zj+05n/+q8hTlYAFs3+l6z/JGjd0OSwSU2a8UXr71m46Vzi+iMnEMHtp1bKPohmpCdBR3viFhFIIRVepea84wZo8ln1inxtDWMamy32sIAeUT1Tx4K4WHbPUb1xYdv9D26KUI4usRerUKGIUVn4PUXfQFPtkzwwUVZUxTDe00q23PFed31tpvb/1boNYGNBWSeKo1mIjLfV+f9E4vg28eJa4JbGZRcFd3W95jV4AcdAB0BHR0AHQAdAAA='

function genesisDoc() {
  return A.clone(A.load(Uint8Array.from(Buffer.from(GENESIS_B64, 'base64'))))
}

// Subset guard (the fix Governor asked for): every collection this document layer can ever write to
// MUST already be a key in the frozen genesis. If this throws, it means an entity was added to
// MODELED_ENTITIES or BULK_REPLACE_MODELED_ENTITIES without also adding it to GENESIS_ENTITIES and
// regenerating GENESIS_B64 — the exact mistake described in the comment above, which otherwise
// silently reintroduces per-device data loss on merge for that specific collection (a concurrent
// `d[entity] = {}` from two devices, each keeping only one side). Runs at MODULE LOAD time (not
// lazily, not only in a test) so it fails loudly in every environment that imports this file, the
// same way campScopedEntities.js's assertDirectEntityParity does for its own drift class.
for (const entity of MODELED_ENTITIES) {
  if (!GENESIS_ENTITIES.includes(entity)) {
    throw new Error(
      `campDocument: '${entity}' is in MODELED_ENTITIES but missing from GENESIS_ENTITIES/GENESIS_B64 — ` +
        `two devices independently creating this collection at runtime would merge destructively ` +
        `(one device's rows silently discarded, visible only via A.getConflicts). Add '${entity}' to ` +
        `GENESIS_ENTITIES and regenerate GENESIS_B64 to include it before shipping.`
    )
  }
}
for (const entity of BULK_REPLACE_MODELED_ENTITIES) {
  const collectionName = bulkReplaceCollectionName(entity)
  if (!GENESIS_ENTITIES.includes(collectionName)) {
    throw new Error(
      `campDocument: '${collectionName}' (bulk-replace scope collection for '${entity}') is missing ` +
        `from GENESIS_ENTITIES/GENESIS_B64 — same destructive-merge hazard as the flat-entity case above.`
    )
  }
}

// A fresh camp document: just a clone of the one shared genesis root (see above). No runtime
// top-up — every collection this document layer can ever write to already exists in the frozen
// genesis (enforced by the subset guard above), so there is nothing left to create independently
// per device, and therefore nothing left that could split on merge.
export function createEmptyDoc() {
  return genesisDoc()
}

// Persist / restore the document (append-only binary — this is the thing that
// is authoritative and, in later stages, synced; SQLite is derived from it).
export function saveDoc(doc) {
  return A.save(doc)
}
export function loadDoc(bytes) {
  return A.load(bytes)
}

// Apply one op-shaped write, returning a NEW document (Automerge is immutable
// at this boundary). Semantics intentionally match applyProjection
// (electron/ops/projections.js):
//   - entity must be in DIRECT_CAMP_ENTITIES -> else throw (explicit scope)
//   - field === DELETE_FIELD -> remove the whole entity row
//   - a field not registered in PROJECTIONS[entity].fields -> silent no-op
//   - value is coerced with the op-log's coerceOpValue, so booleans/objects
//     land in the document exactly as they land in the operations table.
// ---------------------------------------------------------------------------
// THE RECORD ENCODING — one document key per FIELD, not per record.
//
// docs/adr/2026-09-08-flat-record-shape.md, chosen by the product owner over
// living with the limitation or recording resolutions.
//
//   doc.activities["x1\u0000name"]     = "Archery"
//   doc.activities["x1\u0000location"] = "Lakeside"
//
// WHY, in one sentence: a record that is a CONTAINER is a thing two devices can
// create at the same time, and every concurrency defect this program hit traced
// back to that. Two devices setting different fields of the same record now
// write different keys and simply do not collide — there is nothing to merge,
// nothing to lose, and nothing to reconcile. What remains is two devices
// setting the SAME field to different values, which is a scalar conflict: the
// case a human should decide, surfaced by reconcile.js and settled by an
// ordinary field write that dominates cleanly.
//
// The delimiter is U+0000, matching the composite keys docDiffEvents.js already
// builds. It is safe because the half that must parse unambiguously — the field
// name — always comes from PROJECTIONS and is a plain identifier. Split on the
// LAST delimiter, never the first: an entity id is arbitrary text (ingest
// derives ids from source data), a field name is not.
//
// NOTE FOR SEARCHING: a literal NUL in a key means `grep` can silently report
// zero matches in generated output. Use `grep -a`.
const FIELD_DELIM = '\u0000'

export function recordKey(entityId, field) {
  return `${entityId}${FIELD_DELIM}${field}`
}

export function splitRecordKey(key) {
  const at = key.lastIndexOf(FIELD_DELIM)
  if (at === -1) return null
  return { entityId: key.slice(0, at), field: key.slice(at + 1) }
}

// ---------------------------------------------------------------------------
// RECORD ACCESSORS — the only supported way to read a record out of a document.
//
// docs/adr/2026-09-08-flat-record-shape.md. These exist so that how a record is
// STORED can change without touching the dozen places that read one. Today they
// sit over the nested shape (`doc[entity][id] = { field: value }`); F2 swaps
// that for one key per field, and every caller below is already speaking
// through here.
//
// The rule for anything new: never index `doc[entity][id]` directly. Doing so
// re-couples a caller to the storage shape, which is precisely what made the
// concurrent-creation defects possible in the first place — a record that is a
// container is a thing two devices can create at once.
// ---------------------------------------------------------------------------

/** Every record id present in `doc[entity]`. Order is sorted, so two devices
 * iterate identically — projection order is observable through FK ordering. */
export function listRecordIds(doc, entity) {
  const ids = new Set()
  for (const key of Object.keys(doc[entity] ?? {})) {
    const parsed = splitRecordKey(key)
    if (parsed) ids.add(parsed.entityId)
  }
  return [...ids].sort()
}

/** One record as a plain `{ field: value }` object, or null if absent.
 *
 * Returns a PLAIN object, never a live Automerge proxy: callers pass it to
 * applyProjection as `knownRow`, and some entities' ensureExists reconstructs
 * sibling NOT-NULL FK columns from it. Handing out a proxy would make those
 * reads depend on the document staying alive across a merge that consumes it. */
export function readRecord(doc, entity, entityId) {
  const collection = doc[entity]
  if (!collection) return null
  const prefix = `${entityId}${FIELD_DELIM}`
  let found = false
  const out = {}
  for (const key of Object.keys(collection)) {
    if (!key.startsWith(prefix)) continue
    const parsed = splitRecordKey(key)
    if (!parsed || parsed.entityId !== entityId) continue
    out[parsed.field] = collection[key]
    found = true
  }
  return found ? out : null
}

/** True when this entity has any record at all — the seeded-vs-unseeded check. */
export function hasAnyRecord(doc, entity) {
  return Object.keys(doc[entity] ?? {}).length > 0
}

/** Every field key belonging to one record — needed by delete, and by anything
 * that must address the storage keys rather than the logical record. */
export function recordFieldKeys(doc, entity, entityId) {
  const prefix = `${entityId}${FIELD_DELIM}`
  return Object.keys(doc[entity] ?? {}).filter((k) => k.startsWith(prefix) && splitRecordKey(k)?.entityId === entityId)
}

export function applyWrite(doc, { entity, entity_id, field, value }) {
  assertModeled(entity)
  const fields = PROJECTIONS[entity].fields
  return A.change(doc, (d) => {
    // Lazy top-up (see genesis comment above): a document persisted before `entity` existed in
    // MODELED_ENTITIES (or a genesis-cloned doc whose frozen entity list predates it) has no
    // collection for it yet. Create it here rather than assuming createEmptyDoc() already did —
    // that keeps old on-disk docs working the moment an entity is un-deferred, without needing a
    // migration step.
    if (!d[entity]) d[entity] = {}
    const coll = d[entity]
    if (field === DELETE_FIELD) {
      // A delete removes every field key for this record. There is no container
      // to remove — that absence is the point of the shape.
      const prefix = `${entity_id}${FIELD_DELIM}`
      for (const key of Object.keys(coll)) {
        if (key.startsWith(prefix) && splitRecordKey(key)?.entityId === entity_id) delete coll[key]
      }
      return
    }
    if (!fields.includes(field)) return
    coll[recordKey(entity_id, field)] = coerceOpValue(value)
  })
}

// Apply one wholesale "replace every row for this scope" write — the doc-native counterpart of
// appendBulkReplaceOp (electron/ops/operations.js). Only template_slots is registered today
// (BULK_REPLACE_MODELED_ENTITIES, derived from operations.js's own BULK_REPLACE_ENTITIES).
//
// Deliberately stored as ONE plain string value (JSON.stringify(sanitizedRows)) under
// doc[`${entity}_scopes`][scope_id], not as a nested Automerge collection of per-row entries. This
// is the load-bearing choice for concurrent-regenerate safety: a plain map-key value is a single
// CRDT register, so two devices concurrently bulk-replacing the SAME scope collide as an ordinary
// per-key LWW conflict (Automerge's actor-order tie-break picks ONE deterministic winner; both
// competing full row-sets stay inspectable via A.getConflicts, exactly like the STAGE1 same-field
// conflict test in campDocument.test.js) — the LOSING generation's rows never reach SQLite. Had this
// instead been modeled as per-row entries in the entity's ordinary flat collection (each row a
// separate map key, keyed by its own fresh id), two concurrent regenerates would merge as a UNION of
// both devices' rows — worse than either single schedule, and the exact hazard this shape avoids.
// See parentScoped.test.js's "concurrent regenerate" describe block for the explicit proof.
//
// validateBulkReplaceRows/sanitizeMutuallyExclusiveRow are the SAME functions appendBulkReplaceOp
// uses (operations.js/projections.js) — reused, not reimplemented, so a doc-native bulk-replace is
// shape-validated and mutually-exclusive-field-sanitized identically to an op-log one.
export function applyBulkReplace(doc, { entity, scope_id, rows }) {
  if (!BULK_REPLACE_MODELED_ENTITIES.has(entity)) {
    throw new Error(
      `campDocument: '${entity}' is not a modeled bulk-replace entity (see BULK_REPLACE_MODELED_ENTITIES)`
    )
  }
  const validation = validateBulkReplaceRows(entity, rows, scope_id)
  if (!validation.valid) {
    throw new Error(`campDocument.applyBulkReplace: ${validation.error}`)
  }
  const sanitizedRows = rows.map((row) => sanitizeMutuallyExclusiveRow(entity, row))
  const collectionName = bulkReplaceCollectionName(entity)
  return A.change(doc, (d) => {
    // Lazy top-up, same reasoning as applyWrite's above — a document persisted before this
    // primitive existed has no scope collection yet.
    if (!d[collectionName]) d[collectionName] = {}
    d[collectionName][scope_id] = JSON.stringify(sanitizedRows)
  })
}
