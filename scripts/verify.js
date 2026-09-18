// The quality gate — runs VERIFY_STEPS below, in order, stopping at the first failure.
//
// Why this exists instead of a bare `a && b && c` npm chain: a chain prints no
// verdict, so `npm run verify 2>&1 | tail -N` (a common way to fit the long output
// under a tool/time budget) shows only the last step's trailing lines AND reports
// tail's exit code (always 0) rather than the gate's. That masks a real red as a
// false green. This wrapper ALWAYS prints a final, unmistakable verdict line in the
// output text — so the truth survives any tail-piping — and exits with the real code.
// See memory: feedback-gate-exit-code-not-tail.
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import { acquire, lockPath, repoKey } from './gateLock.js'

// ORDER IS LOAD-BEARING: cheapest first, because runVerify short-circuits on the first failure.
//
// The original order ran the two cheapest checks LAST, behind `test`. Measured 2026-09-16 (T188,
// quiet machine, 4 cores): agents:check 0.2s · check:governance 1.2s · security 5.9s ·
// test:integration 20.6s · lint 131.3s · test 1015.0s. So a `check:governance` failure — a doc
// field that resolves in 1.2s — was only reported after ~1174s of gate had already run, and the
// re-run after fixing it paid the full ~1174s again to re-prove tests a docs change cannot affect.
// One governance typo cost ~39 minutes of gate time.
//
// `build` joined the list on 2026-09-17 (T188 §7.1). It had been named as a gate by
// TESTING_STANDARD.md for months while never actually being one — `git log -S` showed it was never
// in this array. It costs 2.8s, cheaper than `security`, and it is the only step that exercises the
// bundler: a broken import in the renderer fails `npm run build` and passes every test. The repo has
// already shipped a packaged crash from exactly that gap (ERR_MODULE_NOT_FOUND, build.files not
// shipping src/**). Verified non-vacuous by planting a bad import and watching it exit 1.
//
// Sorting by measured cost makes the gate report the same verdict for the same tree, just sooner:
// no step is removed, added, or weakened, and every step still runs on a green tree. If a step's
// cost changes materially, re-measure and re-sort — the ordering is the only thing this list
// encodes, and it is not alphabetical, historical, or conceptual.
export const VERIFY_STEPS = [
  'agents:check',
  'check:governance',
  // tier 3 (fetch) in generate-licenses.js is bounded by its own FETCH_TIMEOUT_MS, so
  // this step's worst case stays bounded even when the registry is unreachable.
  'licenses:check',
  'build',
  'security',
  'test:integration',
  'lint',
  'test',
]

// T164/T178: a test run on a badly oversubscribed machine has not discovered anything about the CODE
// — ordinary tests measured at 400-500s at load 66 on 4 cores, purely because the machine was
// swamped. A red under that condition trains people to re-run, and re-running is the habit that lets
// a regression through. So a *load-timeout* failure is reported as a THIRD answer — INCONCLUSIVE, not
// FAILED (still non-zero, never a false green). Same 0/1/2 shape gateResultCode.sh uses (T171).
//
// T178 — TWO FILTERS, because the first cut of this laundered two REAL defects into "probably fine"
// (measured 2026-09-16: a 295ms `test` failure = a missing doc field; `check:governance` failing at
// load 9.8 = platform-state-stale). A downgrade is only honest when BOTH hold:
//   1. The step is LOAD-SENSITIVE. Only test/test:integration race real timers/timeouts; lint,
//      agents:check, security, check:governance are deterministic and load never makes them fail.
//   2. The failure was SLOW. A genuine load timeout takes tens of seconds; a sub-2s assertion failure
//      is a real defect, not a load artifact. Require the failing step to have run ≥ MIN_LOAD_TIMEOUT_MS.
// The honest case both filters preserve: the libp2p convergence test failing at ~35s under load and
// passing at ~21s quiet (same commit).
export const LOAD_SENSITIVE_STEPS = new Set(['test', 'test:integration'])
export const MIN_LOAD_TIMEOUT_MS = 10_000

// The threshold is deliberately high: normal concurrent-session load in this repo runs a few times
// oversubscribed by design, so only GENUINE swamping — the 1-minute load average at 4x the core
// count or more — trips it. `factor` is injectable for tests.
export function machineLoadVerdict(load1, cores, { factor = 4 } = {}) {
  if (!Number.isFinite(load1) || !Number.isFinite(cores) || cores <= 0) return 'ok' // unknown → don't relabel
  return load1 >= cores * factor ? 'oversubscribed' : 'ok'
}

