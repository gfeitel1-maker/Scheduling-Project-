// Partial-snapshot detection (T320, docs/adr/2026-09-30-elective-run-
// durability.md item 1).
//
// WHY A DIGEST, NOT JUST A ROW COUNT. This codebase's projection layer
// stub-seeds a row on first-field-arrival (`INSERT OR IGNORE ...`,
// electron/ops/projections.js's elective_run_outer_snapshots entry) — a row
// can exist with only its four identity columns populated while
// activity_name/location_name/etc. are still NULL, because appendOp writes
// ONE OP PER FIELD, not one op per row, and per-field ops can arrive out of
// order across a sync. A row-count comparison sees that stub-seeded row as
// "present" and reports the snapshot complete when it is not.
import { createHash } from 'node:crypto'

// Field order is the contract — the SAME array (order-independent, since rows
// are sorted by id first) must be used by both the "expected" computation
// (finalize time, in-memory rows) and the "held" computation (read time,
// SELECT from elective_run_outer_snapshots) or the digest is meaningless.
// solver_generation is DELIBERATELY EXCLUDED: a generation mismatch is
// FINALIZED_AGAINST_STALE_GENERATION's own, separate concern
// (finalizedAgainstStaleGeneration.js) — folding it into this digest would
// make an ordinary, already-detected staleness ALSO register as
// "incomplete," conflating two different findings with two different
// remedies (revise the run vs. wait for sync to finish).
const DIGEST_FIELDS = [
  'id', 'camper_id', 'day_id', 'time_block_id', 'activity_id', 'activity_name',
  'location_id', 'location_name', 'span_blocks', 'cell_kind', 'choice_id',
  'is_linked_choice', 'choice_label',
]

// T320 round 2, F1 — the BOOLEAN/INTEGER BOUNDARY. `is_linked_choice` is the
// one DIGEST_FIELDS entry whose two producers disagree on TYPE, not just
// value: electiveRunOuterSchedule.js's derive side writes a JS boolean
// (`!!row.is_linked_choice`, or a literal `false`), while the held side
// re-reads the column from SQLite, where better-sqlite3 returns the
// NOT-NULL-DEFAULT-0 INTEGER column as a JS number (0/1). Without this,
// `is_linked_choice=false` and `is_linked_choice=0` are different STRINGS to
// createHash, so the digest computed at finalize time (over in-memory rows)
// can never equal the digest computed by any later read (over a fresh
// SELECT) — every finalized run reports snapshotIncomplete forever. Every
// other DIGEST_FIELDS entry was audited against both producers
// (electiveRunOuterSchedule.js's `rows.push`/inherited branches vs this
// module's own held SELECT) and found to agree in both type and null-vs-
// undefined handling — id/camper_id/day_id/time_block_id/activity_id are
// always-set strings on both sides; activity_name/location_id/location_name/
// choice_id/choice_label are consistently JS `null` (never `undefined`) on
// both the derive side's `?? null` and a SQLite NULL column read back by
// better-sqlite3; span_blocks and cell_kind agree in type (INTEGER/TEXT) on
// both sides. `is_linked_choice` is the only divergence, so this is the only
// field-specific normalization needed — but it lives in ONE place (here) so
// neither call site (computeExpectedSnapshotDigest,
// computeHeldSnapshotDigest) has to remember to coerce it.
function normalizedFieldValue(field, value) {
  if (field === 'is_linked_choice') return value ? 1 : 0
  return value ?? '\0NULL'
}

// T320 round 2, Red Hat HIGH — the prior serialization joined a row's fields
// with unescaped `|`/`=` and "separated" rows with `hash.update('')`, which
// writes nothing: a free-text field value (location_name, choice_label, even
// `id`) containing the literal substring `id=` could be indistinguishable
// from the mandatory `id=` prefix of the NEXT row, so two structurally
// different row sets could serialize to the identical byte string and hash
// equal (see electiveRunSnapshotCompleteness.test.js's "digestOf row/field
// separation" case for a worked collision). JSON.stringify of a fixed-order
// array is unambiguous — array/string boundaries are escaped, not
// concatenated raw — and `'\n'` is a real, non-empty row separator. Any run
// finalized on this branch's earlier code is test-only (nothing has shipped
// with the old digest), so no migration of previously-stored digests is
// needed.
function digestOf(rows) {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = createHash('sha256')
  for (const row of sorted) {
    hash.update(JSON.stringify(DIGEST_FIELDS.map((f) => normalizedFieldValue(f, row[f]))))
    hash.update('\n')
  }
  return hash.digest('hex')
}

