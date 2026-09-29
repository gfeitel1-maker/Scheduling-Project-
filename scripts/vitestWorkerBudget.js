// T311 — bound total vitest parallelism across concurrent sessions.
//
// THE UNBOUNDED PRODUCT. `gateLock.js` serialises full gates, but it has exactly one caller
// (`verify.js`). `npm run test` is a bare `vitest run` and an ad-hoc `npx vitest run <file>` takes no
// lock at all, so nothing bounds sessions × workers. Measured on this 4-core machine on 2026-09-29:
// 1-minute load average 409, peaking 518 — 100× the core count — with several sessions each running
// vitest at full worker count. At that load nothing on the machine measures anything: identical work
// was observed ranging 2.2s to 9.8s wall against ~0.9s CPU.
//
// WHAT THIS DOES. Every vitest run registers a lease in a shared directory and counts the live ones.
// Alone, it changes nothing. Contended, each run takes a fair share of the cores instead of all of
// them, so N runs use ~cores workers in total rather than N × cores.
//
// WHY A LEASE COUNT AND NOT THE LOAD AVERAGE. Load average is the symptom and a poor controller: it
// is a 1-minute lagging average, it counts the editor and the app and every unrelated process, and it
// is inflated by the run's OWN workers — so a run would throttle itself for its own load and keep
// throttling after the cause had gone. The lease count is the actual term in the product this exists
// to bound, it is current rather than averaged, and it attributes correctly.
//
// WHY IT NEVER TOUCHES THE UNCONTENDED CASE. `workerBudget` returns null for a single run, meaning
// "use vitest's own default". CI runs one suite on a clean runner and is therefore bit-for-bit
// unaffected; a developer alone on their machine is unaffected too. The change is only ever a
// reduction applied when a second run actually exists, which is the only condition under which the
// product was ever a problem.
//
// STALE LEASES SELF-HEAL, on the same principle as gateLock: a pid that no longer exists is reaped by
// whoever next counts, so a killed or crashed run cannot permanently shrink everyone else's budget.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { processAlive, repoKey } from './gateLock.js'

export const LEASE_SUFFIX = '.lease'

export function leaseDir(key, tmp = os.tmpdir()) {
  return path.join(tmp, `shoresh-vitest-${key}`)
}

/**
 * How many workers should a run take, given how many runs are live?
 *
 * @param {object} args
 * @param {number} args.cores
 * @param {number} args.liveRuns  including this one, so always >= 1
 * @returns {number|null} null = impose nothing, use vitest's default
 */
export function workerBudget({ cores, liveRuns } = {}) {
  if (!Number.isFinite(cores) || cores <= 0) return null // unknown machine — impose nothing
  if (!Number.isFinite(liveRuns) || liveRuns <= 1) return null // alone: do not change today's behaviour
  // Fair share, floored at one. Floor rather than round: two runs on 3 cores should take 1 each and
  // leave a core, not 2 each and oversubscribe by the very mechanism meant to prevent it.
  return Math.max(1, Math.floor(cores / liveRuns))
}

/**
 * Live lease pids in the directory, reaping dead ones as it goes.
 * Exported for testing; `claim` is the real entry point.
 */
export function countLiveLeases(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return [] // no directory yet — this is the first run
  }
  const live = []
  for (const name of names) {
    if (!name.endsWith(LEASE_SUFFIX)) continue
    const pid = Number.parseInt(name.slice(0, -LEASE_SUFFIX.length), 10)
    // A name that is not a pid is not evidence of a run; remove it rather than counting it, or a
    // stray file would shrink every future budget forever.
    if (!Number.isInteger(pid) || pid <= 0) {
      try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* another run reaped it */ }
      continue
    }
    if (processAlive(pid)) {
      live.push(pid)
    } else {
      try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* another run reaped it */ }
    }
  }
  return live
}

/**
 * Register this run and return its worker budget.
 *
 * Returns `{ budget, liveRuns, release }`. `budget` is null when nothing should be imposed.
 * Never throws: a filesystem this cannot use must cost the bound, never the test run.
 */
export function claim({ cores = os.cpus().length, dir = leaseDir(repoKey()), pid = process.pid } = {}) {
  const noop = { budget: null, liveRuns: 1, release: () => {} }
  if (process.env.SHORESH_NO_WORKER_BUDGET === '1') return noop
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${pid}${LEASE_SUFFIX}`)
    // Register BEFORE counting, and count including ourselves. Registering after counting would let
    // two runs starting together both see zero peers and both take every core — the exact race this
    // exists to prevent.
    fs.writeFileSync(file, JSON.stringify({ pid, startedAt: new Date().toISOString(), cwd: process.cwd() }))
    const live = countLiveLeases(dir)
    // `live` includes this pid because it was just written. If the probe somehow missed it, count it
    // anyway — a budget must never be computed from fewer runs than actually exist.
    const liveRuns = live.includes(pid) ? live.length : live.length + 1
    const release = () => {
      try { fs.rmSync(file, { force: true }) } catch { /* reaped by a peer's census */ }
    }
    return { budget: workerBudget({ cores, liveRuns }), liveRuns, release }
  } catch {
    return noop
  }
}
