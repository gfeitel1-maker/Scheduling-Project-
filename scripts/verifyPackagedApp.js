#!/usr/bin/env node
// Post-package gate: prove the app electron-builder just produced can actually
// open its encrypted database. Encryption is default ON, so a bundle without a
// loadable better-sqlite3-multiple-ciphers cannot start on a fresh install —
// and the build itself used to succeed anyway (the driver was an optional
// dependency that silently failed to compile).
//
//   1. the driver package and a compiled .node are inside the bundle
//   2. that .node loads under the PACKAGED Electron (ELECTRON_RUN_AS_NODE) and opens a db
//   3. the same for node-datachannel (WAN hole-punch transport): its prebuilt N-API
//      binary ships in a per-platform @node-datachannel/* package, which electron-builder
//      copies but never rebuilds (no binding.gyp), so the probe constructs a PeerConnection
//   4. with --launch: the packaged app boots against a throwaway userData dir and
//      reaches the renderer heartbeat (the same marker scripts/deploy-local.sh waits for)
//
// Runs as `postelectron:build`, so `npm run electron:build` cannot succeed without it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DRIVER = 'better-sqlite3-multiple-ciphers'
const SENTINEL = 'DRIVER_OK'
const DATACHANNEL = 'node-datachannel'
// The release targets (mac arm64/x64, win x64). npm installs only the host's prebuilt,
// so the lockfile is where a dropped platform would show.
const DATACHANNEL_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc']

export function findPackagedApp(root) {
  const release = path.join(root, 'release')
  if (!fs.existsSync(release)) return null
  for (const d of fs.readdirSync(release).filter((n) => n.startsWith('mac')).sort()) {
    const app = path.join(release, d, 'Shoresh.app')
    if (fs.existsSync(app)) return app
  }
  return null
}

function listNodeFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listNodeFiles(p))
    else if (e.name.endsWith('.node')) out.push(p)
  }
  return out
}

export function checkPackagedDriver(appDir) {
  const pkg = path.join(appDir, 'node_modules', DRIVER)
  if (!fs.existsSync(pkg)) {
    return { ok: false, reason: 'driver-missing', message: `${DRIVER} is not in the bundle (${pkg}). The app cannot start with encryption on.` }
  }
  const binaries = listNodeFiles(pkg)
  if (binaries.length === 0) {
    return { ok: false, reason: 'no-native-binary', message: `${DRIVER} is in the bundle but has no compiled .node.` }
  }
  return { ok: true, binaries }
}

export function checkPackagedDatachannel(appDir) {
  const pkg = path.join(appDir, 'node_modules', DATACHANNEL)
  if (!fs.existsSync(pkg)) {
    return { ok: false, reason: 'datachannel-missing', message: `${DATACHANNEL} is not in the bundle (${pkg}). The WAN punch transport cannot load.` }
  }
  const scope = path.join(appDir, 'node_modules', '@node-datachannel')
  const binaries = fs.existsSync(scope) ? listNodeFiles(scope) : []
  if (binaries.length === 0) {
    return { ok: false, reason: 'no-native-binary', message: `${DATACHANNEL} is in the bundle but no @node-datachannel/* prebuilt .node shipped.` }
  }
  return { ok: true, binaries }
}

export function checkLockfilePlatforms(lock) {
  const missing = DATACHANNEL_PLATFORMS.filter((p) => !lock.packages?.[`node_modules/@node-datachannel/${p}`])
  if (missing.length === 0) return { ok: true }
  return { ok: false, message: `package-lock.json has no ${DATACHANNEL} prebuilt for: ${missing.join(', ')}` }
}

export function interpretLoadProbe({ status, stdout, stderr }, name = DRIVER) {
  if (status === 0 && String(stdout).includes(SENTINEL)) return { ok: true }
  return { ok: false, reason: 'load-failed', message: `${name} did not load under the packaged Electron (exit ${status}): ${String(stderr).trim() || String(stdout).trim() || '(no output)'}` }
}

