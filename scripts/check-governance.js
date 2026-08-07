// Validates work documents against docs/governance/standards/WORK_RECORD_STANDARD.md.
//
// The findings this is built to catch are the ones a human reading a single
// file cannot see: an agent that was never accounted for, a reference to a file
// that was renamed, a `task_class` that routes against a class which does not
// exist, a pass asserted with no evidence attached.
//
// BLOCKING. A finding fails the run, and `npm run verify` fails with it.
//
// It shipped warn-only for exactly as long as the corpus had defects in it. The
// corpus is now clean, so the staging state is over. `CHECK_GOVERNANCE_WARN=1`
// downgrades to print-and-exit-0 for a local sweep, and is not for CI or for
// getting a branch through.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asList } from './frontmatter.js'
import { readDocs, generate, INDEX_PATH, REFERENCE_FIELDS } from './build-work-index.js'

/** CONSTITUTION.md Article VI. Kebab-case, matching .claude/agents/*.md. */
export const AGENTS = [
  'governor', 'architect', 'designer', 'maker', 'code-reviewer',
  'verifier', 'tester', 'security', 'red-hat', 'grader',
]

/** GOVERNANCE_INDEX.md §3–8. */
export const TASK_CLASSES = [
  'architecture', 'ui-ux-design', 'security-auth', 'scheduling-engine',
  'database-sync', 'copy-terminology', 'documentation-governance',
]

const OMISSION_REASONS = ['no-predicate', 'not-applicable', 'human-waived']

// These enums are the vocabulary this repository actually uses. The first
// draft invented `resolved` for tickets and `approved` for specs; running the
// checker showed 18 tickets saying `completed` and 7 specs saying `active`.
// The corpus was right and the enum was wrong, so the enum changed. That is
// not the same as loosening a rule to make a finding go away — where a value
// was genuinely a defect (a dangling path, a bare string) it is still reported.
const STATUS_BY_TYPE = {
  run: ['in-progress', 'pass', 'retry', 'escalated', 'abandoned'],
  ticket: ['open', 'in-progress', 'completed', 'parked', 'wont-fix', 'closed'],
  spec: ['draft', 'active', 'approved', 'implemented', 'superseded'],
  adr: ['proposed', 'accepted', 'superseded', 'rejected'],
  plan: ['draft', 'approved', 'complete', 'abandoned'],
  handoff: ['active', 'superseded'],
  index: ['active'],
  reference: ['active', 'superseded'],
}

const REQUIRED_BY_TYPE = {
  run: ['task', 'document_type', 'date', 'round', 'status', 'task_class',
    'selected_agents', 'omitted_agents', 'deterministic_checks', 'human_gates', 'archive_when'],
  ticket: ['title', 'document_type', 'status', 'created', 'archive_when'],
  spec: ['title', 'document_type', 'status', 'created', 'archive_when'],
  adr: ['title', 'document_type', 'status', 'date', 'authority', 'implementation_state'],
  plan: ['title', 'document_type', 'status', 'created', 'archive_when'],
  handoff: ['task', 'document_type', 'status', 'created', 'archive_when'],
  index: ['title', 'document_type', 'status'],
  reference: ['title', 'document_type', 'status'],
}

const finding = (code, message) => ({ code, message })

/**
 * @param doc    {{path, data, error}} as produced by readDocs
 * @param exists (path) => boolean — injected so tests never touch the filesystem
 */
export function checkDoc(doc, exists) {
  const out = []
  // The blank template is a form, not a record. Its placeholders would
  // otherwise be reported as a dozen enum violations on every run.
  if (doc.path.endsWith('/TEMPLATE.md')) return []
  if (doc.error) return [finding('frontmatter-unparseable', `${doc.path}: ${doc.error}`)]
  if (!doc.data) return [finding('frontmatter-missing', `${doc.path}: no frontmatter block`)]

  const d = doc.data
  const type = d.document_type
  const at = (msg) => `${doc.path}: ${msg}`

  if (!type || !STATUS_BY_TYPE[type]) {
    return [finding('enum-violation', at(`document_type '${type}' is not in the standard`))]
  }

  for (const field of REQUIRED_BY_TYPE[type]) {
    // `[]` and `null` are assertions and count as present; only absence fails.
    // `undefined` counts as absent too — the parser never produces it, but an
    // explicitly-undefined key is absence expressed a different way.
    if (!(field in d) || d[field] === undefined) {
      out.push(finding('field-missing', at(`required field '${field}' is absent`)))
    }
  }

  if (d.status !== undefined && !STATUS_BY_TYPE[type].includes(d.status)) {
    out.push(finding('enum-violation', at(`status '${d.status}' is not valid for a ${type}`)))
  }

  if (d.task_class !== undefined && !TASK_CLASSES.includes(d.task_class)) {
    out.push(finding('enum-violation',
      at(`task_class '${d.task_class}' is not a row in GOVERNANCE_INDEX.md §3-8`)))
  }

  out.push(...checkResolvedBy(d, at, exists))

  for (const field of REFERENCE_FIELDS) {
    if (!(field in d) || d[field] === null || d[field] === '') continue
    if (!Array.isArray(d[field])) {
      out.push(finding('not-a-list', at(`'${field}' must be a list, even with one element`)))
    }
    for (const target of asList(d[field])) {
      if (!exists(target)) {
        out.push(finding('dangling-reference', at(`'${field}' points at missing ${target}`)))
      }
    }
  }

  if (type === 'run') out.push(...checkRun(d, at))
  return out
}

