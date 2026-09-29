// Assigning campers to elective offerings (T196, ADR D11/D14).
//
// A pure deterministic function. Plain objects in, assignments plus findings
// out — no database, no IPC, no file parsing, no writes. Same discipline as
// buildSchedule.js, a different level of the nested schedule.
//
// PER-CELL PREFERENCES (T265, 2026-09-26) — see
// docs/adr/2026-09-26-per-cell-elective-preferences.md. A real camp artifact
// (a real camp's grade-5 2024 selection sheet) shows preferences are chosen PER
// (day, period) CELL, each cell carrying its own offering list: one activity
// appears in ~15 of 18 selectable cells, so a single global "rank 1" names no
// occurrence. A camper's rank for an activity in one cell is INDEPENDENT of
// their rank for the same activity in another cell — `rankOf`/`rankByChoice`
// below store an optional per-occurrence rank plus an optional whole-run
// fallback (a preference row with no occurrence_id), read through `rankAt`
// (tier 2) and `choiceRankMinOverMembers` (tier 1), never a single flat rank
// per (camper, activity).
//
// HISTORY, KEPT SO THE MISTAKE IS NOT RE-DERIVED. This header used to read
// D14's withdrawal of the *previous* per-occurrence model as an affirmation of
// a GLOBAL one — "a camper ranks each elective once for the session, not once
// per slot" — and the code implemented that flat model for T196 through T247.
// D14 never actually established a global shape; it retired the per-occurrence
// one and said, in terms, that "no design should treat either observed format
// as confirmed input." The per-cell model above is what the artifact actually
// requires, and it is a distinct third shape from both of D14's two.
//
// PLACEMENT REMAINS UNCOUPLED ACROSS OCCURRENCES for the same reason as
// before, restated for the per-cell shape: placing a camper into Water Ski on
// Monday does not consume any preference that Wednesday's Water Ski cell
// might independently hold for them, because the two cells were never the
// same preference to begin with. Occurrences of the same activity are NOT
// coupled sub-problems, and the per-occurrence solve loop below is unchanged
// by this shift — only what a "rank" means at each lookup site changed.
//
// Three constraints:
//   1. each (camper, occurrence) gets exactly one activity
//   2. each (activity, occurrence) holds at most its capacity
//
// A THIRD CONSTRAINT WAS TRIED AND REMOVED. An earlier build also forbade a
// camper the same choice twice across the week, inferring that from D14's "a
// placement consumes that preference". That inference was wrong: "your ranking
// is counted once" and "you may never attend this again" are different rules.
// Measured on a 100-camper fixture, forbidding repeats left 332 of 2550
// camper-slots unfillable — with four offerings a period, campers ran out of
// choices they had not already used — and pushed the mean placement to rank
// 12.6 of 25. Owner ruling 2026-09-18: repeats are normal, a camper swims twice
// a week. The rule is gone, and this paragraph is why, so nobody re-derives it.
//
// APPROACH: solve occurrences in a deterministic order, each as its own
// min-cost max-flow over that camper's preferences.
//
// This is APPROXIMATE and deliberately so. A globally optimal assignment may
// beat any fixed occurrence order, and a camper unlucky early is not
// compensated later. That second property is exactly what owner ruling R4
// defers ("fairness is not modeled in this pass") — the approximation and the
// deferral are one decision, not two. Chosen for legibility: a director can be
// told "Monday period 2 filled first, and by then Water Ski was full."
// Reversible — the network lives behind this function, so an exact formulation
// replaces it without touching callers.
//
// WITHIN an occurrence the assignment is OPTIMAL, not greedy: minCostAssign
// below is a real min-cost max-flow (successive shortest paths). Greedy-by-rank
// passes almost every test in the suite and loses on total cost; the
// distinguishing case is pinned in the test file.

// TWO TIERS, ONE SOLVER (T247, ADR 2026-09-23 decision (c)).
//
// A linked choice is a set of occurrences a camper takes together or not at all
// (`elective_choices` + `elective_choice_offerings`). TIER 1 solves those as
// their own bipartite problem — rows = campers who ranked such a choice,
// columns = the linked choices, capacity[C] = min over C's member occurrences of
// that occurrence's remaining capacity — and expands each placement to one row
// per member occurrence. TIER 2 is the per-occurrence loop above, unchanged in
// its own logic, running against the capacity tier 1 left and treating
// tier-1-placed campers as pre-placed, through the SAME mechanism locked seats
// use.
//
// TIER 1's RANK IS A MIN-FOLD OVER MEMBER OCCURRENCES (T265 round 4). Since
// preferences are per-cell, a camper may rank a linked choice differently in
// each member occurrence it appears in. `minCostAssign` needs one scalar rank
// per column, so `rank(camper, choice)` is the MINIMUM (best) rank across the
// rows relevant to that choice — its own member occurrences, plus any
// unscoped whole-run fallback row (`choiceRankMinOverMembers`). An unranked
// member occurrence is silent: not a vote against, not UNRANKED_COST, not an
// exclusion — partial coverage still leaves the camper a `wants()` candidate.
// This is a READ-TIME derivation of a rank the camper actually gave, not a new
// cost term: it does not touch owner ruling Q3 (score each placement
// independently, no cross-occurrence discount for repetition). Order-
// independent by construction (min, not first/last-seen).
//
// WHY A SECOND BIPARTITE PASS AND NOT A CHAIN. The first design for this was a
// flow chain `camper -> choiceNode(C) -> o1 -> o2 -> sink`. It is wrong, not
// merely approximate: the `o1 -> o2` edge exists once per CHOICE, so its
// capacity-1 edge caps every linked choice at one camper camp-wide. Counter-
// example, from the ADR: C = {o1, o2} with capacity 15 each, two campers both
// ranking C — the chain places one and reports the other NO_CAPACITY with 14
// seats open at each occurrence. It is also not expressible here at all:
// minCostAssign takes one capacity scalar per column and has no notion of an
// edge BETWEEN columns. So `minCostAssign` is reused UNMODIFIED, called twice.
//
// WHAT THIS CANNOT DO, and must therefore refuse rather than mis-solve: two
// linked choices sharing a member occurrence. capacity[C1] and capacity[C2] are
// independent scalars that cannot jointly bound the shared occurrence's one real
// capacity. That case raises UNSUPPORTED_LINKED_CHOICE and both choices drop to
// tier 2. Fixing it properly is a general graph solver (ADR candidate (1)),
// deferred by the ADR and not to be built here.
//
// KNOWN, OWNER-ACCEPTED DIVERGENCE FROM D11 — do not "fix" this as a bug.
// Two sequential passes never compare a linked choice against an unlinked
// preference inside one cost function, so D11's joint-optimality guarantee does
// not hold across the tier boundary. Exactly one camper shape is affected: one
// who ranks BOTH a linked choice AND a scarce unlinked activity. Owner ruling Q6
// (2026-09-23) accepted this for this slice and recorded the revisit trigger:
// real catalog data from T218/T219 showing linked choices are common and overlap
// with scarce unlinked demand.

