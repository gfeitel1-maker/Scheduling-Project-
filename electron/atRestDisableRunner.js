// The T345 disable runner, with every side effect injected so its ORDER can be tested. The order is the
// safety property: flush the document, stop sync, flush once more (a peer merge can land while the node
// stops), then block every later save so none can re-encrypt the decrypted document with the key being
// shredded, then close the db and only then decrypt. Wired in electron/main.js.
// close() settles a start in flight and refuses any later one; the race bounds a node that will not stop.
export function boundedSyncStop(close, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Encryption was not changed: sync did not stop in time. The app will restart.'), { code: 'sync_stop_timeout' })), ms)
  })
  return Promise.race([close(), timeout]).finally(() => clearTimeout(timer))
}

export function createAtRestDisableRunner({ flushDoc, shutdownSync, suspendDocSaves, closeDb, listDbPaths, disable, restart, log = console.error }) {
  const flush = () => {
    try { flushDoc() } catch (err) {
      throw Object.assign(new Error('Encryption was not changed: the latest camp changes could not be saved first. Nothing was touched.'), { code: 'flush_failed', cause: err })
    }
  }
  return async () => {
    try {
      flush()
      await shutdownSync()
      flush()
      suspendDocSaves(true)
      closeDb()
      const res = disable({ dbPaths: listDbPaths() })
      restart(1500)
      return { ok: true, restarting: true, warnings: res.warnings }
    } catch (err) {
      // Saves stay blocked until the restart: once the disable has begun, the files may be mid-swap and a
      // save landing now would be lost to the rollback or re-encrypt under a key about to go.
      log('disable encryption failed; encryption stays on:', err?.message ?? err)
      restart(5000)
      return { ok: false, error: err?.code ?? 'disable_failed', message: err?.message ?? String(err), restarting: true }
    }
  }
}