// Called by finalizeElectiveRun.js with the SAME `snapshots` array it already
// builds, BEFORE writing — this is the single source of truth for "what the
// export should contain." LEGACY whole-set digest: a run finalized before
// erasure-aware comparison existed stores this shape (a bare 64-hex-char
// sha256), and computeSnapshotCompleteness keeps comparing it the OLD way
// forever (see LEGACY_DIGEST_RE below) — no re-finalize path exists to
// upgrade an old run's stored digest, so this function and its format must
// stay exactly as they are.
export function computeExpectedSnapshotDigest(rows) {
  return digestOf(rows)
}

function selectHeldRows(db, runId) {
  return db.prepare(
    `SELECT id, camper_id, day_id, time_block_id, activity_id, activity_name,
            location_id, location_name, span_blocks, cell_kind, choice_id,
            is_linked_choice, choice_label
       FROM elective_run_outer_snapshots WHERE run_id = ? ORDER BY id`
  ).all(runId)
}

// Called by getElectiveRun.js / getElectiveRunOuterSchedule.js with the
// CURRENTLY-HELD rows for this run. Only used for the LEGACY whole-set
// comparison now (see computeSnapshotCompleteness) — the erasure-aware path
// below digests one camper's rows at a time instead.
export function computeHeldSnapshotDigest(db, runId) {
  return digestOf(selectHeldRows(db, runId))
}

// T320 board follow-up (erasure-aware completeness) — `snapshot_digest` for a NEWLY finalized run
// is now a per-camper map: { [camperId]: { rows: <count>, digest: <sha256 over just that camper's
// rows> } }, JSON-serialized. This lets the read side exclude a since-erased camper from the
// comparison by dropping their entry, rather than comparing against one whole-set hash that an
// erasure can never match again. Built from the SAME in-memory `rows` finalizeElectiveRun.js
// already derived — never a second read of elective_run_outer_snapshots.
//
// Amendment (2026-10-01, docs/adr/2026-09-30-elective-run-durability.md): the map's KEYS used to
// be the raw camper_id. `snapshot_digest` is a replicated TEXT field on `elective_assignment_runs`
// — a row this codebase correctly never tombstone-gates (it is the run, not camper data) — so a
// purged camper's raw id survived in cleartext, fleet-wide, forever. Each key is now
// sha256(run_id + ':' + camper_id), hex: run-scoped so the same camper's hash cannot be
// correlated across two different runs, and unkeyed (no HMAC/secret).
//
// WHAT THIS DOES NOT BUY, stated plainly so nobody mistakes it for more. Every device has to
// recompute this key from a camper_id it already holds — that is the whole point, since the read
// side looks up held rows and subtracts tombstoned campers by key — so any derivation a device can
// perform, a camp peer can perform too. An HMAC would not change that: its key would have to be
// replicated to be recomputable, which makes it equally readable (and no fleet secret survives a
// genesis rebuild here anyway). So a CONFIRMATION ORACLE is inherent to the shape, not a weakness
// of sha256: someone holding a candidate camper_id can hash it and test for membership.
//
// That matters more than it first looks, because camper ids are NOT uniformly high-entropy. On the
// elective-sheet import path `deriveCamperId` (electiveDerivedIds.js) returns a length-prefixed
// concatenation — its own comment says "NOT a hash" — whose `name` mode embeds the canonicalized
// DISPLAY NAME, and commitElectiveRun.js writes that string as `campers.id`. A peer who guesses a
// purged camper's name can therefore rederive the id, hash it, and confirm that camper was in this
// run. Do not "fix" that by reaching for an HMAC; the oracle is structural. What this change buys
// is real but bounded: a purged camper's id (and, on the import path, their NAME) no longer sits in
// cleartext in a replicated field readable by anyone — recovery now requires already guessing the
// name. Note also that the erased camper's KEY is never scrubbed from a stored map (there is no
// re-finalize path), so the oracle persists for the life of the run row.
function digestMapKey(runId, camperId) {
  return createHash('sha256').update(`${runId}:${camperId}`).digest('hex')
}

export function computeExpectedSnapshotDigestByCamper(rows, runId) {
  const byCamper = new Map()
  for (const r of rows) {
    if (!byCamper.has(r.camper_id)) byCamper.set(r.camper_id, [])
    byCamper.get(r.camper_id).push(r)
  }
  const map = {}
  for (const [camperId, camperRows] of byCamper) {
    map[digestMapKey(runId, camperId)] = { rows: camperRows.length, digest: digestOf(camperRows) }
  }
  return JSON.stringify(map)
}

