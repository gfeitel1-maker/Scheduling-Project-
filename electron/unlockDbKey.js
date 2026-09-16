// The Electron "unlock helper" for headless at-rest key access (ADR
// docs/adr/2026-09-16-headless-db-key-access-for-mcp-cli.md, producer side; T179 slice 2).
//
// The MCP server / CLI (plain Node) cannot reach the OS keychain. This tiny helper runs UNDER
// ELECTRON as the logged-in user, unseals the per-device key via safeStorage (getOrCreateDbKey), and
// hands it to the headless tools WITHOUT ever writing it to disk:
//
//   electron electron/unlockDbKey.js --exec -- node scripts/mcp/server.js --db <path> [--allow-write]
//       # unseals the key, spawns the command with SHORESH_DB_KEY set in ITS environment only, and
//       # exits with the child's exit code. The key lives solely in the child process for its
//       # lifetime — never on disk, never in the launching shell's history/env. THIS IS THE PRIMARY,
//       # RECOMMENDED MODE.
//
//   electron electron/unlockDbKey.js --print
//       # writes the hex key to stdout for advanced/manual capture. Transient and owner-only, but the
//       # operator owns exposure via their shell — prefer --exec.
//
// A prior `--to-file` mode was REMOVED after a security re-review
// (docs/work/security/2026-09-16-headless-key-channel-assessment.md, findings 1 & 2): writing the
// unsealed key to a file left it on disk with a symlink/permission window AND with nothing deleting
// it — which negates the exact offline-theft property safeStorage exists to provide. Env-passing via
// --exec erases that whole risk class. It adds NO new trust: the key only ever exists in a process
// running as the same OS user, with the same keychain access the app itself has.
//
// The arg-parsing and the child-env construction are pure and exported for tests; the safeStorage +
// spawn glue runs only when this file is the Electron entry point.
export function parseUnlockArgs(argv) {
  const execIndex = argv.indexOf('--exec')
  if (execIndex >= 0) {
    // Everything after `--exec` (skipping an optional `--` separator) is the command to run.
    let rest = argv.slice(execIndex + 1)
    if (rest[0] === '--') rest = rest.slice(1)
    if (rest.length === 0) throw new Error('unlockDbKey: --exec requires a command to run')
    return { mode: 'exec', command: rest }
  }
  return { mode: 'print' }
}

// The environment a spawned child gets: the current env plus the key. Pure + testable.
export function childEnvWithKey(keyHex, baseEnv = process.env) {
  return { ...baseEnv, SHORESH_DB_KEY: keyHex }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('electron/unlockDbKey.js')
if (invokedDirectly) {
  const [{ app, safeStorage }, { applyUserDataPath }, { getOrCreateDbKey }, { spawn }] = await Promise.all([
    import('electron'),
    import('./db/userDataPath.js'),
    import('./db/dbEncryptionKey.js'),
    import('node:child_process'),
  ])
  app.whenReady().then(() => {
    let parsed
    try {
      parsed = parseUnlockArgs(process.argv.slice(2))
      const userDataPath = applyUserDataPath(app)
      const keyHex = getOrCreateDbKey(userDataPath, safeStorage).toString('hex')
      if (parsed.mode === 'exec') {
        const [cmd, ...args] = parsed.command
        const child = spawn(cmd, args, { stdio: 'inherit', env: childEnvWithKey(keyHex) })
        child.on('exit', (code, signal) => app.exit(signal ? 1 : (code ?? 0)))
        child.on('error', (err) => { process.stderr.write(`unlockDbKey: spawn failed — ${err.message}\n`); app.exit(1) })
        return // do NOT exit here — wait for the child
      }
      process.stdout.write(keyHex + '\n')
      app.exit(0)
    } catch (err) {
      process.stderr.write(`unlockDbKey: ${err?.message ?? err}\n`)
      app.exit(1)
    }
  })
}
