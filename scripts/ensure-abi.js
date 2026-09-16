#!/usr/bin/env node
// Make the better-sqlite3 native binary match whoever is about to load it —
// Node (Vitest) or Electron (the real app) — without the human having to
// remember which rebuild to run.
//
// better-sqlite3 is a native module, so its compiled .node is tied to one ABI.
// Node and Electron use DIFFERENT ABIs, so flipping between `npm test` and
// `npm run electron:dev` needs a rebuild each way. Doing that by hand ("reinstall
// a package every time") is the friction this removes: `pretest` ensures the
// Node build, `preelectron:dev` ensures the Electron build, and this script is a
// fast no-op when the binary already matches — so only an actual switch pays.
//
// How it knows without recompiling to check: it records the last target it
// built for in .abi-target (gitignored) — but the marker is a fast HINT, not
// the authority. T44: under concurrent agent sessions running
// electron-rebuild/npm rebuild at the same time, the binary can vanish while
// the marker still says "built for node:XXX" — a marker lying about reality,
// the same failure class scripts/verifyNativeAbi.js (T20) was written for.
// So this script asks the binary, not the build config: it probes the
// compiled .node the same way verifyNativeAbi.classifyLoad does, and only
// skips the rebuild when the marker AND the observed binary agree. If the
// marker is ever wrong, the worst case is one unnecessary rebuild — never a
// silently mismatched or missing binary, because a mismatch is exactly what
// triggers the rebuild.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import path from 'node:path'
import { MODULE_REL, classifyLoad, probeUnderNode } from './verifyNativeAbi.js'

