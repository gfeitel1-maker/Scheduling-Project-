import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { claim, countLiveLeases, leaseDir, workerBudget, LEASE_SUFFIX } from './vitestWorkerBudget.js'

const dirs = []
function tmpDir() {
  const d = path.join(os.tmpdir(), `wb-test-${randomUUID()}`)
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

// A pid that is certainly not running. 2^22 is above every platform's pid_max default, so
// process.kill(pid, 0) reports it dead rather than accidentally probing a real process.
const DEAD_PID = 4_194_304

describe('workerBudget', () => {
  // THE MOST IMPORTANT CASE. A single run must behave exactly as it does today, or this change
  // slows down CI and every solo developer for a problem neither of them has.
  it('imposes nothing when a run is alone', () => {
    expect(workerBudget({ cores: 4, liveRuns: 1 })).toBeNull()
  })

  it('splits the cores fairly once a second run exists', () => {
    expect(workerBudget({ cores: 4, liveRuns: 2 })).toBe(2)
    expect(workerBudget({ cores: 4, liveRuns: 4 })).toBe(1)
    expect(workerBudget({ cores: 8, liveRuns: 2 })).toBe(4)
  })

  // Floor, not round: two runs on three cores take 1 each and leave a core, rather than 2 each and
  // oversubscribing by the very mechanism meant to prevent it.
  it('floors rather than rounds', () => {
    expect(workerBudget({ cores: 3, liveRuns: 2 })).toBe(1)
    expect(workerBudget({ cores: 5, liveRuns: 2 })).toBe(2)
  })

  it('never returns zero or negative, however many runs pile up', () => {
    for (const liveRuns of [5, 20, 500]) {
      expect(workerBudget({ cores: 4, liveRuns })).toBe(1)
    }
  })

  it('imposes nothing when the machine is unknown', () => {
    expect(workerBudget({ cores: 0, liveRuns: 3 })).toBeNull()
    expect(workerBudget({ cores: undefined, liveRuns: 3 })).toBeNull()
    expect(workerBudget({ cores: NaN, liveRuns: 3 })).toBeNull()
  })

  it('imposes nothing on a nonsense run count rather than guessing', () => {
    expect(workerBudget({ cores: 4, liveRuns: 0 })).toBeNull()
    expect(workerBudget({ cores: 4, liveRuns: undefined })).toBeNull()
  })

  it('is null on an empty call rather than throwing', () => {
    expect(workerBudget()).toBeNull()
  })
})

describe('countLiveLeases', () => {
  it('is empty when the directory does not exist', () => {
    expect(countLiveLeases(path.join(tmpDir(), 'nope'))).toEqual([])
  })

  it('counts a live pid', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${process.pid}${LEASE_SUFFIX}`), '{}')
    expect(countLiveLeases(d)).toEqual([process.pid])
  })

  // SELF-HEALING is the property that stops a killed run permanently shrinking everyone's budget.
  it('reaps a dead pid rather than counting it', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    const dead = path.join(d, `${DEAD_PID}${LEASE_SUFFIX}`)
    fs.writeFileSync(dead, '{}')
    expect(countLiveLeases(d)).toEqual([])
    expect(fs.existsSync(dead)).toBe(false)
  })

  it('reaps a file whose name is not a pid, rather than counting it forever', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    const junk = path.join(d, `notapid${LEASE_SUFFIX}`)
    fs.writeFileSync(junk, '{}')
    expect(countLiveLeases(d)).toEqual([])
    expect(fs.existsSync(junk)).toBe(false)
  })

  it('ignores unrelated files without deleting them', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    const other = path.join(d, 'README.txt')
    fs.writeFileSync(other, 'x')
    expect(countLiveLeases(d)).toEqual([])
    expect(fs.existsSync(other)).toBe(true)
  })
})

describe('claim', () => {
  it('registers a lease, reports being alone, and imposes nothing', () => {
    const d = tmpDir()
    const { budget, liveRuns, release } = claim({ cores: 4, dir: d, pid: process.pid })
    expect(liveRuns).toBe(1)
    expect(budget).toBeNull()
    expect(fs.existsSync(path.join(d, `${process.pid}${LEASE_SUFFIX}`))).toBe(true)
    release()
    expect(fs.existsSync(path.join(d, `${process.pid}${LEASE_SUFFIX}`))).toBe(false)
  })

  // COUNTS ITSELF. Registering after counting would let two runs starting together both see zero
  // peers and both take every core — the race this exists to prevent.
  it('counts an existing peer and halves the budget', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${process.pid}${LEASE_SUFFIX}`), '{}') // a live "peer"
    // Claim under a different pid so the peer above is genuinely a second run.
    const { budget, liveRuns } = claim({ cores: 4, dir: d, pid: process.pid + 1 })
    expect(liveRuns).toBe(2)
    expect(budget).toBe(2)
  })

  it('ignores a dead peer, so a crashed run does not shrink this one', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${DEAD_PID}${LEASE_SUFFIX}`), '{}')
    const { budget, liveRuns } = claim({ cores: 4, dir: d, pid: process.pid })
    expect(liveRuns).toBe(1)
    expect(budget).toBeNull()
  })

  it('imposes nothing, and does not throw, when the directory cannot be used', () => {
    // A path whose parent is a FILE cannot be mkdir'd. The bound must degrade, not break the run.
    const f = path.join(tmpDir(), 'afile')
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, 'x')
    const { budget, liveRuns } = claim({ cores: 4, dir: path.join(f, 'sub'), pid: process.pid })
    expect(budget).toBeNull()
    expect(liveRuns).toBe(1)
  })

  it('honours the SHORESH_NO_WORKER_BUDGET escape hatch', () => {
    const d = tmpDir()
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `${process.pid}${LEASE_SUFFIX}`), '{}')
    process.env.SHORESH_NO_WORKER_BUDGET = '1'
    try {
      const { budget, liveRuns } = claim({ cores: 4, dir: d, pid: process.pid + 1 })
      expect(budget).toBeNull()
      expect(liveRuns).toBe(1)
      // And it writes nothing, so an opted-out run does not shrink anyone else either.
      expect(fs.existsSync(path.join(d, `${process.pid + 1}${LEASE_SUFFIX}`))).toBe(false)
    } finally {
      delete process.env.SHORESH_NO_WORKER_BUDGET
    }
  })
})

describe('leaseDir', () => {
  it('is one directory per repository key, under tmp', () => {
    expect(leaseDir('abc', '/tmp')).toBe('/tmp/shoresh-vitest-abc')
  })
})
