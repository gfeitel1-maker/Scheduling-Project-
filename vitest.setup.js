// Global test setup — runs in every test file's environment before the file.
//
// Raises React Testing Library's async-utility budget (the timeout shared by
// waitFor / findBy / waitForElementToBeRemoved) from its 1000ms default to
// 3000ms, for the SAME reason vite.config.js raises testTimeout: on a busy
// 4-core machine (several agent sessions each running this suite) a green run
// otherwise depends on how busy the machine is.
//
// Measured, not guessed. This budget is INDEPENDENT of testTimeout — a test can
// sit well inside its 20000ms test budget yet still fail because a single
// waitFor blew its own 1000ms. The heaviest async-settle in the suite is
// ScheduleScreen's initial load (~12 sequential localClient calls); the
// useScheduleData hook behind it resolves in ~130ms idle. The config comment for
// testTimeout records ~8x contention under concurrent agent sessions, and
// 130ms x 8 ~= 1040ms — i.e. the default 1000ms sits exactly on the edge under
// the load the repo already documents, which is why waitFor-heavy files fail a
// different subset each run. 3000ms clears that ~8x case with headroom while
// staying far below testTimeout, so a genuinely stuck async still fails
// deterministically (via testTimeout) rather than hanging.
//
// 3000ms is the value ScheduleScreen.test.jsx had already adopted locally for
// its own load; this makes that protection the floor for all ~340 waitFor call
// sites instead of one file. If this ever needs raising again, measure first and
// record the numbers, as here — a rising timeout is the symptom, not the fix.
import { configure } from '@testing-library/dom'

configure({ asyncUtilTimeout: 3000 })

// PIN hashing cost, lowered for the suite and ONLY for the suite.
//
// T150 raised scrypt to N=2^16, ~430ms a hash. That is the right price for one
// login a person waits on, and the wrong price for a suite that creates users
// constantly: localAuth.test.js went from seconds to three minutes and one test
// began timing out on six hashes, and every other file that seeds a camp pays
// the same toll. Left alone, the pressure is always to raise the timeout — and
// the end of that road is a suite nobody runs.
//
// Safe because hashes are SELF-DESCRIBING: one minted cheaply still verifies at
// the cost it was minted with, so nothing about the verification path is
// bypassed. What must not happen is the low cost silently shipping, so
// localAuth.test.js pins the production default AND mints one hash at the real
// cost end to end. This setter is the only way to change it and lives in the
// only file that should ever call it.
//
// Deliberately at setup level rather than per file: a new test that seeds a
// user should not have to know this exists to run at a sane speed.
import { setScryptParamsForTests } from './electron/auth/localAuth.js'

setScryptParamsForTests({ N: 1024, maxmem: 32 * 1024 * 1024 })
