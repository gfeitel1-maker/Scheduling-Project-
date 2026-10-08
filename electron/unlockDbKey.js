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
// AUTHORIZATION GATE (docs/adr/2026-10-08-director-authorized-tool-connections.md). This helper is the
// SOLE key-release path, and it releases only to a tool that presents a live, non-revoked, director-
// granted secret — via SHORESH_TOOL_SECRET or --secret-stdin, NEVER argv. Verification funnels through
// ONE checkpoint (electron/auth/toolAuthorizations.js checkToolAuthorization). This is accountability
// (explicit, named, revocable, audited), not a crypto defense against a same-OS-user attacker, who can
// still run Electron and unseal the key; do not describe it as one.
//
// The arg-parsing, env construction and release gate are pure and exported for tests; the safeStorage +
// spawn glue runs only when this file is the Electron entry point.
import { checkToolAuthorization, ToolAuthorizationError } from './auth/toolAuthorizations.js'
import { getOrCreateDbKey } from './db/dbEncryptionKey.js'

// Everything after `--exec` (skipping an optional `--` separator) is the command to run.
export function parseUnlockArgs(argv) {
  if (argv.some((a) => /^--(tool-)?secret(=|$)/.test(a))) {
    throw new Error('unlockDbKey: a tool secret is never accepted via argv (it is visible in `ps`). Use SHORESH_TOOL_SECRET or --secret-stdin.')
  }
  const secretFromStdin = argv.includes('--secret-stdin')
  const execIndex = argv.indexOf('--exec')
  if (execIndex >= 0) {
    let rest = argv.slice(execIndex + 1)
    if (rest[0] === '--') rest = rest.slice(1)
    if (rest.length === 0) throw new Error('unlockDbKey: --exec requires a command to run')
    return secretFromStdin ? { mode: 'exec', command: rest, secretFromStdin } : { mode: 'exec', command: rest }
  }
  return secretFromStdin ? { mode: 'print', secretFromStdin } : { mode: 'print' }
}

// The environment a spawned child gets: the current env plus the key and the authorization's scope.
// The tool secret itself is stripped. Pure + testable.
export function childEnvWithKey(keyHex, baseEnv = process.env, authorization = null) {
  const env = { ...baseEnv, SHORESH_DB_KEY: keyHex }
  delete env.SHORESH_TOOL_SECRET
  if (authorization) {
    env.SHORESH_TOOL_SCOPE = authorization.scope
    env.SHORESH_TOOL_AUTHORIZATION_ID = authorization.id
  }
  return env
}

// The ONLY place the key is unsealed for a tool: the checkpoint runs first and throws a named refusal
// (tool-not-authorized / tool-authorization-revoked) before the key is touched, so a refused tool
// never causes the keychain entry to be read or minted. A failure to obtain the key for an AUTHORIZED
// tool is the one genuine db_key_unavailable case.
export function releaseKeyToTool({ userDataPath, safeStorage, env = process.env, stdinText = null, getKey = getOrCreateDbKey }) {
  const secret = env.SHORESH_TOOL_SECRET || stdinText
  const authorization = checkToolAuthorization(userDataPath, safeStorage, secret)
  let key
  try {
    key = getKey(userDataPath, safeStorage)
  } catch (err) {
    const wrapped = new ToolAuthorizationError('db_key_unavailable', `The database key could not be obtained from the OS keychain: ${err?.message ?? err}`)
    throw wrapped
  }
  return { keyHex: key.toString('hex'), authorization }
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('electron/unlockDbKey.js')
if (invokedDirectly) {
  const [{ app, safeStorage }, { applyUserDataPath }, { spawn }, { readFileSync }] = await Promise.all([
    import('electron'),
    import('./db/userDataPath.js'),
    import('node:child_process'),
    import('node:fs'),
  ])
  app.whenReady().then(() => {
    try {
      const parsed = parseUnlockArgs(process.argv.slice(2))
      const userDataPath = applyUserDataPath(app)
      const stdinText = parsed.secretFromStdin ? readFileSync(0, 'utf8') : null
      const { keyHex, authorization } = releaseKeyToTool({ userDataPath, safeStorage, stdinText })
      if (parsed.mode === 'exec') {
        const [cmd, ...args] = parsed.command
        const child = spawn(cmd, args, { stdio: 'inherit', env: childEnvWithKey(keyHex, process.env, authorization) })
        child.on('exit', (code, signal) => app.exit(signal ? 1 : (code ?? 0)))
        child.on('error', (err) => { process.stderr.write(`unlockDbKey: spawn failed — ${err.message}\n`); app.exit(1) })
        return // do NOT exit here — wait for the child
      }
      process.stdout.write(keyHex + '\n')
      app.exit(0)
    } catch (err) {
      process.stderr.write(`unlockDbKey: ${err?.code ? `${err.code}: ` : ''}${err?.message ?? err}\n`)
      app.exit(1)
    }
  })
}
