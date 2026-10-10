// verify:packaged's sync-quit mode (scripts/verifyPackagedApp.js): the packaged smoke run boots an
// EMPTY userData, so no camp exists and the sync node never starts. With SHORESH_SMOKE_BOOTSTRAP=1
// the app bootstraps a throwaway camp through its own handlers, starts sync, and drops a marker
// once the node is up, so the script can SIGTERM a process that has real sync/punch state to tear
// down. It must never touch a real install's database, so every condition below must hold.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SMOKE_SYNC_MARKER = 'deploy-smoke-sync-started.json'
export const SMOKE_USERDATA_PREFIX = 'shoresh-pkg-smoke-'

const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

export function smokeBootstrapRequested({ env = process.env, isPackaged, userDataPath, tmpdir = os.tmpdir() }) {
  if (!env.SHORESH_SMOKE_NONCE || env.SHORESH_SMOKE_BOOTSTRAP !== '1' || !env.SHORESH_SMOKE_PIN) return false
  if (isPackaged !== true || !env.SHORESH_SMOKE_USERDATA) return false
  const dir = real(userDataPath)
  if (dir !== real(env.SHORESH_SMOKE_USERDATA)) return false
  return path.dirname(dir) === real(tmpdir) && path.basename(dir).startsWith(SMOKE_USERDATA_PREFIX)
}

export async function runSmokeBootstrap({ db, pin, handlers, syncStarterHolder, writeSyncMarker }) {
  if (db.prepare('SELECT COUNT(*) AS n FROM camps').get().n !== 0) throw new Error('smoke bootstrap refused: a camp already exists')
  handlers.chooseMode({ mode: 'host' })
  await handlers.bootstrapCamp({ campName: 'Smoke Camp', adminName: 'Smoke Admin', adminPin: pin })
  await syncStarterHolder.start()
  if (!syncStarterHolder.getNode()) throw new Error('smoke bootstrap: the sync node did not start')
  writeSyncMarker()
}