const require = createRequire(import.meta.url)
const MARKER = new URL('../.abi-target', import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The signature that has to match for the current binary to be loadable. Node's
// ABI is process.versions.modules; Electron's is pinned by its version, so the
// version string is a sufficient and stable proxy.
function signatureFor(which) {
  if (which === 'node') return `node:${process.versions.modules}`
  const electronVersion = require('electron/package.json').version
  return `electron:${electronVersion}`
}

// Pure decision: given the wanted signature, the marker's recorded signature,
// and what the compiled binary actually is (as classifyLoad would report,
// plus 'missing' when there is no file at all), decide whether to rebuild and
// why. Testable without a real rebuild or a real binary on disk.
export function decide({ target, want, have, binaryClass }) {
  if (have !== want) {
    return { rebuild: true, reason: 'marker-stale', message: `marker says ${have ?? 'unknown'}, want ${want}` }
  }
  if (binaryClass === 'missing') {
    return { rebuild: true, reason: 'binary-missing', message: `marker says ${want} but no binary is on disk (T44: vanished under concurrent rebuild)` }
  }
  const confirmsTarget = target === 'node' ? binaryClass === 'node' : binaryClass === 'electron'
  if (!confirmsTarget) {
    return { rebuild: true, reason: 'binary-mismatch', message: `marker says ${want} but the binary on disk is actually built for ${binaryClass === 'node' ? 'node' : binaryClass === 'electron' ? 'electron' : 'an unknown runtime'}` }
  }
  return { rebuild: false, reason: 'confirmed', message: `binary confirmed built for ${want}` }
}

export function classifyBinary(root) {
  const modulePath = path.join(root, MODULE_REL)
  if (!existsSync(modulePath)) return 'missing'
  return classifyLoad(probeUnderNode(modulePath))
}

// The at-rest-encryption driver (better-sqlite3-multiple-ciphers) is a fork of
// better-sqlite3 and loads through the SAME `require('bindings')('better_sqlite3.node')`
// call, which resolves `build/Release/better_sqlite3.node` first. The fork ships
// a prebuild at `bin/darwin-x64-148/better-sqlite3-multiple-ciphers.node` — WRONG
// dir AND wrong name — so unless it is rebuilt into its own build/Release the
// packaged app fails to load it under encryption (T175 finding 2, seen in the
// real-app run). electron-rebuild produces exactly that path, mirroring the
// non-fork. This only matters for the Electron target: Vitest (node) never
// touches the fork, and the fork is an OPTIONAL dependency — absent on machines
// that never installed it. So: rebuild it only when building for Electron, only
// when it is installed, and only when its binary is not already the Electron ABI.
export const FORK_MODULE = 'better-sqlite3-multiple-ciphers'
export const FORK_MODULE_REL = `node_modules/${FORK_MODULE}/build/Release/better_sqlite3.node`

export function classifyForkBinary(root) {
  const modulePath = path.join(root, FORK_MODULE_REL)
  if (!existsSync(modulePath)) return 'missing'
  return classifyLoad(probeUnderNode(modulePath))
}

// Pure decision, testable without a real build: should we (re)build the fork's
// Electron-ABI binary into its resolvable build/Release path?
export function decideFork({ target, forkInstalled, forkBinaryClass }) {
  if (target !== 'electron') return { rebuild: false, reason: 'not-electron' }
  if (!forkInstalled) return { rebuild: false, reason: 'not-installed' }
  if (forkBinaryClass === 'electron') return { rebuild: false, reason: 'confirmed' }
  return { rebuild: true, reason: forkBinaryClass === 'missing' ? 'binary-missing' : 'binary-mismatch' }
}

// T44 self-heal: clear out a possibly half-populated build dir before
// rebuilding. A from-scratch build dir is what rebuild does semantically
// anyway — this just makes that explicit instead of leaving gyp to build on
// top of whatever an interrupted or concurrent rebuild left behind, which is
// the same "marker says built, binary doesn't back it up" race decide() above
// already has to detect and recover from.
function clearBuildDir() {
  const buildDir = fileURLToPath(new URL('../node_modules/better-sqlite3/build', import.meta.url))
  rmSync(buildDir, { recursive: true, force: true })
}

// execFileSync launches a binary directly (no shell), and on Windows `npm`
// resolves to `npm.cmd` — a batch file that CreateProcess cannot launch
// without going through a shell, so plain `npm` fails with ENOENT there.
// `npm.cmd` is the correct binary name on win32; plain `npm` elsewhere.
export function npmBinaryFor(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

function rebuild(target) {
  clearBuildDir()
  if (target === 'node') {
    // Rebuild against the running Node's ABI.
    execFileSync(npmBinaryFor(process.platform), ['rebuild', 'better-sqlite3'], { stdio: 'inherit' })
  } else {
    // Rebuild against Electron's ABI. -f forces even if it looks current; -w
    // scopes the work to just this one native module. The CLI is addressed by
    // its file path, not require.resolve('@electron/rebuild/lib/cli.js') — the
    // package's "exports" map hides that subpath, so resolving it throws.
    const bin = fileURLToPath(new URL('../node_modules/@electron/rebuild/lib/cli.js', import.meta.url))
    execFileSync(process.execPath, [bin, '-f', '-w', 'better-sqlite3'], { stdio: 'inherit' })
  }
}

// Is the optional fork actually installed? Its package dir is present only when
// `npm install` resolved the optionalDependency (it fails to build on some
// toolchains and is skipped — that is by design; the default keyless path uses
// the non-fork driver). Probing the package.json, not the .node, so a
// not-yet-built-for-electron install still counts as installed.
export function forkIsInstalled(root) {
  return existsSync(path.join(root, 'node_modules', FORK_MODULE, 'package.json'))
}

// Best-effort: rebuild the fork for Electron's ABI into its build/Release. NEVER
// fatal — the fork is optional and encryption is OFF by default, so a failure
// here must not break the normal (keyless, non-fork) build. It just means the
// encrypting driver won't load until the build is fixed, which fails CLOSED with
// a clear message rather than corrupting anything.
function rebuildFork() {
  try {
    const bin = fileURLToPath(new URL('../node_modules/@electron/rebuild/lib/cli.js', import.meta.url))
    execFileSync(process.execPath, [bin, '-f', '-w', FORK_MODULE], { stdio: 'inherit' })
    console.log(`ensure-abi: ${FORK_MODULE} rebuilt for Electron (at-rest-encryption driver).`)
    return true
  } catch {
    console.warn(`ensure-abi: WARNING — could not rebuild ${FORK_MODULE} for Electron. The default`)
    console.warn('  (unencrypted) driver is unaffected; at-rest encryption would fail closed until fixed:')
    console.warn(`  npx electron-rebuild -f -w ${FORK_MODULE}`)
    return false
  }
}

function main() {
  const target = process.argv[2]
  if (target !== 'node' && target !== 'electron') {
    console.error(`ensure-abi: expected "node" or "electron", got ${JSON.stringify(target)}`)
    process.exit(2)
  }

  // The fork (at-rest-encryption driver) rides the Electron target too, and can
  // need its own rebuild even when the non-fork binary is already current — so
  // decide it separately and run it before any early exit.
  const forkPlan = decideFork({
    target,
    forkInstalled: forkIsInstalled(ROOT),
    forkBinaryClass: classifyForkBinary(ROOT),
  })

  const want = signatureFor(target)
  const have = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : null
  const binaryClass = classifyBinary(ROOT)
  const result = decide({ target, want, have, binaryClass })

  if (!result.rebuild) {
    console.log(`ensure-abi: better-sqlite3 already built for ${want} — nothing to do.`)
    if (forkPlan.rebuild) rebuildFork()
    process.exit(0)
  }

  if (result.reason !== 'marker-stale') {
    console.log(`ensure-abi: marker said ${want} but that's stale — ${result.message}.`)
  }
  console.log(`ensure-abi: rebuilding better-sqlite3 for ${want} (was ${have ?? 'unknown'})…`)

  try {
    rebuild(target)
  } catch {
    console.error(`ensure-abi: rebuild for ${target} failed. Run it by hand to see why:`)
    console.error(target === 'node'
      ? '  npm rebuild better-sqlite3'
      : '  npx electron-rebuild -f -w better-sqlite3')
    process.exit(1)
  }

  writeFileSync(MARKER, `${want}\n`)
  console.log(`ensure-abi: done — better-sqlite3 now built for ${want}.`)

  if (forkPlan.rebuild) rebuildFork()
}

if (process.argv[1] && process.argv[1].endsWith('ensure-abi.js')) {
  main()
}
