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
 * @returns {{assignments: object[], findings: object[]}}
 */
export function buildElectiveAssignments({
  campers = [],
  occurrences = [],
  offerings = [],
  preferences = [],
  attendance = null,
  lockedAssignments = [],
} = {}) {
  const assignments = []
  const findings = []

  // Every ordering below is a total order over stable ids, never the iteration
  // order of an input array or a Map — the determinism property.
  const camperIds = campers.map((c) => c.id).sort()
  const occurrenceIds = occurrences.map((o) => o.id).sort()

  // rank[camperId][labelKey] -> rank
  const rankOf = new Map()
  for (const p of preferences) {
    if (!rankOf.has(p.camper_id)) rankOf.set(p.camper_id, new Map())
    rankOf.get(p.camper_id).set(p.labelKey, p.rank)
  }

  // Grouped through a sort over stable ids, never the input array's order —
  // the same determinism property as camperIds/occurrenceIds above.
  const lockedByOccurrence = new Map()
  for (const l of [...lockedAssignments].sort((a, b) =>
    a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1
      : a.camperId < b.camperId ? -1 : a.camperId > b.camperId ? 1 : 0
  )) {
    if (!lockedByOccurrence.has(l.occurrenceId)) lockedByOccurrence.set(l.occurrenceId, [])
    lockedByOccurrence.get(l.occurrenceId).push(l)
  }

  const attends = (camperId, occurrenceId) =>
    attendance ? (attendance[camperId] ?? []).includes(occurrenceId) : true

  for (const occurrenceId of occurrenceIds) {
    const here = offerings
      .filter((o) => o.occurrence_id === occurrenceId)
      .sort((a, b) => (a.labelKey < b.labelKey ? -1 : a.labelKey > b.labelKey ? 1 : 0))
    const lockedHere = lockedByOccurrence.get(occurrenceId) ?? []
    const lockedCampers = new Set(lockedHere.map((l) => l.camperId))
    const who = camperIds.filter((id) => attends(id, occurrenceId) && !lockedCampers.has(id))
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
    // A locked seat is emitted as-is so a caller's preview still shows the
    // camper. A locked row naming an activity this occurrence does not offer
    // is emitted but accounted against nothing — this function is pure and
    // does not diagnose stale rows; DANGLING_MANUAL_ASSIGNMENT in
    // commitElectiveRun is where that is reported.
    for (const l of lockedHere) {
      const o = here.find((x) => x.activity_id === l.activityId) ?? null
      assignments.push({
        camper_id: l.camperId,
        occurrence_id: occurrenceId,
        labelKey: o?.labelKey ?? null,
        activity_id: l.activityId,
        preference_rank: (o && rankOf.get(l.camperId)?.get(o.labelKey)) ?? null,
        flags: [],
        source: 'manual',
        locked: true,
      })
    }

    if (who.length === 0 && lockedHere.length === 0) {
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
    for (const l of lockedHere) {
      const j = here.findIndex((o) => o.activity_id === l.activityId)
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
  return { assignments, findings }
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
