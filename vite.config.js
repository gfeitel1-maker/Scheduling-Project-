import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// The one directory-shaped set of test files that may run WITHOUT per-file process
// isolation (T188 §6 / F3). Measured on 66 files, interleaved ON/OFF/ON/OFF:
// 35s/26s isolated vs 7s/6s not — ~4.7x, because per-file isolation costs a process
// fork per file and these files are individually fast.
//
// WHY THIS LIST IS DIRECTORIES AND NOT A CLEVERER RULE. The first cut of this
// selected files by grepping for hazards (openLocalDb, libp2p, WebSocket, jsdom, …)
// and covered 170 files for ~6x. That is a DENYLIST, and a denylist fails OPEN: a
// test file added later that genuinely needs isolation, but happens not to match the
// hazard list, silently joins the unisolated project and contaminates its neighbours
// in a way that surfaces weeks later as order-dependent flakiness. The extra ~36s was
// not worth a rule whose failure mode is silent.
//
// This list fails CLOSED instead. Anything not named here keeps full isolation, so a
// new file is safe by default and opting out is a deliberate, reviewable edit.
//
// THE BAR FOR ADDING A DIRECTORY: every test file in it must be pure — no SQLite (no
// openLocalDb, no openTemplatedDb), no native module, no libp2p/WebSocket, no jsdom
// or Testing Library, no child_process — AND no module-level mutable state that two
// test files in one worker could share. Directory-wide, not file-by-file: a MIXED
// directory does not qualify, because the next file added to it would inherit the
// exemption silently. `src/engine` is listed with an explicit single exclusion rather
// than as a blanket entry, for exactly that reason.
//
// vitest.setup.js, env, timeouts and excludes are shared by both projects via
// `sharedTest` below — a project that quietly lost setupFiles or SHORESH_TEST_SCRYPT_N
// would change behaviour, not just speed.
// NO EXCEPTIONS ARE PERMITTED IN THIS LIST, and that is a structural decision, not
// tidiness. The first draft listed `src/engine/**` too, with a single carve-out for
// src/engine/fixtureSchemaParity.test.js (the one engine test that opens a database).
// The two projects are defined as include-here / exclude-there, so a file excluded
// from the fast project was ALSO excluded from the isolated one — it matched the
// directory glob that the isolated project subtracts. It ran in NEITHER project and
// silently stopped being tested. Caught by diffing collected files before and after;
// nothing else would have reported it, because a test that does not run does not fail.
//
// So: whole directories where EVERY file qualifies, or not at all. If a directory
// needs a carve-out, it does not go in this list. src/engine is therefore absent
// despite 10 of its 11 files qualifying — worth ~4s, and not worth a shape whose
// failure mode is a test quietly disappearing.
export const UNISOLATED_INCLUDE = [
  'src/ingest/**/*.test.{js,jsx}',
]

const sharedTest = {
    environment: 'node',
    globals: true,
    // PIN hashing cost, lowered for the suite and ONLY for the suite (T160).
    //
    // T150 raised scrypt to N=2^16, ~430ms a hash — right for one login a
    // person waits on, wrong for a suite that creates users constantly.
    // electron/main.test.js took FIFTEEN MINUTES and several login tests hit
    // the 20s per-test timeout. Left alone the pressure is always to raise the
    // timeout, and the end of that road is a suite nobody runs.
    //
    // Safe because hashes are SELF-DESCRIBING: one minted cheaply still
    // verifies at the cost it was minted with, so no verification path is
    // bypassed. localAuth.test.js pins the production default AND mints one
    // hash at the real cost end to end, so this can never quietly become what
    // ships.
    //
    // An env var rather than a setup-file import, deliberately — see the note
    // at the read site in electron/auth/localAuth.js. Importing it into every
    // test environment cost 6.5 minutes of setup time across ~340 files.
    env: { SHORESH_TEST_SCRYPT_N: '1024' },
    // electron-builder copies the whole project — including every *.test.js —
    // into release/. Without this, `npm run test` after `npm run electron:build`
    // collects two copies of the suite, and the duplicated syncServer tests
    // bind the same WebSocket ports concurrently and fail on contention. The
    // failures look like real sync regressions and are not.
    // '.claude/worktrees' is the same problem from a different direction: an
    // agent worktree is a full checkout inside the project, so collection picks
    // up another branch's suite alongside this one. Observed 2026-07-28 — the
    // count went 678 -> 1367 and the duplicated sync tests contended for the
    // same WebSocket ports, failing exactly as the release/ copies did.
    // 'test/fixtures/**' matters more than it looks: a fixture file named *.test.js is collected
    // as a REAL spec otherwise. test/fixtures/specDirs/has-tests/src/foo.test.js is the literal
    // word `test`, existing only so a predicate can be asked whether a directory contains a test
    // file — and it was being handed to vitest as part of the suite.
    exclude: ['**/node_modules/**', '**/dist/**', 'release/**', '**/.claude/worktrees/**', 'test/fixtures/**'],
    // T25: the default 5000ms per-test budget made a green run depend on how
    // busy the machine was. Six identical full runs on 2026-07-31 produced
    // three greens and three reds, with a different set of tests failing each
    // time and every red run a slow one.
    //
    // Measured, not guessed. `electron/main.test.js` run alone: 14.6s for 95
    // tests, slowest single test 1535ms. The same file inside the full suite:
    // 118s. That is ~8x contention, and it is not because the file is slow —
    // it is 56 test files (sqlite native, jsdom, real WebSocket servers) on a
    // 4-core machine, usually alongside other agent sessions.
    //
    // 1535ms x 8 = ~12s, so 20s clears the worst observed case with headroom
    // while still being far below "hung". A test that genuinely never resolves
    // still fails here; only the contention noise is absorbed.
    //
    // If this ever needs raising again, measure first and record the numbers,
    // as here. Do not treat a rising timeout as the fix — it is the symptom.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Runs before every test file. Raises RTL's waitFor/findBy budget from its
    // 1000ms default to 3000ms so a green run does not depend on machine load —
    // the same contention concern as testTimeout above, at a different layer
    // (waitFor's budget is independent of testTimeout). See vitest.setup.js for
    // the measurements.
    setupFiles: ['./vitest.setup.js'],
}

export default defineConfig({
  // Relative asset paths so the packaged app can load index.html over file://
  // (Electron uses loadFile in production; an absolute "/" base would 404).
  base: './',
  plugins: [react()],
  test: {
    ...sharedTest,
    projects: [
      {
        // Everything else — unchanged behaviour, full per-file isolation.
        test: {
          ...sharedTest,
          name: 'isolated',
          exclude: [...sharedTest.exclude, ...UNISOLATED_INCLUDE],
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'pure',
          include: UNISOLATED_INCLUDE,
          isolate: false,
        },
      },
    ],
  },
  server: {
    port: 5200,
    strictPort: true,
  },
})
