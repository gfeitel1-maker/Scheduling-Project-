// Assigning campers to elective offerings (T196, ADR D11/D14).
//
// A pure deterministic function. Plain objects in, assignments plus findings
// out — no database, no IPC, no file parsing, no writes. Same discipline as
// buildSchedule.js, a different level of the nested schedule.
//
// THE COUPLING, which is the whole design problem. Preferences are ranked
// GLOBALLY: a camper ranks each elective once for the session, not once per
// slot (ADR D14, after real camp artifacts contradicted the per-occurrence
// premise). So placing a camper into Water Ski on Monday consumes that
// preference for the entire week, and occurrences of the same activity are NOT
// independent sub-problems.
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
 * @param {{camper_id, labelKey, rank}[]} input.preferences   rank is 1-based, lower is better
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
  const labelOfChoice = (id) => choiceById.get(id)?.labelKey ?? id

  // PREFERENCE -> CHOICE RESOLUTION, both ways, for a compatibility reason.
  // T247's ticket says to read `preferences` as pointing at `choice_id` — the
  // schema's own shape. But every existing caller and every pre-T247 test in
  // this repo keys a preference by `labelKey`, and nothing in production passes
  // `choices` at all yet. So a preference resolves to a choice by `choice_id`
  // when it names one this run knows, and by `labelKey` otherwise. A
  // choice_id-only preference also registers its choice's labelKey in rankOf,
  // so tier 2 costs it exactly as it costs a labelKey preference.
  const rankOf = new Map()            // camperId -> Map(labelKey -> rank)
  const rankByChoice = new Map()      // camperId -> Map(choiceId -> rank)
  for (const p of preferences) {
    const ch = (p.choice_id != null ? choiceById.get(p.choice_id) : undefined)
      ?? (p.labelKey != null ? choiceByLabelKey.get(p.labelKey) : undefined)
      ?? null
    const labelKey = p.labelKey ?? ch?.labelKey ?? null
    if (labelKey != null) {
      if (!rankOf.has(p.camper_id)) rankOf.set(p.camper_id, new Map())
      rankOf.get(p.camper_id).set(labelKey, p.rank)
    }
    if (ch) {
      if (!rankByChoice.has(p.camper_id)) rankByChoice.set(p.camper_id, new Map())
      rankByChoice.get(p.camper_id).set(ch.id, p.rank)
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
        preference_rank: (o && rankOf.get(l.camperId)?.get(o.labelKey)) ?? null,
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

    const cost = who.map((camperId) =>
      here.map((o) => {
        const rank = rankOf.get(camperId)?.get(o.labelKey)
        return rank == null ? UNRANKED_COST : rank
      })
    )

    const remainingCapacity = here.map((o) => Math.max(0, o.capacity ?? 0))
    for (const e of prePlacedHere) {
      const j = here.findIndex((o) => o.activity_id === e.activityId)
      if (j >= 0) remainingCapacity[j] = Math.max(0, remainingCapacity[j] - 1)
    }

    const placed = minCostAssign(cost, remainingCapacity)

    const unplaced = []
    who.forEach((camperId, i) => {
      const j = placed[i]
      if (j == null) {
        unplaced.push(camperId)
        return
      }
      const o = here[j]
      const rank = rankOf.get(camperId)?.get(o.labelKey) ?? null
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
    })

    if (unplaced.length > 0) {
      findings.push({
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
      const wanted = camperIds.filter((c) => rankByChoice.get(c)?.has(id))
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

    const wants = (camperId, id) =>
      rankByChoice.get(camperId)?.has(id) && !excluded.get(id)?.has(camperId)
    const rows = camperIds.filter((c) => columns.some((id) => wants(c, id)))
    if (rows.length === 0) return

    // A forbidden pairing is `null`, never UNRANKED_COST. UNRANKED_COST exists
    // so R3 ("never unplaced") can seat a camper in something they did not ask
    // for; that has no meaning here, because a linked choice is a commitment
    // across several periods and tier 2 is what guarantees the camper is placed
    // at all. An unranked cell is therefore unreachable as a placement by
    // construction, and forbidding it keeps it that way.
    const cost = rows.map((camperId) =>
      columns.map((id) => (wants(camperId, id) ? rankByChoice.get(camperId).get(id) : null))
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
      const rank = rankByChoice.get(camperId).get(id)
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
