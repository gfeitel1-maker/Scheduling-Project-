// ONE CALL SHAPE for reading a camper preference sheet, shared by every entry
// point: the import screen (src/screens/elective/assignment/AssignmentPanel.jsx),
// the CLI (scripts/preferenceSheetCli.js) and the MCP tools.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// §3.2 — "one pure transform module, called from every entry point". That argument
// is load-bearing rather than stylistic: **T224 happened because one path reached
// extraction without passing through the gate the other path used**
// (`src/ingest/scheduleShape.js:14-21`). A second CALL SHAPE is a second T224 even
// when the transform underneath is shared, because the arguments are where the
// behaviour lives.
//
// WHAT THIS MODULE EXISTS TO FIX, stated plainly because it invalidated a whole
// program's worth of measurement. The panel called
// `parsePreferenceSheet(rows, { campId, mapping })` with `inferPreferenceMapping(rows[0])`
// — no catalog, no grid, no subject, no header locator. So in the DIRECTOR'S import
// path:
//
//   * the header locator never ran, and a title row above the table still broke it;
//   * `catalogAbsent` was always true, which disabled the junk-row fix, made the
//     inverted-matrix adapter unreachable, and marked every division unmatched and
//     every label unverified;
//   * the planner-grid path — the headline "18 per-cell preferences" — could not
//     fire at all;
//   * and `residue` was never rendered, so §3.4's "loud half", which the entire
//     design rests on, was invisible in the product.
//
// Every number this program reported (7→0 silent losses, 14→0 refusals) described
// the CLI. This module is what makes those numbers describe the product.
//
// PURE. No db, no IPC, no file reading — callers pass the rows and the camp's own
// entities as plain arrays, exactly as `parsePreferenceSheet` requires.

import { detectGridLayout, inferPreferenceLayout, parsePreferenceSheet } from './preferenceSheet.js'

/**
 * The identity of a SUBMISSION, derived from the table it contains.
 *
 * WHY THIS IS HERE AND PURE, rather than a SHA-256 per entry point. The key must be
 * the SAME for one submission whichever door it came through: the CLI hashing file
 * bytes with `node:crypto` and the screen hashing them with WebCrypto is TWO rules,
 * and two rules mean one child forking into two subjects depending on which door
 * their sheet used — the exact defect keying-per-submission exists to prevent, one
 * layer up. A first draft did that, and it also broke outright wherever
 * `crypto.subtle` is absent (jsdom, any non-secure context), taking the whole import
 * down with it.
 *
 * So the key is derived from the ROWS, which every caller already has, with no
 * environment dependency at all. A consequence worth stating rather than
 * discovering: the same table exported as CSV and as XLSX now CONVERGES on one
 * subject, because it is one submission in two containers.
 *
 * 128 bits as four FNV-1a passes with different offset bases. Not cryptographic and
 * it does not need to be — nothing here defends against a chosen-collision attacker,
 * it only has to make accidental collision between two camps' sheets impossible in
 * practice. It IS stable across runs and platforms, which a cryptographic hash would
 * also give but which `Math.random` or an object identity would not.
 */
export function submissionKeyFromRows(rows = []) {
  const text = rows.map((row) => (row ?? []).map((c) => String(c ?? '')).join('\u0000')).join('\u0001')
  const BASES = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9]
  const words = BASES.map((base) => {
    let h = base
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      // FNV-1a's 32-bit prime, via Math.imul so the multiply stays exact.
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  })
  return `sub-${words.join('')}`
}

/**
 * The camp's own entities, in the shape RESOLVE resolves against.
 *
 * Kept here rather than assembled per caller so the panel and the CLI cannot drift
 * into resolving against different sets — an activity catalog one path can see and
 * the other cannot is the difference between a label being verified and being
 * silently accepted.
 *
 * Tolerates both shapes this repo's collections come in: `localClient.list()` rows
 * (objects with `name`) and the CLI's already-mapped string arrays.
 */
export function buildPreferenceCatalog({ activities = [], groups = [], tiers = [] } = {}) {
  return {
    activities: activities.map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean),
    groups: groups.filter((g) => g?.id && g?.name).map((g) => ({ id: g.id, name: g.name })),
    tiers: tiers.filter((t) => t?.id && t?.name).map((t) => ({ id: t.id, name: t.name })),
  }
}