// Cost of placing a camper into a choice they did not rank. Above any real
// rank (a 25-choice form tops out at 25), so every ranked option is preferred
// to every unranked one, while an unranked placement still beats leaving a
// camper out — owner ruling R3, never unplaced.
const UNRANKED_COST = 1000

// LOCKED SEATS AND THE LINKED-CHOICE CONTRACT (T246). `lockedAssignments`
// holds placements a director made by hand and locked. This function never
// re-decides one: the locked camper is removed from the free-variable set for
// that occurrence, the seat is subtracted from the matching offering's
// remaining capacity, and the placement is emitted back unchanged.
//
// THE CONTRACT T247 MUST READ. The linked-choice bipartite tier T247 adds
// (tier 1) must consume the SAME lockedAssignments-adjusted remaining
// capacity this function computes, never the raw offering capacity:
// `capacity[choice] = min(over member occurrences of the choice) of that
// occurrence's remaining capacity AFTER locked seats are subtracted`. A tier 1
// that reads raw capacity would place a camper into a linked choice whose
// member occurrence is already spoken for by a lock, and the lock would then
// have to be broken to honour it.

/**
 * @param {object} input
 * @param {{id: string}[]} input.campers
 * @param {{id: string}[]} input.occurrences      solved in ascending id order
 * @param {{occurrence_id, labelKey, activity_id, capacity}[]} input.offerings
 * @param {{camper_id, labelKey, choice_id?, occurrence_id?, rank}[]} input.preferences
 *        rank is 1-based, lower is better. `occurrence_id` is OPTIONAL (T265):
 *        a row naming one applies ONLY to that occurrence; a row with none is
 *        a whole-run fallback used for any occurrence with no scoped row for
 *        that (camper, labelKey/choice_id). Mixing scoped and unscoped rows is
 *        legal. An occurrence-scoped row never becomes a fallback for a
 *        different occurrence.
 * @param {Record<string, string[]>} [input.attendance]  camper id -> occurrence ids;
 *        default: every camper attends every occurrence.
 * @param {{camperId, occurrenceId, activityId}[]} [input.lockedAssignments]  seats a
 *        director locked, never re-decided here. camelCase while the rest of this
 *        function's inputs are snake_case — T246's chosen shape, kept as specified.
 * @param {{id, labelKey, is_linked?}[]} [input.choices]  mirrors elective_choices
 * @param {{choice_id, occurrence_id, activity_id}[]} [input.choiceOfferings]  mirrors
 *        elective_choice_offerings. A choice with MORE THAN ONE member occurrence here
 *        is linked and goes through tier 1; everything else is tier 2's, as before.
 * @returns {{assignments: object[], findings: object[]}}
 */
