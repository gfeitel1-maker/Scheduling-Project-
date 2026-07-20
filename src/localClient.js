// Thin wrapper around window.shoresh (exposed by electron/preload.js).
// In a plain browser dev server (no Electron), window.shoresh is undefined —
// fall back to a mock so screens can still be visually verified with `npm run dev`.
import { mockShoresh } from './localClient.mock'

const shoresh = typeof window !== 'undefined' && window.shoresh ? window.shoresh : mockShoresh

export const localClient = {
  chooseMode: (args) => shoresh.chooseMode(args),
  discoverHosts: () => shoresh.discoverHosts(),
  login: (name, pin) => shoresh.login({ name, pin }),
  createUser: (args) => shoresh.createUser(args),
  bootstrapCamp: (args) => shoresh.bootstrapCamp(args),
  write: (token, entity, entity_id, field, value) => shoresh.write({ token, entity, entity_id, field, value }),
  onOpApplied: (cb) => shoresh.onOpApplied(cb),
  getCamp: () => shoresh.getCamp(),
}
