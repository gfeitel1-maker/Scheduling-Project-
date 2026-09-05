// locationWordDecisions — the single writer/reader of location_word_decisions
// (host-local). Mirrors declinedSplits.js's shape: a direct, transactional
// SQL write with NO appendOp call — location_word_decisions is never
// replicated and never replayed, same as source_aliases/compound_cell_decisions.
//
// docs/adr/2026-09-05-unresolved-location-remembered-decisions-and-held-conflict-triage-coverage.md
//
// Words are stored NORMALIZED via normalizeWordKey (lowercase, whitespace-
// collapsed/trimmed — the same normalization class electCanonicalSpellings
// already applies to activity names, ADR §2). This module owns the
// normalization function so the write side and the read side (the
// consult-before-hold check in electron/ops/ingest.js) can never compute
// word_key two different ways.

import { randomUUID } from 'node:crypto'

export function normalizeWordKey(word) {
  return String(word ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Record that the director said `rawWord` is not a place at `campId`, so a
 * future import never raises location_unresolved for the same word again.
 * Idempotent — recording the same (camp, word) twice is a no-op (INSERT OR
 * IGNORE against UNIQUE(camp_id, word_key)), matching confirmAlias's
 * idempotent-retry handling.
 */
export function recordNotAPlace(db, { campId, rawWord, confirmedBy = null }) {
  if (!campId) throw new Error('recordNotAPlace: campId is required')
  const trimmedRaw = String(rawWord ?? '').trim()
  const wordKey = normalizeWordKey(rawWord)
  if (!wordKey) throw new Error('recordNotAPlace: rawWord is required')

  db.prepare(
    `INSERT OR IGNORE INTO location_word_decisions
       (id, camp_id, word_key, raw_word, decision, confirmed_by, confirmed_at)
     VALUES (?, ?, ?, ?, 'not_a_place', ?, ?)`
  ).run(randomUUID(), campId, wordKey, trimmedRaw, confirmedBy, new Date().toISOString())
}

/**
 * Whether the director has already said `rawWord` is not a place at
 * `campId` — the pre-flight check `resolveFieldWrite`'s caller must run
 * BEFORE raising location_unresolved for a word (ADR §3), the same
 * consult-a-host-local-table pattern `listAliasMap` already serves during
 * plan building.
 *
 * @returns {boolean}
 */
export function isWordDeclinedAsPlace(db, { campId, rawWord }) {
  if (!campId) throw new Error('isWordDeclinedAsPlace: campId is required')
  const wordKey = normalizeWordKey(rawWord)
  if (!wordKey) return false
  const row = db
    .prepare("SELECT 1 FROM location_word_decisions WHERE camp_id = ? AND word_key = ? AND decision = 'not_a_place'")
    .get(campId, wordKey)
  return !!row
}
