// T340: size the pre-Noise pending slots to the process's open-file soft limit. Each pending inbound
// connection holds a file descriptor, so a low limit (macOS GUI launches commonly get 256) must not
// be asked to carry 256 pending sockets. The LAN-reserve property (global - public sub-cap) holds in
// both profiles.
import { spawnSync } from 'node:child_process'

export const LOW_PROFILE = Object.freeze({ name: 'low', publicSubCap: 32, globalPending: 128 })
export const NORMAL_PROFILE = Object.freeze({ name: 'normal', publicSubCap: 64, globalPending: 256 })
export const MIN_FD_LIMIT_FOR_NORMAL = 512

export function parseUlimit(stdout) {
  const n = Number.parseInt(String(stdout).trim(), 10)
  return Number.isFinite(n) && n > 0 && String(n) === String(stdout).trim() ? n : null
}

export function readOpenFileSoftLimit(spawn = spawnSync) {
  const r = spawn('/bin/sh', ['-c', 'ulimit -n'], { encoding: 'utf8', timeout: 500 })
  if (r?.status !== 0) return null
  return parseUlimit(r.stdout)
}

export function resolvePendingProfile({ platform = process.platform, readLimit = readOpenFileSoftLimit, log = console.log } = {}) {
  if (platform === 'win32') return NORMAL_PROFILE
  let limit = null
  try { limit = readLimit() } catch { limit = null }
  const profile = limit !== null && limit >= MIN_FD_LIMIT_FOR_NORMAL ? NORMAL_PROFILE : LOW_PROFILE
  log(`automerge sync: open-file soft limit ${limit ?? 'unknown'} -> pending profile ${profile.name} (public ${profile.publicSubCap}, global ${profile.globalPending})`)
  return profile
}

export function describeFdSelection(deps = {}) {
  const fdLimit = (deps.readLimit ?? readOpenFileSoftLimit)()
  const selectedProfile = resolvePendingProfile({ ...deps, readLimit: () => fdLimit, log: () => {} }).name
  return { fdLimit, selectedProfile }
}