function loadProbe(executable, appDir) {
  const driverPath = path.join(appDir, 'node_modules', DRIVER)
  const script = `const D=require(${JSON.stringify(driverPath)});new D(':memory:').close();console.log(${JSON.stringify(SENTINEL)})`
  const r = spawnSync(executable, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 })
  return interpretLoadProbe({ status: r.status, stdout: r.stdout, stderr: r.error ? String(r.error) : r.stderr })
}

function datachannelProbe(executable, appDir) {
  const modPath = path.join(appDir, 'node_modules', DATACHANNEL)
  const script = `const n=require(${JSON.stringify(modPath)});const pc=new n.PeerConnection('probe',{iceServers:[]});pc.close();n.cleanup();console.log(${JSON.stringify(SENTINEL)});process.exit(0)`
  const r = spawnSync(executable, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000 })
  return interpretLoadProbe({ status: r.status, stdout: r.stdout, stderr: r.error ? String(r.error) : r.stderr }, DATACHANNEL)
}

async function launchSmoke(executable, timeoutS) {
  const nonce = crypto.randomUUID()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pkg-smoke-'))
  const marker = path.join(userData, 'deploy-smoke-marker.json')
  const child = spawn(executable, [], { env: { ...process.env, SHORESH_SMOKE_NONCE: nonce, SHORESH_SMOKE_USERDATA: userData }, stdio: 'ignore' })
  let exited = false
  child.on('exit', () => { exited = true })
  try {
    for (let s = 0; s < timeoutS; s++) {
      if (fs.existsSync(marker)) {
        try {
          if (JSON.parse(fs.readFileSync(marker, 'utf8')).nonce === nonce) return { ok: true }
        } catch { /* partial write; keep polling */ }
      }
      if (exited) return { ok: false, message: 'packaged app exited before reaching the smoke heartbeat' }
      await new Promise((r) => setTimeout(r, 1000))
    }
    return { ok: false, message: `no smoke heartbeat within ${timeoutS}s` }
  } finally {
    child.kill()
    fs.rmSync(userData, { recursive: true, force: true })
  }
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const appBundle = findPackagedApp(root)
  const fail = (m) => { console.error(`\nPACKAGED APP CHECK FAILED\n${m}\n`); process.exit(1) }
  if (!appBundle) fail(`No release/mac*/Shoresh.app found under ${root}. Run npm run electron:build first.`)
  const appDir = path.join(appBundle, 'Contents/Resources/app')
  const executable = path.join(appBundle, 'Contents/MacOS/Shoresh')

  const tree = checkPackagedDriver(appDir)
  if (!tree.ok) fail(tree.message)
  console.log(`verify:packaged: ${DRIVER} present (${tree.binaries.length} native binary)`)

  const probe = loadProbe(executable, appDir)
  if (!probe.ok) fail(probe.message)
  console.log(`verify:packaged: ${DRIVER} loads and opens a database under the packaged Electron`)

  const lock = checkLockfilePlatforms(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')))
  if (!lock.ok) fail(lock.message)
  console.log(`verify:packaged: ${DATACHANNEL} prebuilts locked for ${DATACHANNEL_PLATFORMS.join(', ')}`)

  const dc = checkPackagedDatachannel(appDir)
  if (!dc.ok) fail(dc.message)
  console.log(`verify:packaged: ${DATACHANNEL} present (${dc.binaries.map((b) => path.relative(appDir, b)).join(', ')})`)

  const dcProbe = datachannelProbe(executable, appDir)
  if (!dcProbe.ok) fail(dcProbe.message)
  console.log(`verify:packaged: ${DATACHANNEL} loads and constructs a PeerConnection under the packaged Electron`)

  if (process.argv.includes('--launch')) {
    const smoke = await launchSmoke(executable, Number(process.env.SHORESH_SMOKE_TIMEOUT_S) || 180)
    if (!smoke.ok) fail(smoke.message)
    console.log('verify:packaged: packaged app booted to the renderer heartbeat')
  }
}

if (process.argv[1] && process.argv[1].endsWith('verifyPackagedApp.js')) await main()