// A legacy stored digest is exactly digestOf's own output shape: lowercase hex, sha256 length.
// Anything else is either the new per-camper JSON map or corrupt — never ambiguous with this.
const LEGACY_DIGEST_RE = /^[0-9a-f]{64}$/

// Parses `snapshot_digest` as a per-camper map and returns it, or null if the string is not valid
// JSON, is not a plain object, or any entry is missing a numeric `rows`/string `digest`. A null
// return is read by computeSnapshotCompleteness as CORRUPT, never as complete and never silently
// as legacy — an owner requirement, since silently treating a corrupt value as "nothing to compare
// against" would let a broken digest field mask real incompleteness.
function parsePerCamperDigestMap(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  for (const entry of Object.values(parsed)) {
    if (entry === null || typeof entry !== 'object') return null
    if (typeof entry.rows !== 'number' || typeof entry.digest !== 'string') return null
  }
  return parsed
}

// The tombstoned camper ids this device has VERIFIED and projected (electron/automerge/
// projector.js's upsertTombstonesEntity already refused anything unsigned/stale before a row
// lands here) — the same fleet-wide fact projector.js's TOMBSTONE_DENYLISTED_ENTITIES gate reads
// to delete a purged camper's rows, reused here so both sides of "is this camper gone" agree.
function tombstonedCamperIds(db) {
  return new Set(db.prepare("SELECT id FROM tombstones WHERE entity = 'campers'").all().map((r) => r.id))
}

