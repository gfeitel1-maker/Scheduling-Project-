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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
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

function rebuild(target) {
  if (target === 'node') {
    // Rebuild against the running Node's ABI.
    execFileSync('npm', ['rebuild', 'better-sqlite3'], { stdio: 'inherit' })
  } else {
    // Rebuild against Electron's ABI. -f forces even if it looks current; -w
    // scopes the work to just this one native module. The CLI is addressed by
    // its file path, not require.resolve('@electron/rebuild/lib/cli.js') — the
    // package's "exports" map hides that subpath, so resolving it throws.
    const bin = fileURLToPath(new URL('../node_modules/@electron/rebuild/lib/cli.js', import.meta.url))
    execFileSync(process.execPath, [bin, '-f', '-w', 'better-sqlite3'], { stdio: 'inherit' })
  }
}

function main() {
  const target = process.argv[2]
  if (target !== 'node' && target !== 'electron') {
    console.error(`ensure-abi: expected "node" or "electron", got ${JSON.stringify(target)}`)
    process.exit(2)
  }

  const want = signatureFor(target)
  const have = existsSync(MARKER) ? readFileSync(MARKER, 'utf8').trim() : null
  const binaryClass = classifyBinary(ROOT)
  const result = decide({ target, want, have, binaryClass })

  if (!result.rebuild) {
    console.log(`ensure-abi: better-sqlite3 already built for ${want} — nothing to do.`)
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
}

if (process.argv[1] && process.argv[1].endsWith('ensure-abi.js')) {
  main()
}
