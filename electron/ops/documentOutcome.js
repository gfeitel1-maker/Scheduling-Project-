// The one symbol that says what happened on the AUTHORITATIVE side of a write.
//
// In its own module because two modules on opposite ends of a cycle need it:
// `operations.js` stamps it (and re-exports it, so callers keep one import
// site), and `liveDoc.js` stamps it again when a DEFERRED write finally
// resolves. `operations.js` already imports `liveDoc.js`, so the symbol cannot
// live in either without the other importing backwards.
//
// The vocabulary, and why each value exists (T153):
//
//   'applied'      — the in-memory authoritative document has it. Durability is
//                    the debounced save, which is later and can fail on its own;
//                    that failure is recorded separately (T148) and counted by
//                    unsharedWriteCount.
//   'failed'       — SQLite has it, the document does not. Recorded in
//                    projection_failures with store='document'.
//   'deferred'     — buffered inside runAtomic and not yet attempted. NOT a
//                    synonym for success. Replaced with the real outcome when
//                    the outermost transaction commits and the queue flushes,
//                    which happens before runAtomic returns — so a caller
//                    holding the op after runAtomic never sees 'deferred'.
//   'not-modeled'  — the entity is deliberately op-log-only (host-local tables;
//                    see campDocument.js's MODELED_ENTITIES). Nothing is missing.
//   'engine-off'   — SHORESH_SYNC_ENGINE=oplog. The document is not written at
//                    all, on purpose.
//
// A Symbol deliberately: the op is read back out of SQLite and spread into wire
// payloads and IPC responses in several places, and a new enumerable field on it
// would silently widen all of them.
export const DOCUMENT_OUTCOME = Symbol('documentOutcome')
