// Reading a camper ranked-preference sheet into a PROPOSAL (T226), through the
// RESOLVE stage (T279).
//
// docs/work/tickets/T226-camper-preference-import.md,
// docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md,
// docs/adr/2026-09-17-individual-elective-scheduling.md (D12, D14),
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md.
//
// Pure: no database, no IPC, no file reading. It takes the row arrays every
// other ingest consumer takes — plus the camp's own catalog, as plain arrays —
// and returns campers/choices/preferences/residue for a caller to show a
// director and commit. Like extractEntities, it PROPOSES.
//
// WHY A MAPPING RATHER THAN A FIXED LAYOUT. D14 recorded that the real
// submissions arrive through a third-party export nobody has seen (T218). The
// FIELDS are known from the camp's own blank form — a name, a division, a
// 1..N ranking, a swim opt-out — but their column arrangement is not, and a
// parser that hardcodes one arrangement is the thing D14 retired. So the
// layout is an argument: inferPreferenceMapping proposes one from the header,
// and the director corrects it. A new export format is then a mapping, not a
// code change.
//
// THE RULE THIS FILE NOW IMPLEMENTS (ADR §12.0, normative):
//
//   RESOLVE is the stage where every value read out of a file is either matched
//   to an entity the camp already has, or becomes RESIDUE. The elective
//   importer never writes a value it could not resolve without saying so.
//
// Five resolvers, one rule: columns → roles, labels → activities, division
// labels → groups (then tiers), rows → camper identities, coordinates →
// elective cells. Working the seven measured silent misses individually
// produced one answer seven times, which is why this is one stage rather than
// five patches — a reader can ask of any value "which resolver owns this, and
// what happens when it misses?"
//
// CORRECTION (T279) TO THIS FILE'S OWN HEADER. It used to claim:
//
//   "The ranking is GLOBAL — a camper ranks each elective once for the
//    session, not once per time slot."
//
// That is FALSE, and it was false when written. A Kind 2 planner grid gives one
// camper a choice PER CELL, and `elective_preferences.occurrence_id` (nullable,
// v78) exists precisely to carry that. A whole-run ranked list and a per-cell
// planner are both legitimate, which is why a preference's coordinate is
// NULLABLE rather than absent from the model: absent means "this reader cannot
// see cells", nullable means "this sheet does not scope its choices". The
// comment survived because nothing keyed on it; it is corrected rather than
// deleted so the record shows what the reader used to assume.

import { deriveCamperId, electiveChoiceLabelKey } from '../../electron/ops/electiveDerivedIds.js'
import { recognitionKey } from './preview.js'

