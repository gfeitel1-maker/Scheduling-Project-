// Throwaway-DB scripts import this FIRST. localDb reads SHORESH_AT_REST_ENCRYPTION when it loads, and
// ES imports are hoisted, so the pin has to be its own module that evaluates before localDb's.
// These scripts build disposable plaintext DBs (fixtures, probes); none touches a real camp's DB.
// Guarded by electron/db/openLocalDbCallers.guard.test.js.
process.env.SHORESH_AT_REST_ENCRYPTION = 'off'