// Shared by every reader (getElectiveRun.js, getElectiveRunOuterSchedule.js,
// electiveRunProjectionInput.js via those two) — one fragment, per
// electiveGenerationPredicate.js's own precedent, so no reader can drift.
export function computeSnapshotCompleteness(db, run) {
  if (run?.status !== 'final') {
    return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
  }
  const expected = run.snapshot_expected_rows
  const digestField = run.snapshot_digest

  // elective_assignment_runs fields arrive ONE PER FIELD over Automerge in no guaranteed order
  // (same fact the module banner at the top of this file documents for stub-seeded snapshot rows),
  // so `snapshot_expected_rows` and `snapshot_digest` are two INDEPENDENT fields on the run itself
  // and can land on this device in either order. `expected == null` is therefore NOT one case —
  // it is two genuinely different situations that must not share a branch:
  //   - BOTH absent: a legacy/pre-v83 final run (or one whose snapshot predates this column
  //     existing) has nothing stored to compare against at all — same "no snapshot generation"
  //     posture computeFinalizedAgainstStaleGeneration already takes for its own no-snapshot-rows
  //     case. Not incomplete; simply unknown. KEEP THIS EXACTLY AS-IS — do not report incomplete
  //     for a run that never recorded an expectation.
  //   - digest PRESENT but expected still null: this device has synced `snapshot_digest` for a
  //     run that demonstrably finalized with a stored expectation (the digest only exists because
  //     finalizeElectiveRun.js wrote both fields together), but `snapshot_expected_rows` itself
  //     has not arrived yet. That is not "unknown" — it is a partially-synced finalized run, and
  //     reporting it complete would let an export run on a possibly zero-row snapshot. Fall through
  //     to the same per-camper/corrupt-digest machinery below so it reports INCOMPLETE with the
  //     real held numbers, not null.
  // Collapsing these back into one branch ("if expected == null, not incomplete") is the exact
  // regression this comment exists to prevent — see the "both absent" test immediately beside the
  // "digest arrived first" test in electiveRunSnapshotCompleteness.test.js.
  if (expected == null) {
    if (digestField == null) {
      return { expectedSnapshotRows: null, heldSnapshotRows: null, snapshotIncomplete: false }
    }
    const held = db
      .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?')
      .get(run.id).c
    return { expectedSnapshotRows: null, heldSnapshotRows: held, snapshotIncomplete: true }
  }

  // LEGACY DIGEST: plain-hex digest (what v83 wrote before erasure-aware comparison existed).
  // Deliberately NOT retroactive — no re-finalize path exists to upgrade an old run's stored
  // digest to the new per-camper shape — so this keeps comparing the OLD way, including staying
  // incomplete forever after an erasure.
  if (typeof digestField === 'string' && LEGACY_DIGEST_RE.test(digestField)) {
    const held = db
      .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?')
      .get(run.id).c
    const heldDigest = computeHeldSnapshotDigest(db, run.id)
    const incomplete = held !== expected || heldDigest !== digestField
    return { expectedSnapshotRows: expected, heldSnapshotRows: held, snapshotIncomplete: incomplete }
  }

  const perCamperExpected = parsePerCamperDigestMap(digestField)
  // CORRUPT DIGEST: unparseable — never complete, never silently legacy.
  if (!perCamperExpected) {
    const held = db
      .prepare('SELECT COUNT(*) c FROM elective_run_outer_snapshots WHERE run_id = ?')
      .get(run.id).c
    return { expectedSnapshotRows: expected, heldSnapshotRows: held, snapshotIncomplete: true }
  }

  // Amendment (2026-10-01) discriminator — a parsed per-camper map comes in two shapes that must
  // NOT be compared the same way:
  //   - keys NOT all 64-lowercase-hex: the raw-camper-id shape this module wrote in the dev-only
  //     window between PR #684 and this fix (no live users ever saw it). Treated EXACTLY like
  //     legacy plain-hex below: whole-set comparison, never erasure-aware. No migration path
  //     exists or is needed for it.
  //   - keys ALL 64-lowercase-hex: the current sha256(run_id:camper_id) shape — erasure-aware.
  // This is checked on KEYS inside the parsed object, deliberately NOT merged with LEGACY_DIGEST_RE
  // above (which tests the entire `snapshot_digest` STRING) — they test different things.
  // An EMPTY map ({}) satisfies "every key is hex" vacuously and falls into the hash-keyed branch
  // below. Deliberate, not an oversight: with zero entries the two branches behave identically
  // (nothing to compare), and an unexpectedly-held camper is still caught by the "held camper the
  // expectation never named" check below.
  const isHashKeyed = Object.keys(perCamperExpected).every((k) => /^[0-9a-f]{64}$/.test(k))
  if (!isHashKeyed) {
    // Whole-set comparison keyed by the raw camper_id (exactly as held rows are grouped) — no
    // tombstone lookup, no skipping: a missing row for ANY camper, erased or not, is incomplete.
    const heldRows = selectHeldRows(db, run.id)
    const heldByCamper = new Map()
    for (const r of heldRows) {
      if (!heldByCamper.has(r.camper_id)) heldByCamper.set(r.camper_id, [])
      heldByCamper.get(r.camper_id).push(r)
    }
    let complete = true
    for (const [camperId, entry] of Object.entries(perCamperExpected)) {
      const camperRows = heldByCamper.get(camperId) ?? []
      if (camperRows.length !== entry.rows || digestOf(camperRows) !== entry.digest) complete = false
    }
    for (const camperId of heldByCamper.keys()) {
      if (!(camperId in perCamperExpected)) complete = false
    }
    return { expectedSnapshotRows: expected, heldSnapshotRows: heldRows.length, snapshotIncomplete: !complete }
  }

  // Erasure-aware path: drop every tombstoned camper's entry from the expectation before
  // comparing, so the finalized run's export can be complete again without ever re-including
  // rows the fleet has agreed to erase. Both sides of the comparison hash camper ids the same way
  // (sha256(run_id:camper_id)) before lookup/subtraction — the expectation's keys are already in
  // that shape; held rows and tombstoned ids are hashed here to match.
  const erased = tombstonedCamperIds(db)
  const heldRows = selectHeldRows(db, run.id)
  const heldByCamperKey = new Map()
  for (const r of heldRows) {
    const key = digestMapKey(run.id, r.camper_id)
    if (!heldByCamperKey.has(key)) heldByCamperKey.set(key, [])
    heldByCamperKey.get(key).push(r)
  }
  const erasedKeys = new Set([...erased].map((camperId) => digestMapKey(run.id, camperId)))

  let expectedRows = 0
  let complete = true
  for (const [camperKey, entry] of Object.entries(perCamperExpected)) {
    if (erasedKeys.has(camperKey)) continue
    expectedRows += entry.rows
    const camperRows = heldByCamperKey.get(camperKey) ?? []
    if (camperRows.length !== entry.rows || digestOf(camperRows) !== entry.digest) complete = false
  }
  // A held camper this run's own expectation never named, and who is not erased, is itself a
  // mismatch — same "never silently green" posture as the corrupt-digest fallback above.
  for (const camperKey of heldByCamperKey.keys()) {
    if (!erasedKeys.has(camperKey) && !(camperKey in perCamperExpected)) complete = false
  }

  return { expectedSnapshotRows: expectedRows, heldSnapshotRows: heldRows.length, snapshotIncomplete: !complete }
}
