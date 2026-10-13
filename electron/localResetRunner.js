// The "Start fresh on this computer" runner (docs/adr/2026-10-13-revoked-device-local-reset.md), with every side
// effect injected so its ORDER can be tested. Quiesce like the at-rest disable runner (flush, stop sync, flush,
// block doc saves), then RE-CHECK the gate on the quiet db: a re-grant can land while sync stops, and a device the
// camp has let back in must not be wiped. Only then close the db and move the data aside; the app restarts and the next
// launch finishes the wipe (electron/db/localReset.js). Wired in electron/main.js.
export function createLocalResetRunner({ flushDoc, shutdownSync, suspendDocSaves, stillRemoved, closeDb, listProjectDbPaths, reset, clearRendererStorage = async () => {}, restart, log = console.error }) {
  // The data is about to be deleted anyway, so a failed flush never blocks the reset.
  const flush = () => { try { flushDoc() } catch (err) { log('start fresh: could not save the document first:', err?.message ?? err) } }
  return async () => {
    try {
      flush()
      await shutdownSync()
      flush()
      suspendDocSaves(true)
      if (!stillRemoved()) {
        log('start fresh: this device is no longer removed from the camp; nothing was wiped.')
        restart(1500)
        return { ok: false, error: 'not_removed', restarting: true }
      }
      closeDb()
      reset({ extraDbPaths: listProjectDbPaths() })
      try { await clearRendererStorage() } catch (err) { log('start fresh: could not clear the window storage:', err?.message ?? err) }
      restart(500)
      return { ok: true, restarting: true }
    } catch (err) {
      // Saves stay blocked until the restart; if the journal was written, the next launch finishes the wipe.
      log('start fresh failed:', err?.message ?? err)
      restart(5000)
      return { ok: false, error: err?.code ?? 'reset_failed', message: err?.message ?? String(err), restarting: true }
    }
  }
}
