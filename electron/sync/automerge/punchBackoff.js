export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_CAP_MS = 30 * 60 * 1000

// Exponential from base, doubling per attempt to the cap, then jittered to 75-100% of that so two
// devices that lost each other at the same moment do not retry in lockstep.
export function backoffMs(attempt, { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, random = Math.random } = {}) {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  return Math.round(raw * (0.75 + 0.25 * random()))
}
