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

import {
  detectGridLayout,
  detectWholeSheetGrid,
  inferPreferenceLayout,
  mappingWithDirectorOverride,
  parsePreferenceSheet,
  residueParts,
} from './preferenceSheet.js'

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
 *
 * BUNDLES MERGE INTO `activities` RATHER THAN BECOMING A SECOND LIST (board item
 * 9b, docs/adr/2026-09-29-linked-elective-bundles.md D4 — a bundle's name is "the
 * string a camper's sheet must match"). The reason is that `activities` is not a
 * list of activities to the things that read it — it is THE SET OF LABELS A SHEET
 * MAY NAME. `makeLabelResolver` builds its recognition map from it, and the
 * inverted-matrix classifier matches column headers against it. A second list
 * would have to be threaded into both, and the day one of them forgot it is the
 * day a bundle resolves through one door and not the other — the exact drift this
 * function exists to prevent.
 *
 * THE CONSEQUENCE FOR THE `empty`/`abstained` CONTRACT, stated because merging into
 * a set that governs an abstention deserves an argument rather than a shrug.
 * `makeLabelResolver`'s `empty` is `known.size === 0`, and an empty catalogue makes
 * EVERY label abstain (src/ingest/preferenceSheet.js — the resolver's own guard).
 * Merging can only GROW a non-empty set, so no camp that resolved labels before
 * abstains now. The other direction — a camp with bundles and no activities, which
 * would newly un-abstain — is structurally unreachable: `deriveChoices` reads
 * `bundle.activity_id`, so a bundle presupposes an activity. `bundles.length > 0`
 * therefore implies `activities.length > 0`, and this merge cannot flip `empty`.
 *
 * Deduped, because one name is one label whatever claims it: the common shape is a
 * bundle named after its own activity (the acceptance fixture's 'Ropes'), and the
 * catalogue is evidence about how many distinct labels a camp has.
 */
export function buildPreferenceCatalog({ activities = [], groups = [], tiers = [], bundles = [], campers = [] } = {}) {
  const name = (x) => (typeof x === 'string' ? x : x?.name)
  return {
    activities: [
      ...new Set([...activities, ...bundles].map(name).filter(Boolean)),
    ],
    groups: groups.filter((g) => g?.id && g?.name).map((g) => ({ id: g.id, name: g.name })),
    tiers: tiers.filter((t) => t?.id && t?.name).map((t) => ({ id: t.id, name: t.name })),
    campers: campers.filter((c) => c?.id && c?.display_name).map((c) => ({ id: c.id, display_name: c.display_name })),
  }
}

/**
 * WHICH TAB of a workbook holds the camper preferences — ONE rule, shared by the CLI and the import
 * panel (T314).
 *
 * WHY THIS IS HERE RATHER THAN IN EACH DOOR. It used to live only in `scripts/preferenceSheetCli.js`,
 * and the panel read `sheets[0]`. That was half a choke point, and it cost a director two ways at
 * once, both measured before this was written:
 *
 *   * notes on tab 1 -> `parsed: null`, and the panel told them "That file does not read as a camper
 *     preference sheet" about a file that plainly does;
 *   * an offerings MENU on tab 1 -> read as one camper's own PLANNER, so the import SUCCEEDED, minted
 *     a phantom unattributed camper named after the file, and never touched the real table. Two real
 *     children silently not imported, and a camper row belonging to nobody created. A menu and a
 *     filled planner are the same day x period shape with opposite meanings (ADR §3.3), so nothing
 *     about tab 1 could have told them apart — which is why the answer is to classify every tab
 *     rather than to look harder at the first.
 *
 * NO TAB PICKER, deliberately. A workbook's shape is the camp's data, not this app's model (owner,
 * on import formats: "it does not matter what tool someone uses"), so asking the director which tab
 * to read would hand them classification this code already does.
 *
 * PER-SHEET CLASSIFICATION, never concatenation (T285 slice D). Exactly one tab is read and every
 * other is reported by name: two tabs of submissions are two imports, and merging them is the one
 * refusal the ADR names. If several tabs map cleanly the FIRST wins and the rest are reported —
 * accept-and-report, not a merge, and not a question for the director.
 *
 * @param   {object} args
 * @param   {Array}  args.sheets   `[{name, rows}]`, from `readWorkbookRows`.
 * @param   {object} args.catalog  from `buildPreferenceCatalog`. Load-bearing in the ORDER it is
 *   used: an INVERTED MATRIX (one column per activity, the cell holding its rank) is recognisable
 *   only by matching headers against the camp's own activities, so a tab cannot be classified before
 *   the catalog is known.
 *
 * @returns {{candidates, selected, kind, unread}}
 *   `selected` is `null` when no tab is readable — a first-class outcome, not a refusal (ADR §14.1):
 *   the caller reports what it could not resolve and writes nothing. `unread` is then EMPTY, because
 *   naming tabs as unread when none was read would be false — there is no "instead".
 */
export function selectPreferenceSheet({ sheets = [], catalog } = {}) {
  const candidates = sheets.map((sheet) => ({
    sheet,
    mapping: inferPreferenceLayout(sheet.rows, { catalog }),
  }))

  // A tab that maps with NOTHING unmapped is a camper preference table. `rows.length >= 2` because a
  // header with no body under it is not a submission.
  const table = candidates.find((c) => c.sheet.rows.length >= 2 && c.mapping.unmapped.length === 0)

  // A GRID IS NOT AN UNREADABLE SHEET. Before concluding that no tab holds preferences, ask whether
  // one is a day x period grid — a camper's own planner, whose identity comes from the SUBMISSION
  // rather than from a name column it has no reason to have.
  const grid = table ? null : candidates.find((c) => detectGridLayout(c.sheet.rows, 0) != null)

  const selected = table ?? grid ?? null
  const kind = table ? 'table' : grid ? 'grid' : null

  // EVERY TAB WE DID NOT READ, NAMED. A workbook silently reduced to one tab is the same silence
  // §12.0 forbids everywhere else, and it is the half of this fix a director actually sees.
  const unread = selected
    ? candidates
        .filter((c) => c.sheet.name !== selected.sheet.name)
        .map((c) => ({
          kind: 'UNREAD_SHEET',
          sheet: c.sheet.name,
          rows: c.sheet.rows.length,
          ...residueParts(
            `Tab \u201c${c.sheet.name}\u201d`,
            kind === 'grid'
              ? `Not read (${c.sheet.rows.length} row(s)) \u2014 the grid on ` +
                `\u201c${selected.sheet.name}\u201d was. Tabs are never combined.`
              : `Not read (${c.sheet.rows.length} row(s)) \u2014 the camper preferences were taken from ` +
                `\u201c${selected.sheet.name}\u201d instead. Tabs are never combined.`
          ),
        }))
    : []

  return { candidates, selected, kind, unread }
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
 * @param {object}   [args.resolutions]   the director's settled label resolutions,
 *   from `resolutionMap` — `{ [rawLabel]: { action, activityName } }`. Absent means
 *   nothing has been settled, which is every FIRST read of a sheet.
 * @param {object}   [args.mapping]       WHICH COLUMN IS WHICH, when a human has
 *   said so — the director's corrected mapping from the import panel (T307). Absent,
 *   and the layout is located from the header exactly as before; every machine caller
 *   omits it. Present, it replaces the inference rather than being weighed against it,
 *   after `mappingWithDirectorOverride` recomputes the derived fields a hand edit
 *   leaves stale and re-applies the shape gates a hand edit can walk past.
 * @param {string}   [args.submissionKey] WHAT a provisional subject submitted —
 *   an opaque per-submission string (a content hash). Two different submissions
 *   can never collide; the same submission re-read converges. OMITTING IT IS THE
 *   NORMAL CASE and derives it from `rows` (T313): the key must be over exactly the
 *   rows that were read, and letting each caller pass its own was the last way two
 *   doors could key one submission on two different row sets. The panel still passes
 *   its own because it holds the key in state across the re-parses a settled label
 *   triggers, and that value is this same derivation.
 * @param {string}   [args.arrivalId]    WHICH IMPORT this submission arrived in,
 *   and half of a provisional subject's identity (T299). The content key alone
 *   cannot be that identity: two children who picked the same activities produce
 *   byte-identical sheets, so a content-only key merged them into one camper.
 *   Arrival is the fact that differs — two children handing in matching sheets
 *   are two import actions, while one import action repeated is one arrival. The
 *   caller states it because only the caller knows: the director's panel mints
 *   one per file selection, and on the machine path an agent declares one per
 *   submission (T303 — `arrival_id`). A machine caller that declares nothing
 *   falls back to the run id derived from the file's bytes, so its retry stays
 *   idempotent; that fallback cannot separate two children who chose the same
 *   activities, and the import says so rather than merging in silence.
 *
 *   THAT FALLBACK IS THE CALLER'S RULE, NOT THIS MODULE'S, and it is why there is no
 *   `defaultArrivalId` parameter here (T313). Only the CLI has file bytes to
 *   content-address, and the panel deliberately mints one arrival per file selection;
 *   a default living here would be a third policy neither door wants. The CLI resolves
 *   `declaredArrival ?? importedRunId` before the call and passes the answer.
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
  // T313 / #644 — a camper the caller has already LOCATED, by id. Set with
  // `camperName`, never instead of it: the name is what gets WRITTEN onto the row and
  // the id is what the row IS. Absent, an attributed subject's id is derived as before.
  camperId = null,
  // The located camper's roster id, carried through rather than dropped: the parser
  // writes it back onto the record, and omitting it would CLEAR a real roster id.
  externalId = null,
  sourceLabel = null,
  submissionKey = null,
  arrivalId = null,
  // T298 — what a director already settled about labels this catalog cannot
  // resolve, keyed on the raw label (src/ingest/labelResolutions.js). Forwarded
  // rather than interpreted: this module locates and delegates, and a resolution
  // is the transform's input, not this one's.
  resolutions = null,
  // T307 — WHICH COLUMN IS WHICH, when a human has said so. Absent (every machine
  // caller, and a director who corrected nothing) the layout is located exactly as
  // before, so there is still ONE call shape and §3.2 is not reopened. Present, it
  // is used instead of the inference, because a director's answer is not evidence to
  // weigh against the catalog — it is the answer, the same way a settled label
  // resolution is. It is normalised first: what the corrector hands back carries
  // edited ROLES over the inferencer's DERIVED fields, and using it raw reports a
  // column the director just mapped as unread and reads shape-overlapping columns
  // twice (`mappingWithDirectorOverride`).
  mapping: mappingOverride = null,
} = {}) {
  // The header ROW is located, not assumed to be row 1: a title and a season line
  // above the table are ordinary, and assuming row 1 made such a sheet "not a
  // camper preference sheet". The catalog goes in because an INVERTED MATRIX (one
  // column per activity, the cell holding its rank) is recognisable only by matching
  // headers against the camp's own activities.
  const mapping =
    mappingWithDirectorOverride(mappingOverride, rows) ?? inferPreferenceLayout(rows, { catalog })

  // A day x period GRID is one camper's own sheet (ADR §14.1a). Detected both as a
  // whole sheet and as a second table ABOVE the header — the page carrying a planner
  // AND a ranked block is the owner's own sheet, and reading only the block was this
  // program's own defect.
  const wholeSheetGrid = detectWholeSheetGrid(rows, mapping)
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
  // THE ONLY PLACE A PROVISIONAL SUBJECT IS BUILT (T313). The CLI kept its own
  // `resolveSubject` spelling this same object, and the halves drifted exactly where a
  // second spelling always does: T303 taught the CLI's copy a caller-declared arrival
  // and left this one forwarding a bare `arrivalId`, so the machine door and the
  // director's door disagreed about the second half of a child's identity. The CLI
  // file's own comment had named the cost for the submission KEY — "two rules fork one
  // child into two subjects depending on which door their sheet came through" — and
  // nothing was checking it for the arrival, or for the object around it.
  //
  // WHAT THE CALLER STILL DECIDES, because only a caller can: whether it has already
  // LOCATED this camper. `camperId` is that answer, and it is a FACT rather than a
  // recipe — `deriveCamperId`'s `ext`/`name` arms read `external_id` and `display_name`,
  // both ordinary admin-writable columns, so re-deriving an id for a row that already
  // exists mints a second one the day an admin fixes a typo (#644, confirmed by
  // execution). A door that looked the camper up passes the id; nothing is derived.
  const subject = camperName
    ? {
        camperId: camperId || null,
        displayName: camperName,
        externalId: externalId || null,
        source: camperId ? 'located' : 'caller',
        attributed: true,
      }
    : {
        displayName: sourceLabel || null,
        // Derived here when the caller did not state it, so the key is always over
        // the rows that were actually read.
        externalId: submissionKey ?? submissionKeyFromRows(rows),
        arrivalId,
        source: sourceLabel ? 'label' : 'none',
        attributed: false,
      }

  if (mapping.unmapped.length > 0 && !wholeSheetGrid) {
    return { mapping, parsed: null, unmapped: mapping.unmapped }
  }

  const parsed = parsePreferenceSheet(
    // A whole-sheet grid has NO row-per-camper table, so there is no table body to hand
    // the transform — the grid's own rows go in under `grid.rows` below. Passing them
    // positionally as well made `parsePreferenceSheet` walk each one looking for a
    // camper name, find none, and report every row of the planner as
    // `skippedRows: 'no camper name'` — which ParseSummary showed the director as
    // "N row(s) skipped" on an import where all N rows landed. A residue item that is
    // false is worse than one that is missing, and the CLI door always passed `[]`
    // here (T313).
    wholeSheetGrid ? [] : rows,
    {
    campId,
    // The mapping a whole-sheet grid carries describes nothing; give the transform an
    // empty one rather than a mapping whose `unmapped` would be read as a finding
    // about a sheet that was in fact read.
    mapping: wholeSheetGrid
      ? { unmapped: [], unrecognisedColumns: [], rankColumns: [], headerIndex: 0 }
      : mapping,
    catalog,
    resolutions,
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
    }
  )

  return { mapping, parsed }
}

/**
 * Audit E1 (2026-10-10) — does this workbook hold a CAMPER PREFERENCE TABLE (a
 * camper column plus ranked choices) on any tab?
 *
 * Asked by the elective set's OFFERINGS import, which reads a different document
 * (what the set offers) and used to answer a preference sheet with a bare
 * "Couldn't read that file." It answers by the same rule the preference import
 * itself uses to pick a tab (`selectPreferenceSheet`), so the two doors cannot
 * disagree about what a preference sheet is. Only a `table` counts: a day x period
 * grid is also what an offerings file looks like, so it is not claimed here.
 */
export function isCamperPreferenceWorkbook(sheets = []) {
  if (!Array.isArray(sheets) || sheets.length === 0) return false
  return selectPreferenceSheet({ sheets }).kind === 'table'
}
