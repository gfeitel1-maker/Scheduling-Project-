// Catches a SQL string/template literal that still names a column retired by
// T293 (electron/db/localDb.js's v84 migration block, confirmed 2026-10-01):
//
//   template_slots.anchor_id    -> fixed_event_id
//   template_slots.is_anchor    -> is_fixed_event
//   cohorts.anchor_model        -> fixed_event_model
//   compound_cell_decisions.anchor_name -> base_name
//
// A hand-written migration/rollback SQL string that survives a rename is
// invisible to grep the same way the NUL-byte class is: it parses and runs,
// it just targets a column that no longer exists (or, worse, one that still
// exists under the old meaning in a stale snapshot).
//
// electron/db/** is EXCLUDED — the migration/rollback machinery that
// performed this exact rename legitimately names both the old and new column
// (see localDb.js's v84 block, and any rollback/version test living beside
// it). Confirmed by grepping for SQL-shaped literals naming these columns
// outside electron/db/ on the clean tree: zero hits.
//
// Keyword gate is deliberately NARROW — insert into / create table / alter
// table only, not UPDATE...SET. SQL line comments (`-- ... <eol>`) and block
// comments (`/* ... */`) are stripped from the literal's text before either
// the keyword or the column-name check runs, so a retired name that appears
// only inside a SQL comment (documenting the OLD name, say) does not fire.
//
// Cannot-see, stated rather than hidden:
//   - a future rename not yet in RETIRED_COLUMNS
//   - a column name split across string concatenation or interpolation
//     (`'anchor_' + 'id'`) — only a single literal's own text is scanned
//   - an UPDATE...SET statement (the keyword gate does not include it)
//   - a non-SQL-shaped string that merely contains the column name as a
//     substring (e.g. a sentence describing the rename) — the keyword gate
//     exists precisely to let that case pass
//   - a DIFFERENT table reusing one of these names for its own, unrelated
//     column (cross-table name collision) — RETIRED_COLUMNS is a flat name
//     denylist, not table-scoped. Accepted limitation; no such column exists
//     in this schema today.

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'acorn'
import { walk } from './astWalk.js'

export const RETIRED_COLUMNS = new Set(['anchor_id', 'is_anchor', 'anchor_model', 'anchor_name'])

const SQL_SHAPE_RE = /insert\s+into|create\s+table|alter\s+table/i

const finding = (code, message) => ({ code, message })

function literalText(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join('')
  return null
}

/** Strip SQL line (`-- ...`) and block (`/* ... *\/`) comments before matching. */
function stripSqlComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '')
}

function findRetiredColumn(text) {
  for (const col of RETIRED_COLUMNS) {
    if (new RegExp(`\\b${col}\\b`).test(text)) return col
  }
  return null
}

/** Pure core: scan one already-read file's text. Abstains on unparseable JS. */
export function scanRetiredSqlColumnInText(path, text) {
  let ast
  try {
    ast = parse(text, { sourceType: 'module', ecmaVersion: 'latest', locations: true })
  } catch {
    return []
  }

  const findings = []
  walk(ast, (node) => {
    const raw = literalText(node)
    if (raw === null) return
    const value = stripSqlComments(raw)
    if (!SQL_SHAPE_RE.test(value)) return
    const col = findRetiredColumn(value)
    if (!col) return
    findings.push(finding('retired-column-in-sql-literal',
      `${path}:${node.loc.start.line} — SQL literal references '${col}', a column retired by T293 (v84); ` +
      "live name is in electron/db/localDb.js's v84 migration block. A rollback/migration test that " +
      'needs the old name belongs under electron/db/, which this check excludes.'))
  })
  return findings
}

/** Wrapper over the real filesystem/git — scans tracked *.js outside electron/db/. */
export function checkRetiredSqlColumn(root, {
  execFn = (cmd) => execSync(cmd, { encoding: 'utf8' }),
  readFn = (p) => readFileSync(p, 'utf8'),
} = {}) {
  const files = execFn(`git -C '${root}' ls-files '*.js'`)
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('electron/db/'))

  const findings = []
  for (const f of files) {
    let text
    try {
      text = readFn(join(root, f))
    } catch {
      continue
    }
    findings.push(...scanRetiredSqlColumnInText(f, text))
  }
  return findings
}
