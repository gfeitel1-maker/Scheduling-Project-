// Statement cache for the op-log write path (appendOp, applyProjection, and
// everything they call per-op — see T66). better-sqlite3 statements are
// reusable and re-preparing the same SQL text on every single op measured at
// ~1.3ms per prepare, ~4 prepares per op — a 400-group camp with a full
// five-day schedule (~2400 ops) took 37s of BLOCKED MAIN THREAD, stalling
// every connected staff device (the main process also serves IPC and, in
// Host mode, syncServer.js's whole message loop).
//
// Keyed on the db HANDLE, not a single module-level statement: each test in
// this repo's suite opens its own in-memory/tmp-file db, and multiple real
// db handles (Host + this-device) can coexist in one process. A bare
// `let stmt = db.prepare(sql)` cached across calls would silently bind a
// statement prepared against one db handle's connection to a DIFFERENT
// handle on a later call — better-sqlite3 statements are tied to the
// connection they were prepared on. A WeakMap<db, Map<sql, Statement>> keeps
// every db's statements in a bucket that only that db's calls ever read, and
// lets the bucket be garbage-collected when the db handle itself is (e.g.
// after `db.close()` in a test's afterEach, once nothing else references it).
const cache = new WeakMap()

export function getStmt(db, sql) {
  let dbCache = cache.get(db)
  if (!dbCache) {
    dbCache = new Map()
    cache.set(db, dbCache)
  }
  let stmt = dbCache.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    dbCache.set(sql, stmt)
  }
  return stmt
}
