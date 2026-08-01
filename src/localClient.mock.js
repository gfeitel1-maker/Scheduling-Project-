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
      // Backfill for state saved before device pairing was mocked (T11).
      if (!Array.isArray(parsed.devices)) parsed.devices = seedDevices()
      return parsed
    }
  } catch { /* fall through to default */ }
  return { camp: null, users: [], conflicts: [], devices: seedDevices() }
}

// Sample devices so Device Manager has something to render and its actions do
// something observable. Every name is marked "(sample)" — the dev mock is for
// evaluating layout and flow, never for concluding anything about real devices,
// and a screen that silently showed plausible-looking fake hardware would be
// worse than one that showed nothing. The sidebar's DEV badge is the other half
// of that signal (see ADR 2026-07-28).
function seedDevices() {
  const now = new Date().toISOString()
  return [
    { id: 'mock-device', name: 'This computer (sample)', pairing_status: 'authorized', authorized_at: now, revoked_at: null, last_synced_at: now },
    { id: 'mock-device-pending', name: 'Front Office iPad (sample)', pairing_status: 'pending', authorized_at: null, revoked_at: null, last_synced_at: null },
    { id: 'mock-device-paired', name: 'Kitchen Laptop (sample)', pairing_status: 'authorized', authorized_at: now, revoked_at: null, last_synced_at: now },
  ]
}

function updateDevice(deviceId, patch) {
  const state = loadState()
  const device = (state.devices || []).find((d) => d.id === deviceId)
  // Mirrors the real handler, which throws 'device not found' rather than
  // silently succeeding — the screen's error path should be reachable in dev.
  if (!device) throw new Error('device not found')
  Object.assign(device, patch)
  saveState(state)
  return device
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
let pairingRequestListeners = []
let pairingApprovedListeners = []
let pairingDeniedListeners = []
let tokenRenewedListeners = []
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
  // The browser dev server has no Electron and no LAN. Reporting 'standalone'
  // is the truthful answer here, not a placeholder.
  async getSyncStatus() {
    return { mode: null, connected: false, state: 'standalone' }
  },
  onSyncStatusChanged() {
    return () => {}
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
  // --- Device pairing and trust (T11) ---
  //
  // Stateful rather than stubbed: approve/deny/revoke actually move a device
  // between states and the list re-renders, so the Device Manager flow can be
  // evaluated in `npm run dev`. What this canNOT prove is anything about real
  // pairing — there is no second device, no WebSocket, and no Ed25519 minting
  // here. Per TESTING_STANDARD.md §2, device-trust behaviour is only ever
  // demonstrated under electron:dev plus the integration harness.
  async listPendingPairingRequests() {
    // Mirrors the real query: excludes denied devices so a single deny stops
    // the device re-appearing on the next poll.
    return (loadState().devices || [])
      .filter((d) => !d.authorized_at && !d.revoked_at && (d.pairing_status == null || d.pairing_status === 'pending'))
      .map(({ id, name }) => ({ id, name }))
  },
  async listDevices() {
    return (loadState().devices || []).map(({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at }) =>
      ({ id, name, pairing_status, authorized_at, revoked_at, last_synced_at }))
  },
  async approveDevice(deviceId) {
    const now = new Date().toISOString()
    updateDevice(deviceId, { pairing_status: 'authorized', authorized_at: now, revoked_at: null })
    return { deviceId, authorized: true }
  },
  async denyDevice(deviceId) {
    updateDevice(deviceId, { pairing_status: 'denied' })
    return { deviceId, denied: true }
  },
  async revokeDevice(deviceId, reason = null) {
    updateDevice(deviceId, { revoked_at: new Date().toISOString(), revocation_reason: reason })
    return { deviceId, revoked: true }
  },
  async getDevicePairingStatus() {
    const self = (loadState().devices || []).find((d) => d.id === 'mock-device')
    return { isPaired: !!(self && self.authorized_at), pairing_status: self ? self.pairing_status : null }
  },
  // Event subscriptions. Registered rather than dropped so a dev session can
  // synthesize one from the console, matching the onOpApplied pattern above.
  onPairingRequest(cb) { pairingRequestListeners.push(cb); return () => { pairingRequestListeners = pairingRequestListeners.filter((f) => f !== cb) } },
  onPairingApproved(cb) { pairingApprovedListeners.push(cb); return () => { pairingApprovedListeners = pairingApprovedListeners.filter((f) => f !== cb) } },
  onPairingDenied(cb) { pairingDeniedListeners.push(cb); return () => { pairingDeniedListeners = pairingDeniedListeners.filter((f) => f !== cb) } },
  onTokenRenewed(cb) { tokenRenewedListeners.push(cb); return () => { tokenRenewedListeners = tokenRenewedListeners.filter((f) => f !== cb) } },
  _triggerPairingRequest(payload) { pairingRequestListeners.forEach((cb) => cb(payload)) },
  _triggerPairingApproved(payload) { pairingApprovedListeners.forEach((cb) => cb(payload)) },
  _triggerPairingDenied(payload) { pairingDeniedListeners.forEach((cb) => cb(payload)) },
  _triggerTokenRenewed(payload) { tokenRenewedListeners.forEach((cb) => cb(payload)) },

  // Rehydration query stand-in (Fix 3): returns the conflicts persisted in
  // mock state, mirroring the real listPendingConflicts() IPC handler so the
  // Conflicts screen shows pending conflicts immediately on mount even
  // outside Electron.
  async listPendingConflicts() {
    return loadState().conflicts
  },

  // Trash and record history have no meaningful stand-in outside Electron:
  // the mock has no op log, which is the only place a deleted record lives.
  // Empty results keep the screens renderable for layout work at :5200 and
  // make it obvious that persistence checks belong under electron:dev.
  async listDeleted() {
    return []
  },
  async listPendingRestores() {
    return []
  },
  async getEntityHistory() {
    return []
  },
  async restoreEntity() {
    return { error: 'no-history' }
  },

  // Deleting a record a schedule uses. The mock has no schedule to count, so
  // the preview reports a real zero rather than an invented number — the count
  // is the whole basis on which a director decides, and a made-up one at :5200
  // would make the dialog look verified when it is not. Persistence checks for
  // this belong under electron:dev.
  async previewDelete({ entity, entity_id }) {
    return {
      ok: true,
      entity,
      entity_id,
      name: null,
      destructive: entity === 'groups' || entity === 'days_of_operation',
      slot_count: 0,
      routes: [],
      unprotected_count: 0,
      anchor_count: 0,
      overlay_count: 0,
      weather_dependent_count: 0,
    }
  },
  async deleteRecord() {
    return { error: 'no-record' }
  },
}

// Dev-only: expose the mock on window so a manual/automated browser session
// (e.g. via the devtools console) can synthesize op-applied/op-conflict
// events without monkey-patching this file, per Fix 7.
if (typeof window !== 'undefined') {
  window.__mockShoresh = mockShoresh
}
