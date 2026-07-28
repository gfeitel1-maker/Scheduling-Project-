// Stamps the artifact with the commit and time it was built from (T13).
// Runs as part of `npm run electron:build`, before electron-builder packages
// the tree. Writes electron/build-info.json, which is gitignored — its only
// meaningful value is "what did THIS artifact come from", so committing it
// would churn on every build and be wrong the moment anyone pulled.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function git(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // Building from a tarball or a tree without git is legitimate. A build with
    // no commit is still better stamped with its date than left anonymous.
    return null
  }
}

const commit = git('git rev-parse HEAD')
const dirty = git('git status --porcelain')
const info = {
  commit: commit ? (dirty ? `${commit}-dirty` : commit) : null,
  builtAt: new Date().toISOString(),
}

fs.writeFileSync(path.join(root, 'electron', 'build-info.json'), JSON.stringify(info, null, 2) + '\n')
console.log(`build-info: ${info.commit ?? '(no git)'} @ ${info.builtAt}`)
