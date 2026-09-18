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
//   3. a camper takes a given choice at most once across the week
//
// 1 and 2 alone are a clean bipartite min-cost flow. 3 couples the occurrences
// and is not expressible as a capacity in that same network — encoding it wants
// a per-(camper, choice) node bounded at 1, while 1 wants (camper, occurrence)
// as the demand node. Both at once is an integer program, not a flow.
//
// APPROACH: solve occurrences in a deterministic order, each as its own
// min-cost max-flow over each camper's REMAINING preferences, consuming a
// camper's preference for a choice when they are placed into it. Constraint 3
// then holds by construction.
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

/**
 * @param {object} input
 * @param {{id: string}[]} input.campers
 * @param {{id: string}[]} input.occurrences      solved in ascending id order
 * @param {{occurrence_id, labelKey, activity_id, capacity}[]} input.offerings
 * @param {{camper_id, labelKey, rank}[]} input.preferences   rank is 1-based, lower is better
 * @param {Record<string, string[]>} [input.attendance]  camper id -> occurrence ids;
 *        default: every camper attends every occurrence.
 * @returns {{assignments: object[], findings: object[]}}
 */
export function buildElectiveAssignments({
  campers = [],
  occurrences = [],
  offerings = [],
  preferences = [],
  attendance = null,
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

  // Consumed choices, per camper — constraint 3's whole implementation.
  const taken = new Map(camperIds.map((id) => [id, new Set()]))

  const attends = (camperId, occurrenceId) =>
    attendance ? (attendance[camperId] ?? []).includes(occurrenceId) : true

  for (const occurrenceId of occurrenceIds) {
    const here = offerings
      .filter((o) => o.occurrence_id === occurrenceId)
      .sort((a, b) => (a.labelKey < b.labelKey ? -1 : a.labelKey > b.labelKey ? 1 : 0))
    const who = camperIds.filter((id) => attends(id, occurrenceId))
    if (who.length === 0 || here.length === 0) continue

    const cost = who.map((camperId) =>
      here.map((o) => {
        if (taken.get(camperId).has(o.labelKey)) return null // constraint 3
        const rank = rankOf.get(camperId)?.get(o.labelKey)
        return rank == null ? UNRANKED_COST : rank
      })
    )

    const placed = minCostAssign(cost, here.map((o) => Math.max(0, o.capacity ?? 0)))

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
      taken.get(camperId).add(o.labelKey)
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
