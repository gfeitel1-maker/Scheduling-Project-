// Browser-dev-server stand-in for window.shoresh (only Electron's preload-bridged
// renderer has the real thing). Lets ModeSelect/Join/Bootstrap/Login be visually
// verified with `npm run dev` outside Electron. Never used when window.shoresh exists.
const STORE_KEY = 'shoresh-mock-state'

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* fall through to default */ }
  return { camp: null, users: [] }
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state))
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
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
  async write() {
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
  },
  onOpConflict(cb) {
    if (typeof cb === 'function') opConflictListeners.push(cb)
  },
  // Test/dev-only helpers — not part of the real window.shoresh contract,
  // used to synthesize events for manual/automated UI verification of
  // screens like ConflictsScreen outside Electron.
  _triggerOpApplied(op) {
    opAppliedListeners.forEach((cb) => cb(op))
  },
  _triggerOpConflict(msg) {
    opConflictListeners.forEach((cb) => cb(msg))
  },
  async getCamp() {
    return loadState().camp
  },
  async listUsers() {
    return loadState().users.map((u) => ({ id: u.id, name: u.name, role: u.role }))
  },
  async getDeviceId() {
    return 'mock-device'
  },
  async resolveConflict() {
    return { status: 'applied' }
  },
}

// Dev-only: expose the mock on window so a manual/automated browser session
// (e.g. via the devtools console) can synthesize op-applied/op-conflict
// events without monkey-patching this file, per Fix 7.
if (typeof window !== 'undefined') {
  window.__mockShoresh = mockShoresh
}
