import { createRequire } from 'node:module'

// T347 (S1): the capability check behind SHORESH_PUNCH_ENABLED. Like relayEnablement.js, this is
// the only runtime coupling between syncStarter.js and the punch capability: transportCapabilities.js
// is a build-time registry that production code must never read, so "is the native module usable
// here" is probed mechanically instead. Strict booleans only — a truthy string is not enablement.
export function punchRuntimeEligible({ punchEnabled, nativeLoadable }) {
  return punchEnabled === true && nativeLoadable === true
}

// Loads (not merely resolves) node-datachannel, because the failure this guards against is a
// prebuilt native binary that does not load on this platform/ABI — resolution alone would pass.
// Never throws: an unloadable native module is a normal "stay off" state.
export function punchNativeLoadable() {
  try {
    createRequire(import.meta.url)('node-datachannel')
    return true
  } catch {
    return false
  }
}