export function buildElectiveAssignments({
  campers = [],
  occurrences = [],
  offerings = [],
  preferences = [],
  attendance = null,
  lockedAssignments = [],
  choices = [],
  choiceOfferings = [],
} = {}) {
  const assignments = []
  const findings = []

  // Every ordering below is a total order over stable ids, never the iteration
  // order of an input array or a Map — the determinism property.
  const camperIds = campers.map((c) => c.id).sort()
  const occurrenceIds = occurrences.map((o) => o.id).sort()
  const occurrenceIdSet = new Set(occurrenceIds)

  const choiceById = new Map(choices.map((c) => [c.id, c]))
  // Ties on labelKey resolve to the lowest choice id, never to input order.
  const choiceByLabelKey = new Map()
  for (const c of [...choices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!choiceByLabelKey.has(c.labelKey)) choiceByLabelKey.set(c.labelKey, c)
  }
  // T301 (docs/adr/2026-09-29-linked-elective-bundles.md D4) — ALL choices
  // sharing a label, not just the lowest-id one. A bundle serving more than
  // one tier expands into one elective_choices row PER TIER (D3), and every
  // tier's row deliberately shares the bundle's one name (D6), so a
  // labelKey-only preference must reach every one of them — see the
  // preference loop below, which is the only reader of this map.
  const choicesByLabelKey = new Map()
  for (const c of choices) {
    if (!choicesByLabelKey.has(c.labelKey)) choicesByLabelKey.set(c.labelKey, [])
    choicesByLabelKey.get(c.labelKey).push(c)
  }
  const labelOfChoice = (id) => choiceById.get(id)?.labelKey ?? id

  // PREFERENCE -> CHOICE RESOLUTION, both ways, for a compatibility reason.
  // T247's ticket says to read `preferences` as pointing at `choice_id` — the
  // schema's own shape. But every existing caller and every pre-T247 test in
  // this repo keys a preference by `labelKey`, and nothing in production passes
  // `choices` at all yet. So a preference resolves to a choice by `choice_id`
  // when it names one this run knows, and by `labelKey` otherwise. A
  // choice_id-only preference also registers its choice's labelKey in rankOf,
  // so tier 2 costs it exactly as it costs a labelKey preference.
  // OCCURRENCE-AWARE RANK STORAGE (T265 round 4). Each (camper, labelKey) or
  // (camper, choiceId) key holds `{ byOccurrence: Map<occurrenceId, rank>,
  // fallback: rank|null }`. A row naming an occurrence_id applies ONLY to that
  // occurrence; a row with none is a whole-run fallback used for any
  // occurrence with no scoped row for that key. `rankAt` (tier 2) and
  // `choiceRankMinOverMembers` (tier 1, below) are the only readers, so an
  // occurrence-scoped rank can never leak into a different cell and a
  // fallback never overrides a more specific scoped row for the occurrence
  // it names.
  const rankOf = new Map()            // camperId -> Map(labelKey -> entry)
  const rankByChoice = new Map()      // camperId -> Map(choiceId -> entry)

  const entryFor = (map, camperId, key) => {
    if (!map.has(camperId)) map.set(camperId, new Map())
    const byKey = map.get(camperId)
    if (!byKey.has(key)) byKey.set(key, { byOccurrence: new Map(), fallback: null })
    return byKey.get(key)
  }
  // T285 — BOTH SCOPES FOLD TO THE BEST (LOWEST) RANK. `entry.fallback = rank`
  // was a bare assignment, so the LAST whole-run row seen won: a camper naming
  // Swim at #1 and again at #5 ended up holding rank 5 for Swim and losing to a
  // #2 they had ranked WORSE.
  //
  // Three things agreed against it and it contradicted all of them: its own
  // sibling `choiceRankMinOverMembers` (below) folds to the minimum; ADR §12.2b
  // rules "best (lowest) rank wins" for exactly this collision; and the parser
  // already implements that ruling. The engine must be right on its own terms
  // rather than relying on a caller to pre-clean its input — the parser
  // de-duplicates this today, but `buildElectiveAssignments` is a pure exported
  // function with other callers and tests.
  //
  // The occurrence-scoped side gets the same fold for the same reason: two rows
  // naming one choice in one cell is the same collision, one scope down.
  const better = (held, rank) => (held == null || (rank != null && rank < held) ? rank : held)
  const record = (entry, occurrenceId, rank) => {
    if (occurrenceId != null) {
      entry.byOccurrence.set(occurrenceId, better(entry.byOccurrence.get(occurrenceId) ?? null, rank))
    } else {
      entry.fallback = better(entry.fallback, rank)
    }
  }
  const rankAt = (camperId, occurrenceId, labelKey) => {
    const entry = rankOf.get(camperId)?.get(labelKey)
    if (!entry) return null
    return entry.byOccurrence.has(occurrenceId) ? entry.byOccurrence.get(occurrenceId) : entry.fallback
  }
  // TIER 1's min-fold over a choice's MEMBER occurrences (T265 round 4).
  // `rankByChoice` above stores raw occurrence-scoped rows, same shape as
  // `rankOf` — it is NOT folded at parse time, because folding requires
  // knowing which occurrence rows are RELEVANT to a choice, and that is only
  // known once `choiceOfferings` is read (in runLinkedChoiceTier, below).
  // Relevant = a row scoped to one of the choice's own member occurrences, or
  // an unscoped whole-run fallback row. A row scoped to some OTHER occurrence
  // (one not a member of this choice) is excluded from the fold simply by not
  // being in `memberOccurrenceIds` — no explicit guard needed, the iteration
  // itself is the filter. Returns the MINIMUM (best) rank, or null if the
  // camper has no relevant rank at all for this choice.
  const choiceRankMinOverMembers = (camperId, choiceId, memberOccurrenceIds) => {
    const entry = rankByChoice.get(camperId)?.get(choiceId)
    if (!entry) return null
    let best = entry.fallback
    for (const occurrenceId of memberOccurrenceIds) {
      if (!entry.byOccurrence.has(occurrenceId)) continue
      const rank = entry.byOccurrence.get(occurrenceId)
      if (best == null || rank < best) best = rank
    }
    return best
  }

  for (const p of preferences) {
    const ch = (p.choice_id != null ? choiceById.get(p.choice_id) : undefined)
      ?? (p.labelKey != null ? choiceByLabelKey.get(p.labelKey) : undefined)
      ?? null
    const labelKey = p.labelKey ?? ch?.labelKey ?? null
    if (labelKey != null) {
      record(entryFor(rankOf, p.camper_id, labelKey), p.occurrence_id ?? null, p.rank)
    }
    // T301 ADR D4 — an explicit choice_id preference still resolves to
    // exactly one choice, unambiguous by construction. A labelKey-only
    // preference instead broadcasts to EVERY choice sharing that label, so
    // choiceRankMinOverMembers (tier 1) finds it regardless of which tier's
    // expansion it is asked about — see choicesByLabelKey's own comment
    // above for why one label can name more than one choice.
    //
    // GATED ON choiceById.has(p.choice_id), NOT on `ch`'s truthiness (found
    // while implementing D4, beyond the ADR's own stated caveat). `ch` also
    // goes true when choice_id is present but STALE — resolves to nothing in
    // THIS run's choices, which a re-solve after choices were re-derived can
    // produce — and falls through to the labelKey match instead. Checking
    // `ch` there cannot tell "resolved DIRECTLY by choice_id" apart from
    // "fell through to labelKey while a stale choice_id rode along", and
    // would take the single-choice branch instead of broadcasting — the
    // exact collision this fix exists to close, reappearing behind one more
    // precondition. An explicit, VALID (but semantically wrong) choice_id is
    // still untouched, exactly as the ADR intends: that path resolves via
    // this same `.has()` check and stays exactly-one-match.
    if (p.choice_id != null && choiceById.has(p.choice_id)) {
      record(entryFor(rankByChoice, p.camper_id, ch.id), p.occurrence_id ?? null, p.rank)
    } else if (p.labelKey != null) {
      for (const c of choicesByLabelKey.get(p.labelKey) ?? []) {
        record(entryFor(rankByChoice, p.camper_id, c.id), p.occurrence_id ?? null, p.rank)
      }
    }
  }
  const attends = (camperId, occurrenceId) =>
    attendance ? (attendance[camperId] ?? []).includes(occurrenceId) : true

  // PRE-PLACEMENT — ONE mechanism, two producers: T246's locked seats and
  // T247's tier 1. An entry removes the camper from that occurrence's
  // free-variable set and subtracts one seat from the matching offering's
  // remaining capacity. `row(here)` is what gets emitted, so a locked seat
  // keeps source:'manual'/locked:true while a tier-1 placement is an ORDINARY
  // solver row — no `source`, no `locked`, flags computed as tier 2 computes
  // them. Tier 1 does not re-implement any of this.
  const prePlacedByOccurrence = new Map()
  const prePlace = (occurrenceId, camperId, activityId, row) => {
    if (!prePlacedByOccurrence.has(occurrenceId)) prePlacedByOccurrence.set(occurrenceId, [])
    prePlacedByOccurrence.get(occurrenceId).push({ camperId, activityId, row })
  }

  // Grouped through a sort over stable ids, never the input array's order —
  // the same determinism property as camperIds/occurrenceIds above.
  for (const l of [...lockedAssignments].sort((a, b) =>
    a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1
      : a.camperId < b.camperId ? -1 : a.camperId > b.camperId ? 1 : 0
  )) {
    prePlace(l.occurrenceId, l.camperId, l.activityId, (here) => {
      const o = here.find((x) => x.activity_id === l.activityId) ?? null
      return {
        camper_id: l.camperId,
        occurrence_id: l.occurrenceId,
        labelKey: o?.labelKey ?? null,
        activity_id: l.activityId,
        preference_rank: (o && rankAt(l.camperId, l.occurrenceId, o.labelKey)) ?? null,
        flags: [],
        source: 'manual',
        locked: true,
      }
    })
  }

  runLinkedChoiceTier()

  for (const occurrenceId of occurrenceIds) {
    const here = offerings
      .filter((o) => o.occurrence_id === occurrenceId)
      .sort((a, b) => (a.labelKey < b.labelKey ? -1 : a.labelKey > b.labelKey ? 1 : 0))
    const prePlacedHere = prePlacedByOccurrence.get(occurrenceId) ?? []
    const prePlacedCampers = new Set(prePlacedHere.map((e) => e.camperId))
    // NO_CAMPERS below is answered from `eligible`, not from the free set: a
    // period where every camper is already pre-placed (all locked, or all taken
    // by a linked choice) is finished, not unattendable. DISCLOSED DEVIATION —
    // not named in T247's archive_when, but forced by tier 1, and it also
    // repairs a pre-existing locks-only instance of the same bug: before T247, a
    // period where every eligible camper held a locked seat already reported
    // "no camper is eligible for this period", which was equally untrue.
    const eligible = camperIds.filter((id) => attends(id, occurrenceId))
    const who = eligible.filter((id) => !prePlacedCampers.has(id))

    // A pre-placed seat is emitted as-is so a caller's preview still shows the
    // camper. ABOVE both early-exit guards below, which `continue`: a lock in
    // an occurrence that has lost all its offerings must still be emitted, and
    // neither guard's diagnostic is weakened to make that happen.
    // A locked row naming an activity this occurrence does not offer is emitted
    // but accounted against nothing — this function is pure and does not
    // diagnose stale rows; DANGLING_MANUAL_ASSIGNMENT in commitElectiveRun is
    // where that is reported.
    for (const e of prePlacedHere) assignments.push(e.row(here))

    // T231 — say so, rather than skipping quietly. This branch used to
    // `continue` with no finding, so an occurrence nobody could attend
    // produced a clean empty result indistinguishable from "no work to do".
    // Found by a real-data probe where a malformed attendance map made every
    // camper ineligible: zero assignments, zero findings, no error. The
    // realistic version is a camp whose division names do not match their tier
    // names — the director gets an empty schedule and no reason for it.
    if (here.length === 0) {
      findings.push({
        kind: 'NO_OFFERINGS',
        occurrence_id: occurrenceId,
        message: 'Nothing is offered in this period, so nobody was placed in it.',
      })
      continue
    }
    if (eligible.length === 0) {
      findings.push({
        kind: 'NO_CAMPERS',
        occurrence_id: occurrenceId,
        message:
          'No camper is eligible for this period — check that the divisions on the sheet match the ' +
          'camp\u2019s division names.',
      })
      continue
    }

    // MINIMUM TO RUN (T265) — a SECOND PHASE, not a constraint inside the solve.
    // Owner ruling 2026-09-26: you cannot know an offering is short until
    // everyone has been placed, so placement runs first and the minimum is
    // validated against the result.
    //
    // `o.minimum` is null or an integer >= 1, never 0 — the DB CHECK rejects 0 and
    // resolveOfferingMinimum is the only producer, which is what lets a single
    // engine-side field stand in for the stored two-part (min_mode, min_to_run)
    // pair without reintroducing D3's hazard. The guarantee is enforced at those
    // two sites and tested there; it is deliberately NOT re-asserted here, because
    // `enrolled >= 0` is a tautology and a 0 would be inert anyway. A comment
    // claiming this line defends the invariant would be claiming more than the
    // code does.
    const capacityAt = (j) => Math.max(0, here[j].capacity ?? 0)
    // A pre-placed seat (a locked seat, or a tier-1 linked-choice placement)
    // occupies capacity and COUNTS toward the minimum.
    const prePlacedAt = (j) => prePlacedHere.filter((e) => e.activityId === here[j].activity_id).length

    // Column indices that did not make their minimum. A cancelled column is
    // forbidden to every row, so nobody can be placed back into it.
    const cancelled = new Set()
    const seat = new Map() // camperId -> column index

    const seatedAt = (j) => {
      let n = 0
      for (const j2 of seat.values()) if (j2 === j) n += 1
      return n
    }
    const remainingCapacity = () =>
      here.map((_, j) => Math.max(0, capacityAt(j) - prePlacedAt(j) - seatedAt(j)))

    // Places `rowCamperIds` into the surviving columns, optimally, against the
    // capacity left. UNRANKED_COST is kept so owner ruling R3 still holds for a
    // cascading camper: seated in something they did not ask for beats left out.
    const solveInto = (rowCamperIds, remaining) => {
      const cost = rowCamperIds.map((camperId) =>
        here.map((o, j) => {
          if (cancelled.has(j)) return null
          const rank = rankAt(camperId, occurrenceId, o.labelKey)
          return rank == null ? UNRANKED_COST : rank
        })
      )
      const placed = minCostAssign(cost, remaining)
      rowCamperIds.forEach((camperId, i) => {
        if (placed[i] != null) seat.set(camperId, placed[i])
      })
    }

    solveInto(who, remainingCapacity())

    // A pre-placed seat is never re-decided (T246 for a locked seat; a tier-1
    // linked choice is taken as a set or not at all), so an offering holding one
    // cannot be emptied and is therefore not cancellable — the loop below skips
    // it, and the pass after the loop reports it.
    const shortfallAt = (j) => {
      const minimum = here[j].minimum
      if (minimum == null) return null
      const enrolled = prePlacedAt(j) + seatedAt(j)
      return enrolled >= minimum ? null : { j, enrolled, minimum, shortfall: minimum - enrolled }
    }

    // THE CASCADE. One cancellation per round, furthest below its own minimum
    // first (owner ruling 2026-09-26) — cancelling the least rescuable offering
    // releases the most campers to rescue the ones that are close, and it is
    // explainable to a director in one sentence. Cancelling every short offering
    // at once instead would decline both halves of the ticket's Archery/Fishing
    // case and leave nothing running.
    //
    // IT TERMINATES, and the argument depends on only the displaced campers
    // moving. A survivor keeps its seat, so a column's headcount is monotonically
    // non-decreasing and nothing that already passed its minimum can later fail
    // it. Each round cancels exactly one column, so the loop is bounded by
    // `here.length` and cannot oscillate. Re-solving EVERY camper each round
    // would be optimal per round and would break this: the solver would be free
    // to move a survivor out of a column that had already passed, dropping it
    // below its minimum again.
    let declinedAny = false
    for (;;) {
      const cancellable = []
      for (let j = 0; j < here.length; j++) {
        if (cancelled.has(j) || prePlacedAt(j) > 0) continue
        const s = shortfallAt(j)
        if (s) cancellable.push(s)
      }
      if (cancellable.length === 0) break

      // Largest shortfall first; ties by activity_id, a stable identifier, so
      // the outcome never depends on input or Map order.
      cancellable.sort((a, b) =>
        b.shortfall - a.shortfall ||
        (here[a.j].activity_id < here[b.j].activity_id ? -1
          : here[a.j].activity_id > here[b.j].activity_id ? 1 : 0)
      )
      const worst = cancellable[0]
      cancelled.add(worst.j)
      declinedAny = true
      findings.push({
        kind: 'BELOW_MINIMUM',
        occurrence_id: occurrenceId,
        activity_id: here[worst.j].activity_id,
        labelKey: here[worst.j].labelKey,
        enrolled: worst.enrolled,
        minimum: worst.minimum,
        shortfall: worst.shortfall,
        message:
          `“${here[worst.j].labelKey}” had ${worst.enrolled} of the ${worst.minimum} ` +
          'campers it needs to run, so it did not run. Those campers were moved to their next ' +
          'choice.',
      })

      const displaced = [...seat.entries()]
        .filter(([, j]) => j === worst.j)
        .map(([camperId]) => camperId)
        .sort()
      for (const camperId of displaced) seat.delete(camperId)
      solveInto(displaced, remainingCapacity())
    }

    // REPORTED ONCE, AFTER THE LOOP HAS SETTLED, and that timing is the whole
    // point. Anything still short here holds a pre-placed seat, so it ran anyway
    // — and saying so matters, because an offering quietly under its minimum is
    // the silent wrongness this ticket removes.
    //
    // Reporting it INSIDE the loop instead forces a choice between re-emitting it
    // every round and excluding it from further placement, and excluding it blocks
    // a cascade from rescuing it — then reports a shortfall the engine itself
    // prevented from being fixed. Since it stays open, campers released by a later
    // cancellation can still fill it, and if they do it is no longer short and
    // nothing is reported. Pinned by the rescue test in electiveMinimumToRun.test.js.
    for (let j = 0; j < here.length; j++) {
      if (cancelled.has(j)) continue
      const s = shortfallAt(j)
      if (!s) continue
      findings.push({
        kind: 'KEPT_BELOW_MINIMUM',
        occurrence_id: occurrenceId,
        activity_id: here[j].activity_id,
        labelKey: here[j].labelKey,
        enrolled: s.enrolled,
        minimum: s.minimum,
        shortfall: s.shortfall,
        message:
          `“${here[j].labelKey}” has ${s.enrolled} of the ${s.minimum} campers it ` +
          'needs to run, but it holds a seat that was set by hand, so it was kept as it is. ' +
          'Lower its minimum, or move that seat, and run this again.',
      })
    }

    const unplaced = []
    for (const camperId of who) {
      const j = seat.get(camperId)
      if (j == null) {
        unplaced.push(camperId)
        continue
      }
      const o = here[j]
      const rank = rankAt(camperId, occurrenceId, o.labelKey) ?? null
      const flags = []
      if (rank == null) flags.push('NOT_REQUESTED')
      else if (rank > 1) flags.push('NOT_TOP_CHOICE')
      assignments.push({
        camper_id: camperId,
        occurrence_id: occurrenceId,
        labelKey: o.labelKey,
        activity_id: o.activity_id,
        preference_rank: rank,
        flags,
      })
    }

    if (unplaced.length > 0) {
      // Two different reasons, two findings, because the director acts on them
      // differently: "everything is full" means add capacity, "your offering
      // came off" means lower a minimum. Collapsing them into the existing
      // NO_CAPACITY message would tell a director every offering was full when
      // the real cause was a cancellation.
      findings.push(declinedAny
        ? {
          kind: 'UNPLACED_AFTER_DECLINE',
          occurrence_id: occurrenceId,
          camper_ids: unplaced.sort(),
          message:
            `${unplaced.length} camper(s) had nowhere left to go after an offering did not run — ` +
            'they had no other choice in this period with room in it.',
        }
        : {
          kind: 'NO_CAPACITY',
          occurrence_id: occurrenceId,
          camper_ids: unplaced.sort(),
          message: `${unplaced.length} camper(s) could not be placed — every offering in this period is full.`,
        })
    }
  }

  assignments.sort((a, b) =>
    a.occurrence_id < b.occurrence_id ? -1 : a.occurrence_id > b.occurrence_id ? 1
      : a.camper_id < b.camper_id ? -1 : a.camper_id > b.camper_id ? 1 : 0
  )
  // `runLinkedChoiceTier`, called near the top, is declared BELOW this return —
  // the ~150 lines after it are reachable, not dead code.
  return { assignments, findings }

  // ---- TIER 1 (T247): the choice-level bipartite pass.
  //
  // Runs before the per-occurrence loop above and reaches it only by adding
  // pre-placements, so tier 2's own logic is untouched. Declared here, after
  // the return, to keep the reading order of the existing function intact.
  function runLinkedChoiceTier() {
    const membersByChoice = new Map()
    for (const m of choiceOfferings) {
      if (!choiceById.has(m.choice_id)) continue
      if (!membersByChoice.has(m.choice_id)) membersByChoice.set(m.choice_id, [])
      membersByChoice.get(m.choice_id).push(m)
    }
    const membersOf = (id) =>
      [...membersByChoice.get(id)].sort((a, b) =>
        a.occurrence_id < b.occurrence_id ? -1 : a.occurrence_id > b.occurrence_id ? 1
          : a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0
      )
    const occurrencesOf = (id) => [...new Set(membersOf(id).map((m) => m.occurrence_id))]

    // "Linked" is MORE THAN ONE member occurrence — the ticket's definition.
    // Deliberately NOT the `is_linked` column: nothing in this repo writes it as
    // 1 (commitElectiveRun hardcodes 0), so reading it would leave this tier
    // permanently dead.
    const linked = [...membersByChoice.keys()].filter((id) => occurrencesOf(id).length > 1).sort()
    if (linked.length === 0) return

    // A refused choice is dropped from tier 1 entirely; its campers fall
    // through to tier 2 as ordinary per-occurrence rows, so they are still
    // placed — just one period at a time instead of as a set.
    const refused = new Set()

    // (a) A member names an occurrence this run does not contain. A data
    // problem, and the message reads as one.
    for (const id of linked) {
      const outside = membersOf(id)
        .filter((m) => !occurrenceIdSet.has(m.occurrence_id))
        .map((m) => m.occurrence_id)
      if (outside.length === 0) continue
      refused.add(id)
      findings.push({
        kind: 'UNSUPPORTED_LINKED_CHOICE',
        choice_ids: [id],
        occurrence_ids: [...new Set(outside)].sort(),
        message:
          `\u201c${labelOfChoice(id)}\u201d is meant to be taken as a set, but it lists a period ` +
          'that is not part of this run. Its periods were filled one at a time instead of together.',
      })
    }

    // (c) Two linked choices sharing a member occurrence. NOT a data problem —
    // an implementation limit of this two-tier construction, and the message
    // says so plainly rather than sending a director looking for bad data.
    // Only over choices that SURVIVED case (a): refusing a live choice for
    // sharing a period with one already refused for naming an out-of-run
    // occurrence is a false positive, on a finding whose whole job is to be
    // trustworthy.
    const byOccurrence = new Map()
    for (const id of linked.filter((id) => !refused.has(id))) {
      for (const occurrenceId of occurrencesOf(id).sort()) {
        if (!byOccurrence.has(occurrenceId)) byOccurrence.set(occurrenceId, [])
        byOccurrence.get(occurrenceId).push(id)
      }
    }
    for (const occurrenceId of [...byOccurrence.keys()].sort()) {
      const sharing = [...byOccurrence.get(occurrenceId)].sort()
      if (sharing.length < 2) continue
      for (const id of sharing) refused.add(id)
      findings.push({
        kind: 'UNSUPPORTED_LINKED_CHOICE',
        choice_ids: sharing,
        occurrence_id: occurrenceId,
        message:
          `${sharing.map((id) => `\u201c${labelOfChoice(id)}\u201d`).join(' and ')} share a period. ` +
          'Holding that shared period\u2019s seats for more than one set at once is a limit of the ' +
          'scheduler, not a problem with your data \u2014 each set is counted on its own. They were ' +
          'filled one period at a time instead of together.',
      })
    }

    const columns = linked.filter((id) => !refused.has(id))
    if (columns.length === 0) return

    // (b) The camper cannot be given the set AS a set. Two reasons, both
    // "structurally ineligible for a member occurrence" in the ADR's terms, so
    // both are case (b) rather than a fourth finding kind:
    //
    //   b1  they do not attend every period the set covers;
    //   b2  they already hold a pre-placement in one of those periods. A seat
    //       placed by hand and locked STANDS AND WINS — it is never re-decided
    //       here (T246). Without this, tier 1 placed the camper into the choice
    //       anyway and the engine emitted two rows for one (camper,
    //       occurrence), breaking constraint 1 in this module's header. Worse
    //       downstream: deriveElectiveAssignmentId keys on (run, camper,
    //       occurrence) and excludes activity_id, so the two rows collide on one
    //       id and both are dropped, while the camper's OTHER member row is
    //       written — leaving them attending half a linked choice on a seat they
    //       consumed. Found by round-2 review, confirmed by execution.
    //
    // `prePlacedByOccurrence` holds only locked seats at this point (tier 1 has
    // not placed anything yet), and tier 1 cannot collide with itself: a row
    // takes at most one column, and two columns sharing an occurrence are
    // already refused by case (c) above. The check is written against the map
    // rather than against lockedAssignments so it stays true of any future
    // producer of a pre-placement.
    const holdsSeatAt = (camperId, occurrenceId) =>
      (prePlacedByOccurrence.get(occurrenceId) ?? []).some((e) => e.camperId === camperId)

    const excluded = new Map() // choiceId -> Set(camperId)
    const exclude = (id, camperIds_, message) => {
      if (camperIds_.length === 0) return
      if (!excluded.has(id)) excluded.set(id, new Set())
      for (const c of camperIds_) excluded.get(id).add(c)
      findings.push({
        kind: 'UNSUPPORTED_LINKED_CHOICE',
        choice_ids: [id],
        camper_ids: camperIds_,
        message,
      })
    }
    for (const id of columns) {
      const occs = occurrencesOf(id)
      const wanted = camperIds.filter((c) => choiceRankMinOverMembers(c, id, occs) != null)
      const absent = wanted.filter((c) => !occs.every((o) => attends(c, o)))
      exclude(id, absent,
        `${absent.length} camper(s) asked for \u201c${labelOfChoice(id)}\u201d but do not attend ` +
        'every period it covers. They were placed one period at a time instead of together.')
      const held = wanted.filter((c) => !absent.includes(c) && occs.some((o) => holdsSeatAt(c, o)))
      exclude(id, held,
        `${held.length} camper(s) asked for \u201c${labelOfChoice(id)}\u201d but already have a ` +
        'seat set by hand in one of the periods it covers. The seat set by hand was kept, so the ' +
        'set could not be given to them as a set; they were placed one period at a time instead.')
    }

    // MIN-FOLD (T265 round 4): `rank(camper, choice)` is the MINIMUM (best)
    // rank the camper gave across the choice's own member occurrences, plus
    // any unscoped whole-run fallback row — `choiceRankMinOverMembers` above.
    // A member occurrence with no rank at all is silent: not a vote against,
    // not UNRANKED_COST, not an exclusion. Partial coverage still leaves the
    // camper a `wants()` candidate, at the best rank they DID give.
    const wants = (camperId, id) =>
      choiceRankMinOverMembers(camperId, id, occurrencesOf(id)) != null && !excluded.get(id)?.has(camperId)
    const rows = camperIds.filter((c) => columns.some((id) => wants(c, id)))
    if (rows.length === 0) return

    // A forbidden pairing is `null`, never UNRANKED_COST. UNRANKED_COST exists
    // so R3 ("never unplaced") can seat a camper in something they did not ask
    // for; that has no meaning here, because a linked choice is a commitment
    // across several periods and tier 2 is what guarantees the camper is placed
    // at all. An unranked cell is therefore unreachable as a placement by
    // construction, and forbidding it keeps it that way.
    const cost = rows.map((camperId) =>
      columns.map((id) => (wants(camperId, id) ? choiceRankMinOverMembers(camperId, id, occurrencesOf(id)) : null))
    )

    // THE T246 CONTRACT: the min() is over remaining capacity AFTER locked
    // seats, never raw offering capacity. A member occurrence that offers
    // nothing for the choice's activity contributes 0, which makes the choice
    // unplaceable in tier 1 — an ordinary capacity outcome, not a finding.
    const seatsLeft = new Map()
    for (const o of offerings) {
      if (!occurrenceIdSet.has(o.occurrence_id)) continue
      seatsLeft.set(`${o.occurrence_id}\u0000${o.activity_id}`, Math.max(0, o.capacity ?? 0))
    }
    for (const [occurrenceId, entries] of prePlacedByOccurrence) {
      for (const e of entries) {
        const k = `${occurrenceId}\u0000${e.activityId}`
        if (seatsLeft.has(k)) seatsLeft.set(k, Math.max(0, seatsLeft.get(k) - 1))
      }
    }
    const capacity = columns.map((id) =>
      Math.min(...membersOf(id).map((m) => seatsLeft.get(`${m.occurrence_id}\u0000${m.activity_id}`) ?? 0))
    )

    const placed = minCostAssign(cost, capacity)

    rows.forEach((camperId, i) => {
      const j = placed[i]
      if (j == null) return
      const id = columns[j]
      const rank = choiceRankMinOverMembers(camperId, id, occurrencesOf(id))
      for (const m of membersOf(id)) {
        // EMITTED SHAPE: an ordinary solver row, identical in shape to tier 2's
        // own output — no `source`, no `locked`. These are solver decisions, not
        // a director's. NOT_REQUESTED is unreachable here: the row exists
        // because the camper ranked this choice, so `rank` is never null.
        prePlace(m.occurrence_id, camperId, m.activity_id, () => ({
          camper_id: camperId,
          occurrence_id: m.occurrence_id,
          labelKey: labelOfChoice(id),
          activity_id: m.activity_id,
          preference_rank: rank,
          flags: rank > 1 ? ['NOT_TOP_CHOICE'] : [],
        }))
      }
    })
  }
}

