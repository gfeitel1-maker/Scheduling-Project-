// The T345 disable runner, with every side effect injected so its ORDER can be tested. The order is the
// safety property: flush the document, stop sync, flush once more (a peer merge can land while the node
// stops), then block every later save so none can re-encrypt the decrypted document with the key being
// shredded, then close the db and only then decrypt. Wired in electron/main.js.
export function createAtRestDisableRunner({ flushDoc, shutdownSync, suspendDocSaves, closeDb, listDbPaths, disable, restart, log = console.error }) {
  const flush = () => { try { flushDoc() } catch (err) { log('disable encryption: automerge flush failed:', err?.message ?? err) } }
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
      log('disable encryption failed; encryption stays on:', err?.message ?? err)
      suspendDocSaves(false)
      restart(5000)
      return { ok: false, error: err?.code ?? 'disable_failed', message: err?.message ?? String(err), restarting: true }
    }
  }
}
