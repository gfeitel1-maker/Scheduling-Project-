// Browser-dev-server stand-in for window.shoresh (only Electron's preload-bridged
// renderer has the real thing). Lets ModeSelect/Join/Bootstrap/Login be visually
// verified with `npm run dev` outside Electron. Never used when window.shoresh exists.
const STORE_KEY = 'shoresh-mock-state'

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Backfill for state saved before conflicts persistence existed.
      if (!Array.isArray(parsed.conflicts)) parsed.conflicts = []
      return parsed
    }
  } catch { /* fall through to default */ }
  return { camp: null, users: [], conflicts: [] }
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state))
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Mirrors the real SQLite UNIQUE(...) indexes (electron/db/schema.sql +
// migrations) so the mock reproduces the same collision behavior the app's
// write logic is built around (ensureCohort / addTier / etc. deliberately
// write `name` first and match on /UNIQUE/i errors). Without emulating these,
// StrictMode's double-invoked mount effect would create duplicate "Main"
// cohorts/days in a `npm run dev` browser that could never happen in Electron.
const UNIQUE_KEYS = {
  cohorts:     ['camp_id', 'name'],
  groups:      ['camp_id', 'name'],
  activities:  ['camp_id', 'name'],
  tiers:       ['camp_id', 'cohort_id', 'name'],
  time_blocks: ['camp_id', 'cohort_id', 'name'],
}

// Registered listeners for the mock's event-style methods (onOpApplied,
// onOpConflict). Stored here — rather than left as no-ops — so a future
// test/dev session can trigger a synthetic op-applied or conflict event
// (e.g. via mockShoresh._triggerOpConflict(msg)) without monkey-patching
// this file each time.
let opAppliedListeners = []
let opConflictListeners = []

export const mockShoresh = {
  async chooseMode() {
    return { mode: 'host' }
  },
  async discoverHosts() {
    return [{ name: 'Camp Achva (demo)', host: '192.168.1.42', port: 7000 }]
  },
  async login({ name, pin }) {
    const state = loadState()
    const user = state.users.find((u) => u.name === name && u.pin === pin)
    if (!user) return null
    return { token: `mock.${user.id}`, userId: user.id, role: user.role }
  },
  async createUser({ name, pin, role }) {
    const state = loadState()
    const user = { id: randomId(), name, pin, role }
    state.users.push(user)
    saveState(state)
    return { id: user.id, name, role }
  },
  async bootstrapCamp({ campName, adminName, adminPin }) {
    const state = loadState()
    state.camp = { id: randomId(), name: campName }
    state.users.push({ id: randomId(), name: adminName, pin: adminPin, role: 'admin' })
    saveState(state)
    return { campId: state.camp.id, userId: state.users[state.users.length - 1].id }
  },
  // Field-level write, mirroring the real op-log/projection contract
  // (electron/ops/projections.js): each call creates-or-updates a single
  // field on one row, building a row up field-by-field. Without this the mock
  // was write-blind — `write` returned {status:'applied'} but never persisted,
  // so `list` (below) always came back empty, making it impossible to create
  // a Program/Unit/Group/etc. in a plain `npm run dev` browser and blocking
  // Camp Setup end-to-end outside Electron.
  async write({ entity, entity_id, field, value } = {}) {
    if (!entity || !entity_id) return { status: 'applied' }
    const state = loadState()

    // `camps` is the singleton stored as state.camp (read by getCamp), not an
    // array — keep it consistent so a camp rename reflects everywhere.
    if (entity === 'camps') {
      if (state.camp && state.camp.id === entity_id && field !== '__deleted__') {
        state.camp = { ...state.camp, [field]: value }
        saveState(state)
      }
      return { status: 'applied' }
    }

    if (!Array.isArray(state[entity])) state[entity] = []
    const rows = state[entity]
    const idx = rows.findIndex((r) => r.id === entity_id)

    // Row-delete sentinel — see DELETE_FIELD in electron/ops/operations.js.
    if (field === '__deleted__') {
      if (idx !== -1) rows.splice(idx, 1)
      saveState(state)
      return { status: 'applied' }
    }

    // Build the candidate row. New rows get camp_id stamped from the singleton
    // camp, mirroring ensureExists (electron/ops/projections.js), so the
    // UNIQUE(camp_id, name) tuple is complete on the very first (`name`) write
    // — matching how a real collision fails atomically before an orphan row
    // exists.
    const uniqueKey = UNIQUE_KEYS[entity]
    const isNew = idx === -1
    const base = isNew
      ? { id: entity_id, ...(uniqueKey?.includes('camp_id') && state.camp ? { camp_id: state.camp.id } : {}) }
      : rows[idx]
    const candidate = { ...base, [field]: value }

    // Emulate the UNIQUE constraint: once every key field is present, reject a
    // write that would duplicate another row's key tuple (throwing a
    // better-sqlite3-shaped message the app already matches on with /UNIQUE/i).
    if (uniqueKey && uniqueKey.every((k) => candidate[k] != null && candidate[k] !== '')) {
      const collision = rows.some(
        (r) => r.id !== entity_id && uniqueKey.every((k) => r[k] === candidate[k])
      )
      if (collision) {
        throw new Error(`UNIQUE constraint failed: ${entity}.${uniqueKey.join(', ' + entity + '.')}`)
      }
    }

    if (isNew) rows.push(candidate)
    else rows[idx] = candidate
    saveState(state)
    return { status: 'applied' }
  },
  // Wholesale delete-and-reinsert of one scope, mirroring the real
  // bulk_replace primitive (electron/ops/operations.js). The two registered
  // bulk_replace entities (template_slots, template_overlays) are both scoped
  // by template_id, so replace every row in that scope with the new set.
  async bulkReplace({ entity, scope_id, rows } = {}) {
    if (!entity) return { status: 'applied' }
    const state = loadState()
    if (!Array.isArray(state[entity])) state[entity] = []
    state[entity] = state[entity].filter((r) => r.template_id !== scope_id)
    for (const row of rows || []) state[entity].push({ ...row })
    saveState(state)
    return { status: 'applied' }
  },
  async verifySession({ token } = {}) {
    if (typeof token === 'string' && token.startsWith('mock.')) {
      const state = loadState()
      const userId = token.slice('mock.'.length)
      const user = state.users.find((u) => u.id === userId)
      if (user) return { valid: true, userId: user.id, role: user.role }
    }
    return { valid: false }
  },
  onOpApplied(cb) {
    if (typeof cb === 'function') opAppliedListeners.push(cb)
    return () => { opAppliedListeners = opAppliedListeners.filter((l) => l !== cb) }
  },
  onOpConflict(cb) {
    if (typeof cb === 'function') opConflictListeners.push(cb)
    return () => { opConflictListeners = opConflictListeners.filter((l) => l !== cb) }
  },
  // Test/dev-only helpers — not part of the real window.shoresh contract,
  // used to synthesize events for manual/automated UI verification of
  // screens like ConflictsScreen outside Electron.
  _triggerOpApplied(op) {
    opAppliedListeners.forEach((cb) => cb(op))
  },
  // Persists the conflict into localStorage-backed mock state (mirroring the
  // real app's `conflicts` sqlite table, per Fix 3) in addition to firing the
  // live listener, so a page reload with no listener attached yet still sees
  // it via listPendingConflicts() below — this is what lets the restart/
  // rehydration scenario be exercised outside Electron.
  _triggerOpConflict(msg) {
    const state = loadState()
    state.conflicts.push(msg)
    saveState(state)
    opConflictListeners.forEach((cb) => cb(msg))
  },
  async getCamp() {
    return loadState().camp
  },
  // token param intentionally unnamed — the mock has no role model to check
  // against, but the real preload bridge (electron/preload.js) always sends
  // token as the first arg now that these are authorize()-gated in
  // electron/main.js, so the signature still accepts (and ignores) it.
  async listUsers() {
    return loadState().users.map((u) => ({ id: u.id, name: u.name, role: u.role }))
  },
  async list(_token, entity) {
    const state = loadState()
    if (!Array.isArray(state[entity])) return []
    return state[entity]
  },
  async getDeviceId() {
    return 'mock-device'
  },
  async resolveConflict(args = {}) {
    const state = loadState()
    state.conflicts = state.conflicts.filter(
      (msg) =>
        !(
          msg.existingOp &&
          msg.existingOp.entity === args.entity &&
          msg.existingOp.entity_id === args.entity_id &&
          msg.existingOp.field === args.field &&
          msg.existingOp.id === args.parent_op_id
        )
    )
    saveState(state)
    return { status: 'applied' }
  },
  // Rehydration query stand-in (Fix 3): returns the conflicts persisted in
  // mock state, mirroring the real listPendingConflicts() IPC handler so the
  // Conflicts screen shows pending conflicts immediately on mount even
  // outside Electron.
  async listPendingConflicts() {
    return loadState().conflicts
  },
}

// Dev-only: expose the mock on window so a manual/automated browser session
// (e.g. via the devtools console) can synthesize op-applied/op-conflict
// events without monkey-patching this file, per Fix 7.
if (typeof window !== 'undefined') {
  window.__mockShoresh = mockShoresh
}