/**
 * Min-cost max-flow assignment of rows (campers) to columns (offerings).
 *
 * `cost[i][j]` is the cost of row i in column j, or null where the pairing is
 * forbidden. `capacity[j]` is how many rows column j accepts. Returns an array
 * of column indices (or null) per row.
 *
 * Successive shortest paths with Bellman-Ford. Costs are non-negative so
 * Dijkstra with potentials would be faster, but a camp's elective period is
 * tens of campers over tens of offerings, and Bellman-Ford is the version whose
 * correctness is obvious on inspection. Ties break toward the lower column
 * index, and rows are processed in order, so the result is deterministic.
 */
function minCostAssign(cost, capacity) {
  const rows = cost.length
  const cols = capacity.length
  const result = new Array(rows).fill(null)
  const remaining = [...capacity]

  // One augmenting path per row, cheapest first among rows is NOT required —
  // successive shortest paths is optimal regardless of the order rows are
  // augmented, provided each augmentation is itself a shortest path in the
  // residual graph. Residual edges are what let an earlier row be displaced.
  for (let pass = 0; pass < rows; pass++) {
    // dist over columns, reached either directly from an unassigned row or by
    // displacing an assigned row out of a column it currently holds.
    let best = null
    for (let i = 0; i < rows; i++) {
      if (result[i] !== null) continue
      const path = shortestAugmenting(i, cost, remaining, result, rows, cols)
      if (path && (best === null || path.cost < best.cost)) best = { row: i, ...path }
    }
    if (!best) break
    applyPath(best, result, remaining)
  }
  return result
}

