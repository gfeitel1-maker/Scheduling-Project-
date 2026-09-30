// A module-resolution hook that points `electron` at ./electronStub.mjs.
//
// T251, for scripts/fixtures/electiveAcceptanceCamp.mjs only.
//
// WHY A LOADER RATHER THAN A REFACTOR. electron/main.js imports `electron` by
// name at module load, and outside an Electron process that package resolves to
// a CommonJS module exporting a path string — so `import { BrowserWindow }`
// throws before a single line of main.js runs. The vitest files solve this with
// `vi.mock('electron', ...)`; a plain `node` process has no equivalent, and
// changing main.js to accommodate a fixture script would be a production change
// for a test's convenience. This is the same substitution, at the only layer a
// script can make it.
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const STUB = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'electronStub.mjs')
).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: STUB, shortCircuit: true }
  return nextResolve(specifier, context)
}