// Pure: map "what failed (or null)" + machine state → the verdict line + process exit code.
// `failed` is `{ step, ms }` (ms = how long the failing step ran) or a bare step string (ms unknown)
// or null. oversubscribed is only consulted WHEN a step failed — a passing run is always exit 0.
export function verdict(failed, { oversubscribed = false } = {}) {
  if (failed) {
    const step = typeof failed === 'string' ? failed : failed.step
    const ms = typeof failed === 'string' ? undefined : failed.ms
    const loadSensitive = LOAD_SENSITIVE_STEPS.has(step)
    const slow = typeof ms === 'number' && ms >= MIN_LOAD_TIMEOUT_MS
    // Downgrade to INCONCLUSIVE only for a slow failure of a load-sensitive step under real
    // oversubscription. A fast failure, a deterministic step, or an unknown duration stays a plain
    // FAILED — never launder a real defect into "probably fine".
    if (oversubscribed && loadSensitive && slow) {
      return {
        line:
          `⚠️  VERIFY INCONCLUSIVE — step "${step}" failed after ${(ms / 1000).toFixed(0)}s while this ` +
          `machine was oversubscribed (1-min load ≥ 4× cores). A load-sensitive step timing out under ` +
          `that load is very likely a load artifact, not a defect. Re-run it in isolation on a quiet ` +
          `machine before concluding anything. This is NOT a pass.`,
        code: 2,
      }
    }
    return { line: `❌ VERIFY FAILED at step: ${step}`, code: 1 }
  }
  return {
    line: `✅ VERIFY PASSED — ${VERIFY_STEPS.join(' + ')} all green`,
    code: 0,
  }
}

// Run each step in order via `run(step)` (returns the step's exit code). Returns `{ step, ms }` for
// the first failing step (ms = how long it ran, so verdict() can tell a load timeout from a fast
// assertion failure — T178), or null if all passed. Short-circuits on first failure. `now` injectable
// for tests.
export function runVerify(steps = VERIFY_STEPS, run = defaultRun, now = Date.now) {
  for (const step of steps) {
    // eslint-disable-next-line no-console
    console.log(`\n▶ npm run ${step}`)
    const started = now()
    if (run(step) !== 0) return { step, ms: now() - started }
  }
  return null
}

function defaultRun(step) {
  return spawnSync('npm', ['run', step], { stdio: 'inherit' }).status ?? 1
}

// Execute only when invoked directly (`node scripts/verify.js`), not when imported by
// the test. import.meta guards keep the module side-effect-free under Vitest.
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/verify.js')
if (invokedDirectly) {
  // Serialise gates machine-wide. Three concurrent runs were observed on 2026-09-16 (load 267 on 4
  // cores); each was several times slower than it would have been alone. SHORESH_VERIFY_NO_LOCK=1
  // bypasses this — deliberately available, deliberately not the default.
  let releaseLock = () => {}
  if (process.env.SHORESH_VERIFY_NO_LOCK !== '1') {
    const file = lockPath(repoKey())
    releaseLock = acquire({
      file,
      onWait: (holder) => {
        const who = holder
          ? `pid ${holder.pid}, started ${holder.startedAt}${holder.cwd ? `, in ${holder.cwd}` : ''}`
          : 'an unidentified process'
        console.log(
          `\n⏳ Another gate is already running (${who}).\n` +
            `   Waiting for it — running both would make both slower. Ctrl-C to abort, or set\n` +
            `   SHORESH_VERIFY_NO_LOCK=1 to run anyway.`
        )
      },
    })
    // Release on interrupt too; a killed gate must not wedge the next one. (A stale lock is also
    // reclaimed by pid probe, so this is belt-and-braces rather than the only protection.)
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        releaseLock()
        process.exit(130)
      })
    }
  }

  const failed = runVerify() // { step, ms } | null
  // Measure load AFTER the run: the 1-minute average at this point reflects the load the suite just
  // ran under (a verify run takes minutes). Only consulted if something failed.
  const oversubscribed =
    !!failed && machineLoadVerdict(os.loadavg()[0], os.cpus().length) === 'oversubscribed'
  const v = verdict(failed, { oversubscribed })
  releaseLock()
  // eslint-disable-next-line no-console
  console.log('\n' + '═'.repeat(60) + '\n' + v.line)
  process.exit(v.code)
}
