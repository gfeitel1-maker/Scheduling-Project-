// Guards electronStub.mjs against missing `app.*` members that
// electron/main.js's module-load-time startup calls before the process is
// ever recognisably "Electron" — the failure mode that bit T251's manual
// acceptance walk (app.setName is not a function, called from
// applyUserDataPath at electron/main.js's top-level IIFE).
//
// Runs a real `node` process through registerElectronStub.mjs, the same way
// scripts/fixtures/electiveAcceptanceCamp.mjs does, and imports electron/main.js
// for real. A stub missing a method main.js calls at module load surfaces here
// as "X is not a function" in stderr — the exact string this test asserts
// against.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('electron stub loader', () => {
  it('lets electron/main.js load without "is not a function" on any stubbed app member', () => {
    // electron/main.js's module-load startup is gated on `!process.env.VITEST`
    // (it must stay inert under the real vitest suite, which mocks `electron`
    // itself). This test exercises the OTHER caller — a plain `node` process,
    // exactly how scripts/fixtures/electiveAcceptanceCamp.mjs runs it — so the
    // child must NOT inherit vitest's own VITEST env var, or this assertion
    // passes vacuously without ever running the code path it's guarding.
    const childEnv = { ...process.env }
    delete childEnv.VITEST
    const result = spawnSync(
      process.execPath,
      [
        '--import', './scripts/fixtures/registerElectronStub.mjs',
        '--input-type=module',
        '-e', "await import('./electron/main.js'); console.error('LOADED_OK'); process.exit(0);",
      ],
      { cwd: repoRoot, encoding: 'utf8', env: childEnv }
    )
    const output = `${result.stdout}${result.stderr}`
    expect(output).not.toMatch(/is not a function/)
    expect(output).toMatch(/LOADED_OK/)
  })
})