/**
 * Locate the table, read it, and resolve every value against the camp.
 *
 * @param {object}   args
 * @param {Array}    args.rows            one sheet's row arrays, header included.
 * @param {string}   args.campId
 * @param {object}   args.catalog         from buildPreferenceCatalog.
 * @param {string}   [args.camperName]    WHOSE sheet this is, when the caller knows
 *   — step 1 of the identity order. A planner grid carries no name column because
 *   the identity comes from the SUBMISSION rather than the page.
 * @param {string}   [args.sourceLabel]   a human-readable label for a provisional
 *   subject (the file name). A LABEL, never the key: keying on it merged two real
 *   children whose planners were both exported as `planner.csv`.
 * @param {string}   [args.submissionKey] the identity of a provisional subject —
 *   an opaque per-submission string (a content hash). Two submissions can never
 *   collide; the same submission re-read converges.
 *
 * @returns {{mapping, parsed}|{mapping, parsed: null, unmapped: string[]}}
 *   `parsed: null` means no table here could be read as a preference sheet. That is
 *   NOT a refusal (ADR §14.1 — the machine seam never refuses a readable file); the
 *   caller reports what could not be resolved and writes nothing.
 */
export function readPreferenceSheet({
  rows = [],
  campId,
  catalog,
  camperName = null,
  sourceLabel = null,
  submissionKey = null,
} = {}) {
  // The header ROW is located, not assumed to be row 1: a title and a season line
  // above the table are ordinary, and assuming row 1 made such a sheet "not a
  // camper preference sheet". The catalog goes in because an INVERTED MATRIX (one
  // column per activity, the cell holding its rank) is recognisable only by matching
  // headers against the camp's own activities.
  const mapping = inferPreferenceLayout(rows, { catalog })

  // A day x period GRID is one camper's own sheet (ADR §14.1a). Detected both as a
  // whole sheet and as a second table ABOVE the header — the page carrying a planner
  // AND a ranked block is the owner's own sheet, and reading only the block was this
  // program's own defect.
  const wholeSheetGrid = mapping.unmapped.length > 0 ? detectGridLayout(rows, 0) : null
  const preambleGrid = mapping.unmapped.length === 0 && mapping.headerIndex > 0
    ? detectGridLayout(rows, 0)
    : null
  const grid = wholeSheetGrid ?? preambleGrid

  // IDENTITY ORDER, and it never blocks the data from landing: the caller's name
  // first, then a provisional subject keyed on the SUBMISSION and labelled with the
  // file name. An unattributed subject is a first-class outcome — the preferences
  // are stored with their coordinates and a human or an agent names the child later,
  // without re-importing (electron/ops/attributeElectiveSubject.js).
  //
  // Deliberately NOT derived from the campers named elsewhere on the page: a page
  // carrying a grid AND a ranked list names several, so picking one would be a guess
  // about whose week the grid describes.
  const subject = camperName
    ? { displayName: camperName, source: 'caller', attributed: true }
    : { displayName: sourceLabel || null, externalId: submissionKey, source: sourceLabel ? 'label' : 'none', attributed: false }

  if (mapping.unmapped.length > 0 && !wholeSheetGrid) {
    return { mapping, parsed: null, unmapped: mapping.unmapped }
  }

  const parsed = parsePreferenceSheet(rows, {
    campId,
    // A whole-sheet grid has no row-per-camper table, so the mapping it carries
    // describes nothing; give the transform an empty one rather than a mapping whose
    // `unmapped` would be read as a finding about a sheet that was in fact read.
    mapping: wholeSheetGrid
      ? { unmapped: [], unrecognisedColumns: [], rankColumns: [], headerIndex: 0 }
      : mapping,
    catalog,
    grid: grid
      ? {
          layout: grid,
          // A whole-sheet grid's body starts under its own header row; a preamble
          // grid's ends where the named table begins.
          rows: wholeSheetGrid ? rows.slice(1) : rows.slice(1, mapping.headerIndex),
          headerIndex: 0,
        }
      : undefined,
    subject: grid ? subject : undefined,
  })

  return { mapping, parsed }
}