/**
 * `resolved_by` names what closed a ticket, which in this repository is almost
 * always a commit. It is therefore not a doc-to-doc edge and is not resolved
 * against the filesystem unless it looks like a path — the first version tried
 * to open `af6a9d8` as a file and reported three false dangling references.
 */
function checkResolvedBy(d, at, exists) {
  const out = []
  for (const value of asList(d.resolved_by)) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (value.includes('/')) {
      if (!exists(value)) {
        out.push(finding('dangling-reference', at(`resolved_by points at missing ${value}`)))
      }
      continue
    }
    if (/^[0-9a-f]{7,40}$/.test(value)) continue  // a commit SHA
    out.push(finding('unresolvable-reference',
      at(`resolved_by '${value}' is neither a repository path nor a commit SHA`)))
  }
  return out
}

function checkRun(d, at) {
  const out = []

  if (d.round !== undefined && d.round !== 1 && d.round !== 2) {
    out.push(finding('enum-violation',
      at(`round ${d.round} — there is no round 3; Article VII escalates instead`)))
  }

  const selected = asList(d.selected_agents)
  const omitted = asList(d.omitted_agents)
  const omittedNames = omitted.map((o) => (typeof o === 'string' ? o : o?.agent)).filter(Boolean)

  for (const entry of omitted) {
    if (typeof entry === 'string' || !entry?.agent) {
      out.push(finding('enum-violation', at('omitted_agents entries need {agent, reason}')))
      continue
    }
    if (!OMISSION_REASONS.includes(entry.reason)) {
      out.push(finding('enum-violation',
        at(`omission reason '${entry.reason}' for ${entry.agent} is not in the enum — ` +
           'if the agent is genuinely unnecessary that is a rule 8 challenge, not an omission')))
    }
    if (entry.reason === 'human-waived' && !entry.note) {
      out.push(finding('waiver-unquoted',
        at(`${entry.agent} is human-waived with no note — quote the user verbatim`)))
    }
  }

  for (const agent of AGENTS) {
    const isSelected = selected.includes(agent)
    const isOmitted = omittedNames.includes(agent)
    if (isSelected && isOmitted) {
      out.push(finding('agent-contradiction', at(`${agent} is both selected and omitted`)))
    } else if (!isSelected && !isOmitted) {
      out.push(finding('agent-unaccounted',
        at(`${agent} is neither selected nor omitted — Article VII requires the omission ` +
           'to be recorded with a reason')))
    }
  }

  if (d.verdict === 'pass' && asList(d.completion_evidence).length === 0) {
    out.push(finding('evidence-missing',
      at('verdict is pass with no completion_evidence — a pass with nothing attached to it')))
  }

  return out
}

export function checkIndexFreshness(committed, generated) {
  if (committed === null || committed === undefined) {
    return [finding('index-missing', `${INDEX_PATH} does not exist — run \`npm run index:work\``)]
  }
  if (committed !== generated) {
    return [finding('index-stale', `${INDEX_PATH} is stale — run \`npm run index:work\``)]
  }
  return []
}

export function checkAll(root) {
  const exists = (p) => existsSync(join(root, p))
  const findings = readDocs(root).flatMap((doc) => checkDoc(doc, exists))

  const path = join(root, INDEX_PATH)
  const committed = existsSync(path) ? readFileSync(path, 'utf8') : null
  findings.push(...checkIndexFreshness(committed, generate(root)))

  return findings
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const warnOnly = process.env.CHECK_GOVERNANCE_WARN === '1'
  const findings = checkAll(process.cwd())

  if (!findings.length) {
    console.log('check:governance — no findings.')
    process.exit(0)
  }

  const byCode = new Map()
  for (const f of findings) {
    if (!byCode.has(f.code)) byCode.set(f.code, [])
    byCode.get(f.code).push(f.message)
  }

  console.log(`check:governance — ${findings.length} finding(s)\n`)
  for (const code of [...byCode.keys()].sort()) {
    console.log(`  ${code} (${byCode.get(code).length})`)
    for (const m of byCode.get(code)) console.log(`    - ${m}`)
    console.log('')
  }

  if (warnOnly) {
    console.log('CHECK_GOVERNANCE_WARN=1 — reporting only, not failing.')
    process.exit(0)
  }
  console.log('Fix these, or amend the standard if the corpus is right and the rule is wrong.')
  process.exit(1)
}