// Finds the cheapest way to seat `row`, possibly by displacing already-seated
// rows into other columns. Returns {cost, moves:[{row, col}]} or null.
function shortestAugmenting(row, cost, remaining, result, rows, cols) {
  // Nodes: rows 0..rows-1, columns rows..rows+cols-1.
  const N = rows + cols
  const dist = new Array(N).fill(Infinity)
  const prev = new Array(N).fill(-1)
  dist[row] = 0

  for (let iter = 0; iter < N; iter++) {
    let changed = false
    for (let i = 0; i < rows; i++) {
      if (dist[i] === Infinity) continue
      for (let j = 0; j < cols; j++) {
        if (cost[i][j] == null) continue
        if (result[i] === j) continue // already here; the reverse edge covers it
        const nd = dist[i] + cost[i][j]
        if (nd < dist[rows + j]) { dist[rows + j] = nd; prev[rows + j] = i; changed = true }
      }
    }
    // Leaving a full column means displacing whoever sits in it, refunding
    // their cost — this is the residual edge that makes the result optimal
    // rather than greedy.
    for (let j = 0; j < cols; j++) {
      if (dist[rows + j] === Infinity) continue
      if (remaining[j] > 0) continue
      for (let i = 0; i < rows; i++) {
        if (result[i] !== j) continue
        const nd = dist[rows + j] - cost[i][j]
        if (nd < dist[i]) { dist[i] = nd; prev[i] = rows + j; changed = true }
      }
    }
    if (!changed) break
  }

  let bestCol = -1
  for (let j = 0; j < cols; j++) {
    if (remaining[j] <= 0) continue
    if (dist[rows + j] === Infinity) continue
    if (bestCol === -1 || dist[rows + j] < dist[rows + bestCol]) bestCol = j
  }
  if (bestCol === -1) return null

  // Walk back, collecting (row -> column) moves.
  const moves = []
  let node = rows + bestCol
  while (node !== row) {
    const p = prev[node]
    if (p === -1) return null
    if (node >= rows) moves.push({ row: p, col: node - rows })
    node = p
  }
  return { cost: dist[rows + bestCol], moves, col: bestCol }
}

function applyPath(best, result, remaining) {
  for (const m of best.moves) {
    const from = result[m.row]
    if (from !== null && from !== undefined) remaining[from] += 1
    result[m.row] = m.col
    remaining[m.col] -= 1
  }
}
