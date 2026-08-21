// The headless read seam — extracted verbatim from electron/main.js's
// list() IPC handler (docs/adr/2026-08-21-mcp-ingestion-server.md, Decision
// 2). This is the single query path both the renderer's `list()` IPC
// handler and the MCP server's read tools call; entity-name validation
// stays a hard whitelist against the same frozen registries in
// campScopedEntities.js, never caller-built SQL. This module never touches
// `token` — auth stays in electron/main.js.
import { DIRECT_CAMP_ENTITIES, PARENT_SCOPED_ENTITIES } from './campScopedEntities.js'

export function listEntities(db, entity) {
  if (typeof entity !== 'string' || entity.length === 0) {
    throw new Error('Invalid entity')
  }
  if (!DIRECT_CAMP_ENTITIES.has(entity) && !PARENT_SCOPED_ENTITIES[entity]) {
    throw new Error(`Unrecognized entity: ${entity}`)
  }

  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return []

  if (DIRECT_CAMP_ENTITIES.has(entity)) {
    return db.prepare(`SELECT * FROM ${entity} WHERE camp_id = ?`).all(camp.id)
  }

  const { table, parentTable, parentKey } = PARENT_SCOPED_ENTITIES[entity]
  return db
    .prepare(`SELECT t.* FROM ${table} t JOIN ${parentTable} p ON p.id = t.${parentKey} WHERE p.camp_id = ?`)
    .all(camp.id)
}
