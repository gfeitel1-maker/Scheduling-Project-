// Registers the `electron` resolution hook for a plain-node process.
//
// T251. Used as `node --import ./scripts/fixtures/registerElectronStub.mjs ...`
// by scripts/fixtures/electiveAcceptanceCamp.mjs, which needs
// electron/main.js's REAL handlers outside an Electron process. See
// ./electronStubLoader.mjs for why.
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./electronStubLoader.mjs', pathToFileURL(import.meta.filename))
