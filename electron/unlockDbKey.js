// The Electron "unlock helper" for headless at-rest key access (ADR
// docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md, producer side; T179 slice 2).
//
// The MCP server / CLI (plain Node) cannot reach the OS keychain. This tiny helper runs UNDER
// ELECTRON as the logged-in user, unseals the per-device key via safeStorage (getOrCreateDbKey), and
// puts it on the protected channel the headless tools read (electron/db/headlessDbKey.js):
//
//   electron electron/unlockDbKey.js --print          # writes the hex key to stdout
//   electron electron/unlockDbKey.js --to-file <path> # writes it to a 0600 file for SHORESH_DB_KEY_FILE
//
// Typical use (key never on argv, never world-readable):
//   SHORESH_DB_KEY="$(electron electron/unlockDbKey.js --print)" node scripts/mcp/server.js --db ...
//
// It adds NO new trust: it runs under the same OS user + keychain access the app itself uses — anyone
// who can run it could already run the app and read the data. The emit/argv logic is pure and
// exported for tests; the Electron glue (safeStorage) runs only when this file is the entry point.
import fs from 'node:fs'

export function parseUnlockArgs(argv) {
  const toFileIndex = argv.indexOf('--to-file')
  if (toFileIndex >= 0) {
    const filePath = argv[toFileIndex + 1]
    if (!filePath) throw new Error('unlockDbKey: --to-file requires a path')
    return { mode: 'file', filePath }
  }
  return { mode: 'print' }
}

// emitDbKey(keyHex, { mode, filePath }) — 'print' → stdout (for command substitution into
// SHORESH_DB_KEY); 'file' → a 0600 file (for SHORESH_DB_KEY_FILE). fsImpl/stdout injected for tests.
export function emitDbKey(keyHex, { mode = 'print', filePath, fsImpl = fs, stdout = process.stdout } = {}) {
  if (mode === 'file') {
    if (!filePath) throw new Error('emitDbKey: file mode requires a path')
    fsImpl.writeFileSync(filePath, keyHex, { mode: 0o600 })
    fsImpl.chmodSync(filePath, 0o600) // enforce perms even if the file pre-existed with looser ones
    return { mode: 'file', filePath }
  }
  stdout.write(keyHex + '\n')
  return { mode: 'print' }
}

// Electron entry — only when this file is the launched script (never when imported by a test). The
// electron import is dynamic so importing this module under plain Node (vitest) never touches it.
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('electron/unlockDbKey.js')
if (invokedDirectly) {
  const [{ app, safeStorage }, { applyUserDataPath }, { getOrCreateDbKey }] = await Promise.all([
    import('electron'),
    import('./db/userDataPath.js'),
    import('./db/dbEncryptionKey.js'),
  ])
  app.whenReady().then(() => {
    let code = 0
    try {
      const userDataPath = applyUserDataPath(app)
      const key = getOrCreateDbKey(userDataPath, safeStorage)
      emitDbKey(key.toString('hex'), parseUnlockArgs(process.argv.slice(2)))
    } catch (err) {
      process.stderr.write(`unlockDbKey: ${err?.message ?? err}\n`)
      code = 1
    } finally {
      app.exit(code)
    }
  })
}