const RANK_HEADER = /^#\s*(\d+)$/
const NAME_HEADER = /(camper|student|child).*name|^name$/i
const EXTERNAL_ID_HEADER = /(camper|student|child)\s*(id|number|#)$|^id$/i
const DIVISION_HEADER = /division|bunk|group|unit|edah/i
// A per-row coordinate (T279). A sheet that scopes each choice to a cell says
// so in its own columns; this is the parse-time half of the coordinate
// resolver, and the value it yields is a LABEL PAIR, never an occurrence_id —
// see the `coordinate` note on parsePreferenceSheet.
const DAY_HEADER = /^day(\s*of\s*week)?$/i
const PERIOD_HEADER = /^(period|time\s*block)(\s*(number|#))?$/i
// An UNORDERED set in its own column (ADR §4.1): one cell holding several
// acceptable activities with no ordering evidence. Deliberately narrow — it
// must not swallow a title row like 'Activity Selection' (P12).
const UNORDERED_SET_HEADER = /^(acceptable|preferred|chosen)\s+activities$|^activities\s+chosen$/i

// The three meanings one integer `rank` column cannot carry (ADR §4.2), now
// persisted as `elective_preferences.rank_kind` (v79).
const CELL_CHOICE = 'cell-choice'
const ORDERED_FALLBACK = 'ordered-fallback'
const UNORDERED_SET = 'unordered-set'

// A packed multi-value cell's delimiters. One definition, used by both the
// label resolver's split-detection and the unordered-set column.
const PACKED_CELL_SPLIT = /\s*[,;/]\s*/

const cell = (row, index) => (index == null ? '' : String(row?.[index] ?? '').trim())

// Spreadsheet column letters, because that is what a director sees in the
// header row — not the zero-based index the mapping carries. Exported because
// the CLI reports the same letters and already imports from this module; two
// copies of a base-26 conversion is one too many.
export function columnLabel(index) {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * Propose which column is which, from the header row.
 *
 * Every field is nullable and `unmapped` names what was not found — the caller
 * shows that to the director rather than proceeding on a guess.
 *
 * RESOLVER 1 (columns → roles). `unrecognisedColumns` is the new half and it is
 * the highest-leverage fix in the whole ticket: a column this reader cannot
 * assign a role to is REPORTED rather than ignored. That is what makes P18's
 * swim opt-out and comments box visible, and it is the loud half of P38 — a
 * rank column renamed `#3` → `Third Choice` between two imports silently
 * dropped rank 3 for every camper, with ok=true and nothing said. The rename
 * is still not UNDERSTOOD; it is no longer invisible.
 */
export function inferPreferenceMapping(header = []) {
  const cells = header.map((h) => String(h ?? '').trim())
  const findIndex = (re) => {
    const i = cells.findIndex((h) => re.test(h))
    return i === -1 ? null : i
  }

  const rankColumns = []
  cells.forEach((h, index) => {
    const m = RANK_HEADER.exec(h)
    if (m) rankColumns.push({ rank: Number(m[1]), index })
  })
  rankColumns.sort((a, b) => a.rank - b.rank)

  const externalIdIndex = findIndex(EXTERNAL_ID_HEADER)
  let nameIndex = findIndex(NAME_HEADER)
  // 'Camper ID' matches the name pattern's 'camper' branch only if the name
  // pattern is loosened; keep them disjoint so an id column is never the name.
  if (nameIndex !== null && nameIndex === externalIdIndex) nameIndex = null

  const divisionIndex = findIndex(DIVISION_HEADER)
  const dayIndex = findIndex(DAY_HEADER)
  const periodIndex = findIndex(PERIOD_HEADER)
  const unorderedSetIndex = findIndex(UNORDERED_SET_HEADER)

  // Every column that got a role. Anything else with a non-empty header is
  // unrecognised — and a BLANK header is not reported, because a trailing empty
  // column is a spreadsheet artefact rather than a field the camp asked about.
  const claimed = new Set(
    [nameIndex, externalIdIndex, divisionIndex, dayIndex, periodIndex, unorderedSetIndex]
      .filter((i) => i != null)
      .concat(rankColumns.map((r) => r.index))
  )
  const unrecognisedColumns = cells
    .map((header, index) => ({ header, index, column: columnLabel(index) }))
    .filter((c) => c.header !== '' && !claimed.has(c.index))

  const unmapped = []
  if (nameIndex === null) unmapped.push('name')
  if (rankColumns.length === 0 && unorderedSetIndex === null) unmapped.push('ranks')

  return {
    nameIndex,
    externalIdIndex,
    divisionIndex,
    dayIndex,
    periodIndex,
    unorderedSetIndex,
    rankColumns,
    unrecognisedColumns,
    unmapped,
  }
}

/**
 * RESOLVER 2 (labels → activities), against the camp's OWN activity catalog.
 *
 * Returns one of:
 *   {status:'matched'}    the whole cell names a known activity
 *   {status:'packed'}     the cell names nothing, but splitting it yields >= 2
 *                         known activities — genuinely AMBIGUOUS, so it is
 *                         asked about rather than guessed
 *   {status:'unresolved'} the cell names nothing recognisable
 *   {status:'abstained'}  there is nothing to resolve AGAINST (empty catalog)
 *
 * The 'abstained' case is the distinction that matters, and it is not in the
 * ADR — I am drawing it deliberately. With an empty catalog, "no match" is not
 * evidence about the label, it is evidence about the catalog. Treating it as a
 * miss and withholding the write would refuse every FIRST import a camp ever
 * does, which is the refuse-everything class §3.1a had to correct twice. So an
 * abstention WRITES the label and flags every one of them unverified: loud and
 * useless-looking, which §12.3 says is correct, rather than quiet and wrong.
 */
function makeLabelResolver(activities = []) {
  const known = new Map()
  for (const name of activities) {
    const label = typeof name === 'string' ? name : name?.name
    if (label) known.set(recognitionKey('activities', label), label)
  }
  const empty = known.size === 0

  const resolve = (raw) => {
    if (empty) return { status: 'abstained' }
    if (known.has(recognitionKey('activities', raw))) return { status: 'matched' }
    // A packed multi-value cell inside a RANKED column — which §4.1 ruled on
    // only for a set in its OWN column. Splitting is a DETECTION, never a
    // resolution: a camp may have packed three alternatives into one rank, and
    // an activity name may legitimately contain a comma. Both readings are
    // live, so a human answers once.
    const parts = raw.split(PACKED_CELL_SPLIT).map((p) => p.trim()).filter(Boolean)
    if (parts.length >= 2 && parts.every((p) => known.has(recognitionKey('activities', p)))) {
      return { status: 'packed', parts }
    }
    return { status: 'unresolved' }
  }

  // `empty` travels WITH the resolver rather than being recomputed by the
  // caller: the 'abstained' contract depends on the two agreeing, and two
  // definitions derived from different inputs is how they stop agreeing.
  return { resolve, empty }
}

/**
 * RESOLVER 3 (division labels → groups, then tiers). ADR §12.2a, §13.5.
 *
 * TWO TARGET SETS IN ORDER, and the order is the whole point.
 * `DIVISION_HEADER` conflates four granularities (/division|bunk|group|unit|
 * edah/), and the "division" concept in this codebase is `tiers`, while the
 * referential fact exports and the solver need is `groups`. So:
 *
 *   a `groups` match  → sets group_id (and the tier follows transitively)
 *   a `tiers` match   → sets NOTHING referential, and says which tier it
 *                       matched, so the director can assign groups.
 *                       `campers.tier_id` is deliberately NOT added:
 *                       `groups.tier_id` is the single path from a camper to a
 *                       tier, and a second path is a second thing to disagree.
 *   no match          → group_id stays null, and the label is residue
 *
 * IN EVERY CASE the label is stored verbatim in `campers.division_label`, and
 * IN NO CASE is a group or a tier created. That is T224's lesson stated as a
 * rule: a preference sheet's column headers once became camp groups, and again
 * became tiers.
 */
function makeDivisionResolver({ groups = [], tiers = [] } = {}) {
  const byGroup = new Map(groups.map((g) => [recognitionKey('groups', g.name), g]))
  const byTier = new Map(tiers.map((t) => [recognitionKey('tiers', t.name), t]))

  return (label) => {
    if (!label) return { status: 'absent', groupId: null }
    const group = byGroup.get(recognitionKey('groups', label))
    if (group) return { status: 'group', groupId: group.id }
    const tier = byTier.get(recognitionKey('tiers', label))
    if (tier) return { status: 'tier', groupId: null, tierName: tier.name }
    return { status: 'unmatched', groupId: null }
  }
}

// The coordinate a row scopes its choices to, as LABELS. Two rows share a
// coordinate when this string matches; a row with no coordinate columns yields
// '', which is the single implicit whole-run "cell" every such row shares.
const coordinateKey = (coordinate) =>
  coordinate ? `${coordinate.dayName ?? ''}\u0000${coordinate.periodLabel ?? ''}` : ''

/**
 * Read the sheet under a mapping, resolving every value against the camp.
 *
 * @param {Array<Array>} rows      raw row arrays, header first
 * @param {object}  options
 * @param {string}  options.campId
 * @param {object}  options.mapping    from inferPreferenceMapping
 * @param {object}  [options.catalog]  the camp's OWN entities: {activities,
 *   groups, tiers}. Plain arrays, so this function stays pure — the caller does
 *   the reading. An ABSENT catalog is not the same as an empty one: absent
 *   means the caller did not supply it (the resolver abstains and says so),
 *   which is also what an empty catalog means, so both take the same path.
 *
 * @returns {{campers, choices, preferences, sameNameCampers, skippedRows, residue, coverage}}
 *   `campers[].id` is the derived camper id (two devices reading one sheet
 *   converge on it), and `campers[].division_label` is the source file's own
 *   label, verbatim, with `group_id` the resolved reference or null.
 *   `choices` are distinct RESOLVED labels, keyed by the same canonicalizer the
 *   elective-choice id uses, so a spelling variant folds.
 *   `preferences` carry `label`/`labelKey` rather than a choice id (choice ids
 *   are run-scoped and no run exists at parse time), plus `coordinate` and
 *   `rank_kind`. A preference's `coordinate` is a LABEL PAIR, never an
 *   occurrence_id: a binding names a coordinate and the CALLER resolves it
 *   against deriveOccurrences at solve time, because the two candidate
 *   schedule routes yield two different occurrence_ids for one coordinate and
 *   neither route is canonical — a binding keyed to an occurrence would be a
 *   statement about a schedule rather than about a child.
 *   `residue` is the loud half (§3.4): non-empty by default until each item is
 *   claimed or waived.
 */
export function parsePreferenceSheet(rows = [], { campId, mapping, catalog } = {}) {
  const body = rows.slice(1)
  const campers = []
  const byId = new Map()
  const rowsByName = new Map()
  const choicesByKey = new Map()
  const skippedRows = []
  const residue = []
  const { resolve: resolveLabel, empty: catalogAbsent } = makeLabelResolver(catalog?.activities ?? [])
  const resolveDivision = makeDivisionResolver(catalog ?? {})

  const add = (kind, message, extra = {}) => residue.push({ kind, message, ...extra })

  // RESOLVER 1's output, reported once for the sheet rather than once per row.
  for (const c of mapping?.unrecognisedColumns ?? []) {
    add(
      'UNRECOGNISED_COLUMN',
      `Column ${c.column} is headed “${c.header}” and this import does not know what that ` +
        'field is, so nothing on it was read. If it matters, nobody has been told it was skipped ' +
        'until now.',
      { header: c.header, column: c.column, index: c.index }
    )
  }

  // PASS 1 — read every row, resolving as we go. Nothing is written for a value
  // that resolves to nothing; it becomes residue instead.
  const candidates = []
  const unverifiedLabels = new Set()
  const unorderedSetRows = []
  let unmeasuredCampers = 0

  body.forEach((row, i) => {
    const rowNumber = i + 2 // 1-based, and the header is row 1 — what a director sees.
    const displayName = cell(row, mapping?.nameIndex)
    const externalId = cell(row, mapping?.externalIdIndex)
    if (!displayName && !externalId) {
      skippedRows.push({ rowNumber, reason: 'no camper name' })
      return
    }

    const dayName = cell(row, mapping?.dayIndex) || null
    const periodLabel = cell(row, mapping?.periodIndex) || null
    const coordinate = dayName || periodLabel ? { dayName, periodLabel } : null
    // §4.2's three meanings, and the discriminator is the NUMBER of rank
    // columns rather than merely whether a coordinate exists.
    //
    // A planner grid gives one camper ONE activity per cell — that cell is
    // CHOSEN, rank 1 by construction. But a per-cell sheet can also rank WITHIN
    // a cell ("for Monday period 3: first Archery, then Ceramics"), and that is
    // an ordered fallback that happens to be cell-scoped. A coordinate changes
    // the SCOPE of a preference; it does not change what its rank MEANS.
    //
    // Getting this wrong is not cosmetic: an earlier draft forced `rank: 1` for
    // every ranked column whenever a coordinate was present, which collapsed
    // #1/#2/#3 onto one rank inside one cell and refused the sheet with "a
    // camper holds the same preference rank twice" — a refusal that is both
    // wrong and misleading about why. Caught by running the corpus (P33), not by
    // re-reading the code.
    const cellIsASingleChoice = coordinate != null && (mapping?.rankColumns ?? []).length === 1
    const rankKindForRanks = cellIsASingleChoice ? CELL_CHOICE : ORDERED_FALLBACK

    // Every preference cell this row offers, ranked columns and the unordered
    // set column alike, before any of them is known to resolve.
    const cells = []
    for (const { rank, index } of mapping?.rankColumns ?? []) {
      const raw = cell(row, index)
      if (!raw) continue // A blank rank is a rank the camper left empty, not a shift.
      // The explicit rank is ALWAYS preserved. It is the camper's own statement.
      cells.push({ raw, rank, rankKind: rankKindForRanks, index })
    }
    if (mapping?.unorderedSetIndex != null) {
      const raw = cell(row, mapping.unorderedSetIndex)
      // §4.1 — a packed cell with no ordering evidence produces bindings with
      // rank: null, NEVER a rank invented from cell order. An unordered set of
      // acceptable activities is a different fact from a ranking, and cell order
      // is not ordering evidence: reading "Swim, Archery, Ceramics" as a top
      // three would fabricate a preference the child never stated. A tie among
      // equals stays a tie.
      const parts = raw.split(PACKED_CELL_SPLIT).map((p) => p.trim()).filter(Boolean)
      for (const part of parts) {
        cells.push({ raw: part, rank: null, rankKind: UNORDERED_SET, index: mapping.unorderedSetIndex })
      }
      // §4.1 requires the residue item as well as the null rank, and the two do
      // different jobs: the null is what the solver reads, the residue is what
      // tells a HUMAN that this camper stated no order. Without it, a sheet that
      // ranks nothing looks identical in the ledger to one that ranks
      // everything.
      if (parts.length > 1) unorderedSetRows.push({ rowNumber, count: parts.length })
    }

    const resolved = []
    for (const c of cells) {
      const verdict = resolveLabel(c.raw)
      if (verdict.status === 'matched' || verdict.status === 'abstained') {
        if (verdict.status === 'abstained') unverifiedLabels.add(c.raw)
        resolved.push(c)
        continue
      }
      const column = columnLabel(c.index)
      if (verdict.status === 'packed') {
        add(
          'AMBIGUOUS_PACKED_CELL',
          `Row ${rowNumber}, column ${column} holds “${c.raw}”, which is not an ` +
            `activity this camp has — but split up it names ${verdict.parts.length} that it does. ` +
            'That could be several alternatives packed into one choice, or one activity whose name ' +
            'contains a comma, and only you can say which, so nothing was read from this cell.',
          { rowNumber, column, label: c.raw, parts: verdict.parts }
        )
        continue
      }
      add(
        'UNRESOLVED_CHOICE_LABEL',
        `Row ${rowNumber}, column ${column} names “${c.raw}”, which is not an ` +
          'activity this camp has. It was not imported as a choice, because inventing one would ' +
          'put an activity on a schedule that does not exist.',
        { rowNumber, column, label: c.raw }
      )
    }

    // RESOLVER 2's other half — P13. A row whose preference cells resolve to NO
    // known activity is not a camper row at all: `Total Campers`, `Please
    // Return` and `Camp Office Use Only` became campers holding preferences
    // `8` and `by June 1`. No new mechanism — this is why §12.0 calls RESOLVE
    // one answer rather than five.
    //
    // Gated on having had something to resolve AGAINST. With an empty catalog
    // every label abstains rather than misses, so this would skip every row on
    // a camp's first import.
    if (resolved.length === 0) {
      if (!catalogAbsent) {
        skippedRows.push({
          rowNumber,
          reason: 'no rank cell names a known activity',
          contents: (row ?? []).map((v) => String(v ?? '').trim()).filter(Boolean),
        })
        return
      }
      if (cells.length === 0) {
        skippedRows.push({ rowNumber, reason: 'no choices on this row' })
        return
      }
    }

    const divisionLabel = cell(row, mapping?.divisionIndex) || null
    const division = resolveDivision(divisionLabel)

    const id = deriveCamperId(campId, { externalId: externalId || null, displayName: displayName || null })
    if (!byId.has(id)) {
      const camper = {
        id,
        display_name: displayName,
        external_id: externalId || null,
        // §12.2a's deliberate PAIR. `group_id` answers "which camp group is
        // this child in"; `division_label` answers "what did their file say".
        // Collapsing them into one field is how the unresolved case becomes
        // invisible again.
        division_label: divisionLabel,
        group_id: division.groupId,
        // Whether this SHEET carries a division column at all, which is a
        // different question from whether this ROW filled it in. The commit
        // needs the distinction: an empty cell in a division column is a fact
        // to record, while a sheet with no such column must not erase a
        // division an earlier import recorded.
        division_observed: mapping?.divisionIndex != null,
      }
      byId.set(id, camper)
      campers.push(camper)

      // The coverage check is available ONLY for a camper resolved to a GROUP:
      // deriveOccurrences keys occurrences on group.tier_id, and groups are the
      // single path from a camper to a tier. Stated once here rather than as an
      // increment inside each branch below, so the rule is readable without
      // scanning the chain.
      if (division.status !== 'group') unmeasuredCampers += 1

      if (division.status === 'tier') {
        add(
          'DIVISION_MATCHED_TIER',
          `${displayName || externalId}’s division “${divisionLabel}” matches the tier ` +
            `“${division.tierName}” rather than a group, so it tells us the age band but not ` +
            'which bunk. Assign them to a group to finish the picture.',
          { label: divisionLabel, camperId: id, tier: division.tierName }
        )
      } else if (division.status === 'unmatched') {
        add(
          'UNMATCHED_DIVISION',
          `${displayName || externalId}’s division reads “${divisionLabel}”, which is not a ` +
            'group or a tier this camp has. It has been kept exactly as the file wrote it, but it ' +
            'is not linked to anything — no group was created from it.',
          { label: divisionLabel, camperId: id }
        )
      }
    }

    if (displayName) {
      const nameKey = electiveChoiceLabelKey(displayName)
      if (!rowsByName.has(nameKey)) rowsByName.set(nameKey, { display_name: displayName, rows: [] })
      rowsByName.get(nameKey).rows.push({
        rowNumber,
        camperId: id,
        hasExternalId: Boolean(externalId),
        divisionLabel,
        coordinateKey: coordinateKey(coordinate),
      })
    }

    for (const c of resolved) {
      const labelKey = electiveChoiceLabelKey(c.raw)
      // First spelling seen wins for display, matching extractEntities.
      if (!choicesByKey.has(labelKey)) choicesByKey.set(labelKey, { label: c.raw, labelKey })
      candidates.push({
        camper_id: id,
        label: choicesByKey.get(labelKey).label,
        labelKey,
        rank: c.rank,
        rank_kind: c.rankKind,
        coordinate,
        rowNumber,
      })
    }
  })

  if (unorderedSetRows.length > 0) {
    const column = columnLabel(mapping.unorderedSetIndex)
    add(
      'UNORDERED_SET',
      `Column ${column} lists several activities per camper with no order between them, on ` +
        `${unorderedSetRows.length} row(s). They have been kept as equally acceptable rather than ` +
        'turned into a first, second and third choice \u2014 the file does not say which came first, ' +
        'and guessing from the order they were typed in would invent a preference nobody stated.',
      { column, index: mapping.unorderedSetIndex, rows: unorderedSetRows }
    )
  }

  for (const label of unverifiedLabels) {
    add(
      'UNVERIFIED_CHOICE_LABEL',
      `“${label}” was imported as a choice, but this camp has no activities set up yet, so ` +
        'there was nothing to check it against. Once the activity list exists, re-import to have ' +
        'these verified.',
      { label }
    )
  }

  // PASS 2 — RANK COLLISION RESOLUTION (§12.2b, §13.3). This is what makes the
  // reported count and the number of rows written ONE NUMBER: P02 reported 200
  // preferences and wrote 160, because `deriveElectivePreferenceId` omits rank
  // from its key and overwrites silently.
  //
  // THE KEY HERE IS DELIBERATELY `deriveElectivePreferenceId`'s OWN KEY —
  // (camper_id, occurrence_id, choice_id) — and not the coordinate. That is the
  // key two rows actually collide on in STORAGE, and resolving against any
  // other key would report a count that storage then disagrees with, which is
  // the very defect this pass exists to close. Consequence worth naming: until
  // a caller resolves a coordinate to an occurrence_id, two DIFFERENT cells
  // naming the SAME activity collapse onto one row. The drop is residued rather
  // than silent, which is the honest behaviour available at this layer.
  //
  // The three collisions get three treatments, and the asymmetry is the ruling:
  //   same rank, two different choices  → REFUSED (hasContradictoryRanks, below)
  //   same choice, two different ranks  → best (lowest) rank wins, drop residued
  //   same choice, one ranked one not   → the RANKED row wins, and residue names
  //                                       BOTH the drop and the rank_kind
  //                                       disagreement, because a file that said
  //                                       the same thing twice in two different
  //                                       languages is telling us something
  //                                       about itself
  // ONE container. A Map keeps first-seen insertion order and keeps it across a
  // re-set of an existing key, so the resolved set is `[...byKey.values()]` and
  // a winner swap is a single write. Holding a parallel array as well meant
  // writing every swap twice and paying an indexOf scan per collision.
  const byKey = new Map()
  for (const c of candidates) {
    const key = `${c.camper_id}\u0000${c.occurrence_id ?? ''}\u0000${c.labelKey}`
    const held = byKey.get(key)
    if (!held) {
      byKey.set(key, c)
      continue
    }
    const heldRank = held.rank
    const incoming = c.rank
    // Two unranked mentions of one choice are identical, and saying so twice is
    // not a collision worth reporting.
    if (heldRank == null && incoming == null) continue

    // An explicit rank is strictly more information than its absence.
    const incomingWins =
      heldRank == null ? incoming != null : incoming != null && incoming < heldRank
    const loser = incomingWins ? held : c
    const winner = incomingWins ? c : held

    if (incomingWins) byKey.set(key, c)

    add(
      'DROPPED_DUPLICATE_RANK',
      `${winner.label} is named more than once for the same camper and the same period. The ` +
        `stronger statement was kept (${winner.rank == null ? 'no rank' : `#${winner.rank}`}) and ` +
        `${loser.rank == null ? 'the unranked mention' : `#${loser.rank}`} on row ${loser.rowNumber} ` +
        'was dropped, so the count you see is the number of preferences actually stored.',
      {
        label: winner.label,
        camperId: winner.camper_id,
        keptRank: winner.rank,
        droppedRank: loser.rank,
        rowNumber: loser.rowNumber,
      }
    )

    if (winner.rank_kind !== loser.rank_kind) {
      add(
        'RANK_KIND_DISAGREEMENT',
        `${winner.label} appears for the same camper both as ${loser.rank_kind} and as ` +
          `${winner.rank_kind}. The file is saying the same thing twice in two different ` +
          'languages, which is usually a sign the form changed between submissions.',
        { label: winner.label, camperId: winner.camper_id, kept: winner.rank_kind, dropped: loser.rank_kind }
      )
    }
  }

  // PASS 3 — RESOLVER 4 (rows → identities), which OWNS MULTIPLICITY.
  //
  // Two classes, and they get opposite treatment (§12.3, §13.1):
  //
  //  (i) COLLAPSED — one name, ONE derived id, several rows AT THE SAME
  //      COORDINATE (or all of them lacking one). Two children sharing a name
  //      with nothing to tell them apart would be merged into one record, so
  //      this is REFUSED, as it always was.
  //
  //      THE COORDINATE DIMENSION IS NEW, AND IT IS A BLOCKER FIX. The old
  //      filter kept every name with `rowNumbers.length > 1 && ids.size === 1`,
  //      and commitElectiveRun tests it FIRST — so one camper's correctly-read
  //      18-cell planner, read as 18 rows, was REFUSED before
  //      hasContradictoryRanks was even reached. Reproduced by executing the
  //      functions, not by reading them. Rows carrying DISTINCT coordinates are
  //      one camper's per-cell answers, which is the correct reading of a grid.
  //      An absent coordinate collapses to the same empty key for every
  //      whole-run row, so T226's original behaviour is preserved EXACTLY for
  //      that shape: this is a widening of the key, not a replacement of it.
  //
  // (ii) FORKED — one name, SEVERAL derived ids, at least one row lacking an
  //      external id. Two camper records for one child holding disjoint halves
  //      of their preferences, and per the absorbed ADR's Trap 4 those rows are
  //      unremovable. RESIDUE, not a refusal: two children who genuinely share
  //      a name and ARE distinguished by an id is the CORRECT reading of that
  //      shape, and only the director can tell that case from the fork.
  //      Refusing it would punish the camps that export ids.
  const sameNameCampers = []
  for (const entry of rowsByName.values()) {
    if (entry.rows.length < 2) continue
    const ids = new Set(entry.rows.map((r) => r.camperId))

    if (ids.size > 1) {
      if (entry.rows.some((r) => !r.hasExternalId)) {
        add(
          'FORKED_IDENTITY',
          `“${entry.display_name}” appears on rows ` +
            `${entry.rows.map((r) => r.rowNumber).join(', ')} and they resolve to different ` +
            'camper records, because some carry a camper id and some do not. If those are two ' +
            'different children, this is right. If it is one child, they now hold half their ' +
            'choices each — check the divisions below and re-import with an id on every row.',
          {
            display_name: entry.display_name,
            rows: entry.rows.map((r) => ({
              rowNumber: r.rowNumber,
              divisionLabel: r.divisionLabel,
              hasExternalId: r.hasExternalId,
            })),
          }
        )
      }
      continue
    }

    // One derived id. A collision only where the rows share a coordinate.
    const byCoordinate = new Map()
    for (const r of entry.rows) {
      if (!byCoordinate.has(r.coordinateKey)) byCoordinate.set(r.coordinateKey, [])
      byCoordinate.get(r.coordinateKey).push(r)
    }
    const colliding = [...byCoordinate.values()].filter((rs) => rs.length > 1)
    if (colliding.length === 0) continue

    sameNameCampers.push({
      display_name: entry.display_name,
      rowNumbers: colliding.flat().map((r) => r.rowNumber).sort((a, b) => a - b),
      // §12.2a's consequence: the refusal sentence must name each row's
      // division alongside its row number, because the division is exactly
      // what lets a director say "those are two different kids".
      divisionLabels: colliding.flat().map((r) => r.divisionLabel),
    })
  }

  // §13.5's metric construction, carried on the result so a caller cannot
  // compute it a second, different way. The coverage check (how many cells a
  // camper should have selected) is UNAVAILABLE for a camper whose division
  // resolved to neither a group nor a tier — `deriveOccurrences` keys
  // occurrences on `group.tier_id` and SKIPS the slot when it is absent. A
  // design that raised a measured pass rate by pushing pages into the
  // unmeasured bucket must show up as a rising unmeasured count, which is why
  // this is reported BESIDE the number rather than inside it.
  const coverage = {
    measurable: unmeasuredCampers === 0 && !catalogAbsent && campers.length > 0,
    unmeasuredCampers,
    campers: campers.length,
  }

  return {
    campers,
    choices: [...choicesByKey.values()],
    preferences: [...byKey.values()],
    sameNameCampers,
    skippedRows,
    residue,
    coverage,
  }
}

/**
 * Does any camper hold the same rank twice IN THE SAME CELL?
 *
 * This is the CONSEQUENCE of a same-name collision, and the reason
 * `sameNameCampers` is a blocking decision rather than a notice. Observed on a
 * 100-row fabricated sheet: three rows naming one child produced one camper
 * with 75 preferences and three different rank-1 choices. A solver handed that
 * would resolve it by picking whichever it encountered first — a silent,
 * invisible decision about a real child's week.
 *
 * ROUND 3 CORRECTION — this function is now called on BOTH source shapes
 * (round 1's "preferenceSheet.js is out of scope" ruling was wrong and is
 * retracted). Governing this function's ORIGINAL, still-real case is a
 * WHOLE-RUN sheet (no `occurrence_id` at all, exactly what today's parser
 * emits) — there, a camper holding the same rank twice can only mean the
 * same collision this function was built to catch. But a PER-CELL sheet
 * (ADR docs/adr/2026-09-26-per-cell-elective-preferences.md, Decision 1)
 * legitimately gives the same camper rank 1 in Monday period 3 AND rank 1 in
 * Monday period 6 — two independent first choices, not a contradiction. The
 * key therefore includes the occurrence dimension: a duplicate rank WITHIN
 * one occurrence (or within the single implicit whole-run "cell", when
 * `occurrence_id` is absent from every row) is still refused; the same rank
 * across two DIFFERENT occurrences is not. An absent `occurrence_id`
 * collapses to the SAME empty component for every whole-run row, so the
 * original T226 behaviour is preserved exactly for that shape — this is a
 * widening of the key, not a replacement of it.
 *
 * T279 WIDENS THE SAME KEY ONE STEP FURTHER, for the same reason and with the
 * same care. A per-cell sheet read through THIS parser carries a `coordinate`
 * (a day/period LABEL pair) and NOT yet an `occurrence_id` — resolving a
 * coordinate to an occurrence needs a template, and no template exists at parse
 * time (`AssignmentPanel.jsx` runs the whole read before it chooses one). So a
 * correctly-read planner reaches this function with 18 rank-1 rows, an absent
 * occurrence_id on every one, and 18 distinct coordinates — and the pre-T279
 * key collapsed all 18 onto `camper\0\01` and refused the sheet. The
 * coordinate is used only as the FALLBACK for an absent occurrence_id, so a
 * resolved preference keys exactly as it did before, and a whole-run row (no
 * occurrence AND no coordinate) still yields the same empty component for every
 * row.
 *
 * The `\u0000` delimiter is load-bearing (as elsewhere in this codebase —
 * grep with `-a` to find it in a binary-unsafe search): it cannot appear in
 * a camper_id, occurrence_id or rank, so two distinct (camper_id,
 * occurrence_id, rank) triples can never collide onto the same key string.
 *
 * Kept separate from parsePreferenceSheet so the caller can show the director
 * the collision and its effect as two different sentences.
 */
export function hasContradictoryRanks({ preferences = [] } = {}) {
  const seen = new Set()
  for (const p of preferences) {
    // An UNRANKED preference cannot contradict anything, and T279 had to learn
    // this from the corpus (P10). An unordered set is a TIE AMONG EQUALS (§4.1)
    // — "Swim, Archery, Ceramics" is one camper naming three acceptable
    // activities with no ordering evidence — so several rank-null entries for
    // one camper is the CORRECT reading of that sheet, not a contradiction. The
    // pre-fix key treated every null as the same rank and refused the file with
    // "a camper holds the same preference rank twice", about a sheet that states
    // no ranks at all. Two unranked rows for one derived id are identical and
    // are already a no-op in the collision pass.
    if (p.rank == null) continue
    const scope = p.occurrence_id ?? coordinateKey(p.coordinate)
    const key = `${p.camper_id}\u0000${scope}\u0000${p.rank}`
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}
