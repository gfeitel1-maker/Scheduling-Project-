// T318 round 2 — THE CHOKE POINT for one question that four call sites used
// to answer independently: does a stored `elective_preferences.rank_kind`
// carry POSITIVE EVIDENCE that a camper's rank was an actual ordering, or is
// it a tie among equals (or unknown) wearing an integer? Owner-ruled
// 2026-09-29: absence of evidence that ordering happened is not evidence of
// order, so the predicate defaults to false — a null/undefined/unrecognised
// kind is NOT positive evidence.
//
// DEPENDENCY-FREE BY REQUIREMENT: this module must import NOTHING (no React,
// no IPC, no `src/screens`), because it is imported by both
// src/engine/buildElectiveAssignments.js (a pure engine module) and
// src/screens/elective/run/camperElectiveWeek.js (a screen module) — the two
// sides of the fabrication-proof rule T318 introduced. Anything it imported
// would become a transitive dependency of the engine.
//
// The three constants were PRIVATE consts in src/ingest/preferenceSheet.js
// (the ETL that writes rank_kind) until this extraction; that module now
// imports them from here too, so the persisted string values live in exactly
// one place instead of being retyped as bare literals at every reader.
export const CELL_CHOICE = 'cell-choice'
export const ORDERED_FALLBACK = 'ordered-fallback'
export const UNORDERED_SET = 'unordered-set'

export function hasOrderingEvidence(rankKind) {
  return rankKind === CELL_CHOICE || rankKind === ORDERED_FALLBACK
}
