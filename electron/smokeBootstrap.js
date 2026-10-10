// verify:packaged's sync-quit mode (scripts/verifyPackagedApp.js): the packaged smoke run boots an
// EMPTY userData, so no camp exists and the sync node never starts. With SHORESH_SMOKE_BOOTSTRAP=1
// the app bootstraps a throwaway camp through its own handlers, starts sync, and drops a marker
// once the node is up, so the script can SIGTERM a process that has real sync/punch state to tear
// down. Inert unless the smoke nonce is set too (the same gate as the heartbeat marker).
export const SMOKE_SYNC_MARKER = 'deploy-smoke-sync-started.json'

export function smokeBootstrapRequested(env = process.env) {
  return Boolean(env.SHORESH_SMOKE_NONCE) && env.SHORESH_SMOKE_BOOTSTRAP === '1'
}

export async function runSmokeBootstrap({ handlers, syncStarterHolder, writeSyncMarker }) {
  handlers.chooseMode({ mode: 'host' })
  await handlers.bootstrapCamp({ campName: 'Smoke Camp', adminName: 'Smoke Admin', adminPin: '000000' })
  await syncStarterHolder.start()
  if (!syncStarterHolder.getNode()) throw new Error('smoke bootstrap: the sync node did not start')
  writeSyncMarker()
}
