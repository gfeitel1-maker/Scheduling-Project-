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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asList } from './frontmatter.js'
import { readDocs, generate, INDEX_PATH, REFERENCE_FIELDS } from './build-work-index.js'

// See checkWritableEntitiesCanSync. Imported at module load so the check is
// ordinary synchronous code; if either module cannot be loaded the check is
// skipped with a warning rather than failing a documentation run.
let projectionsRegistry = null
let modeledEntities = null
try {
  ;({ PROJECTIONS: projectionsRegistry } = await import('../electron/ops/projections.js'))
  ;({ MODELED_ENTITIES: modeledEntities } = await import('../electron/automerge/campDocument.js'))
} catch (err) {
  console.warn(`check:governance — entity-sync check skipped (could not load app modules: ${err?.message ?? err})`)
}


/**
 * CONSTITUTION.md **Article VII — the loop**. Kebab-case, matching .claude/agents/*.md.
 *
 * This is NOT the full Article VI roster, and the difference is load-bearing: every agent
 * named here must be either selected or omitted-with-a-reason in every run record, so
 * adding a name to this list retroactively invalidates every run record that predates it.
 * The agents in INDEPENDENT_AGENTS are in Article VI but deliberately absent here — they
 * run on their own cadence rather than inside a task's loop, so a run record has nothing
 * to say about them. `test/governance.test.js` pins the partition: the two lists together
 * must equal the Article VI roster exactly, which makes a new agent a conscious placement
 * rather than a silent omission from either side.
 */
export const AGENTS = [
  'governor', 'architect', 'designer', 'maker', 'code-reviewer',
  'verifier', 'tester', 'security', 'red-hat', 'grader',
]

/** Article VI roles that run outside the loop, so run records do not account for them. */
export const INDEPENDENT_AGENTS = [
  'architecture-auditor', 'design-auditor', 'security-assessment',
]

/** GOVERNANCE_INDEX.md §3–8. */
export const TASK_CLASSES = [
  'architecture', 'ui-ux-design', 'security-auth', 'scheduling-engine',
  'database-sync', 'copy-terminology', 'documentation-governance',
  'concurrency', 'test-infrastructure',
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
  discovery: ['draft', 'active', 'complete', 'superseded'],
  'baseline-inventory': ['draft', 'active', 'complete', 'superseded'],
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
  discovery: ['title', 'document_type', 'status', 'created'],
  'baseline-inventory': ['title', 'document_type', 'status', 'created'],
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

/**
 * PLATFORM_STATE.md describes what the platform IS. It is read cold by future
 * sessions, so a stale one does not merely lack detail — it makes confident,
 * specific, wrong claims, and it is trusted precisely because it is specific.
 * The Stage 6 cutover left it saying the WebSocket sync layer was live for a day.
 *
 * WHY THIS LIVES IN THE GATE rather than on a timer. A scheduled refresh fires
 * whether or not anything changed, cannot know it is describing a tree that moved
 * five minutes later, and — if it commits — writes to trunk unattended. The gate
 * fires exactly when structural work is landing, which is the moment the
 * `update-state` skill itself names ("run it at the end of any session where
 * structural things changed"), and it can only ever report.
 *
 * WHAT COUNTS AS STRUCTURAL is deliberately narrow, because a check that fires on
 * every commit gets silenced:
 *   - the database schema and its migrations (what the data IS)
 *   - accepted ADRs (decisions a reader is expected to already know)
 *   - screens (the surface a director actually touches)
 * Ordinary feature work, tests, and refactors do not trip it.
 *
 * Deliberately a WARNING, not a hard failure. The doc being a day behind must not
 * block a security fix from landing. It appears in the same list as every other
 * finding, which is enough to be unmissable without being coercive — the same
 * reasoning as `index-stale`, which names its own fix command.
 */
export const PLATFORM_STATE_PATH = 'docs/current/PLATFORM_STATE.md'

const STRUCTURAL_PATHS = [
  'electron/db/schema.sql',
  'electron/db/localDb.js',
  'docs/adr/',
  'src/screens/',
]

/** Last commit date (unix seconds) touching any path, or null if unknowable. */
function lastTouched(paths, execFn) {
  try {
    const out = execFn(`git log -1 --format=%ct -- ${paths.map((p) => `'${p}'`).join(' ')}`)
    const ts = Number(String(out).trim())
    return Number.isFinite(ts) && ts > 0 ? ts : null
  } catch {
    return null
  }
}

export function checkPlatformStateFreshness(root, execFn) {
  if (!existsSync(join(root, PLATFORM_STATE_PATH))) return []

  const stateAt = lastTouched([PLATFORM_STATE_PATH], execFn)
  const structuralAt = lastTouched(STRUCTURAL_PATHS, execFn)

  // Unknowable rather than fresh: a shallow clone or a missing git history must
  // not be reported as "up to date", which is the failure mode this whole check
  // exists to prevent.
  if (stateAt === null || structuralAt === null) return []
  if (stateAt >= structuralAt) return []

  const days = Math.floor((structuralAt - stateAt) / 86400)
  const behind = days >= 1 ? `${days} day(s) behind` : 'behind'
  return [finding('platform-state-stale',
    `${PLATFORM_STATE_PATH} is ${behind} the last structural change ` +
    `(schema, migrations, ADRs or screens) — run \`/update-state\` and land it with this work`)]
}

/**
 * WORK_RECORD_STANDARD.md §3.1 — a completion reference is `closes`/`Merge`
 * followed by a ticket (`T\d+`) or slice/ADR/spec id (`S\d+[a-z]?`). Deliberately
 * narrow: a bare mention like "relates to T40" must not match.
 */
const COMPLETION_REF = /(?:closes|merge)\s+([TS]\d+[a-z]?)/gi

export function parseCompletionRefs(subject) {
  return [...subject.matchAll(COMPLETION_REF)].map((m) => m[1])
}

/**
 * @param id   e.g. "T76" or "S5b"
 * @param docs the readDocs() shape: {path, data, error}
 */
export function resolveIds(id, docs) {
  if (id[0] === 'T' || id[0] === 't') {
    const n = id.slice(1)
    return docs.filter((d) =>
      d.path.startsWith('docs/work/tickets/') &&
      new RegExp(`/T${n}[-.]`).test(d.path))
  }

  const token = id.toLowerCase()
  const segment = new RegExp(`(^|-)${token}(-|\\.)`)
  return docs.filter((d) =>
    (d.path.startsWith('docs/adr/') || d.path.startsWith('docs/work/specs/')) &&
    segment.test(d.path.split('/').pop().toLowerCase()))
}

export function isClosed(doc) {
  switch (doc.document_type) {
    case 'ticket':
      return ['completed', 'closed', 'wont-fix'].includes(doc.status)
    case 'adr':
      // superseded/rejected are terminal, end-of-life states — the work either
      // shipped-then-superseded or was rejected; a completion reference to it is not drift.
      if (doc.status === 'superseded' || doc.status === 'rejected') return true
      return doc.status === 'accepted' && doc.implementation_state === 'implemented'
    case 'spec':
      return ['approved', 'implemented', 'superseded'].includes(doc.status)
    default:
      return false
  }
}

/**
 * Two tickets must never share a number.
 *
 * WHY THIS IS A GATE AND NOT AN ANNOYANCE. `resolveIds` resolves `closes T175`
 * by matching the number against the PATH, so a duplicated number resolves to
 * every file that carries it. `checkStatusDrift` then reports drift for each
 * match that is not closed — which is the strict behaviour, and correct as far
 * as it goes: a duplicate can never make the gate falsely PASS.
 *
 * The hazard is the other direction, and it is worse than a false pass because
 * it is actionable. Closing YOUR ticket demands closure of SOMEONE ELSE'S,
 * unrelated, still-open ticket — and the obvious way to make a red gate go green
 * is to flip the status it names. The gate that exists to stop a ticket silently
 * looking closed can, through a number collision, push someone into closing one.
 *
 * It has happened twice in two days across concurrent sessions (T165, then
 * T175), for a structural reason rather than a careless one: each session picks
 * "the next free number" by listing this directory, and neither can see the
 * other's uncommitted file. Announcing numbers to each other worked and is not
 * a mechanism. This is.
 *
 * Scoped to tickets: ADRs and specs are addressed by filename, not by number.
 */
// Numbers that were already doubled up before this check existed, all of whose
// tickets are closed. Renumbering them would break references in commit
// messages and ADRs that cannot be rewritten, for no live benefit.
//
// GRANDFATHERED CONDITIONALLY, NOT EXEMPTED. The hazard is dormant for these
// ONLY because every ticket sharing the number is closed — nothing can demand
// the closure of something already closed. If one is ever reopened the hazard
// returns, so the pass is re-earned on every run rather than granted once.
const HISTORICAL_DUPLICATE_NUMBERS = new Set(['82', '107', '110'])

export function checkTicketNumberUniqueness(docs) {
  const byNumber = new Map()
  for (const doc of docs) {
    if (!doc.path.startsWith('docs/work/tickets/')) continue
    const m = doc.path.split('/').pop().match(/^T(\d+)[-.]/)
    if (!m) continue
    const n = m[1]
    if (!byNumber.has(n)) byNumber.set(n, [])
    byNumber.get(n).push({ path: doc.path, data: doc.data })
  }

  const out = []
  for (const [n, entries] of [...byNumber].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (entries.length < 2) continue
    const paths = entries.map((e) => e.path)
    // See HISTORICAL_DUPLICATE_NUMBERS: the pass is conditional on every one of
    // them still being closed, and is re-checked here on every run.
    if (HISTORICAL_DUPLICATE_NUMBERS.has(n) && entries.every((e) => isClosed(e.data))) continue
    out.push(finding('duplicate-ticket-number',
      `T${n} is used by ${paths.length} tickets — ${paths.sort().join(' and ')}. ` +
      `A completion reference cannot say which one it closes, and the status-drift gate will ` +
      `demand closure of whichever is still open. Renumber all but the one already on main.`))
  }
  return out
}

export function checkStatusDrift(subjects, docs) {
  const out = []
  // WORK_RECORD_STANDARD.md §3.2 — a `Revert "..."` subject quotes a prior
  // commit's message, it does not make a fresh closure claim. Skip it wherever
  // subjects come from, so a direct caller gets the same behaviour as checkAll.
  const claims = subjects.filter((s) => !s.startsWith('Revert "'))
  const ids = claims.flatMap((s) => parseCompletionRefs(s))

  for (const id of ids) {
    const matches = resolveIds(id, docs)
    if (!matches.length) {
      const subject = claims.find((s) => parseCompletionRefs(s).includes(id))
      out.push(finding('status-drift-unresolvable-reference',
        `'${id}' referenced in commit "${subject}" does not resolve to any known document`))
      continue
    }
    for (const doc of matches) {
      if (isClosed(doc.data)) continue
      const state = doc.data.document_type === 'adr' ? `, implementation_state '${doc.data.implementation_state}'` : ''
      out.push(finding('status-drift',
        `'${id}' is referenced as closed by a commit but ${doc.path} still has status '${doc.data.status}'${state}`))
    }
  }

  return out
}

/**
 * A merged change that CLOSES something must ADD a run record (T167 part 2).
 *
 * THE MEASUREMENT: 283 commits landed between 2026-08-25 and 2026-09-14 with
 * zero run records. The reviewers ran; nobody transcribed the result. This file
 * could not detect that, because it validates records that EXIST and had no rule
 * that work must produce one — a gate that checks what is there cannot see what
 * is missing.
 *
 * NEW COMPLETIONS ONLY, and that is not a softening. 81 tickets are already
 * closed without a record; applying this retroactively would mean either
 * fabricating history or a permanently red gate, and the first is exactly what
 * the run-record standard exists to prevent. The scope falls out for free —
 * `origin/main..HEAD` is unmerged work by construction.
 *
 * THE RULE IS ABOUT THE CHANGE, NOT THE TICKET. "Some record somewhere mentions
 * T167" would be satisfied by a part-1 record when part 2 lands. That is a real
 * case rather than a hypothetical: it is this author's own next commit, and it
 * is how this author would first have evaded the rule without noticing.
 */
export function checkRunRecordFiled(subjects, addedRunRecords) {
  const claims = (subjects || []).filter((s) => !s.startsWith('Revert "'))
  const ids = [...new Set(claims.flatMap((s) => parseCompletionRefs(s)))]
  if (!ids.length) return []
  // TEMPLATE.md is filtered here as well as in the gatherer, deliberately. A
  // pure predicate should enforce its own contract: a caller that forgot to
  // filter must not be able to pass the template off as a filed record, and
  // "adding" the template is the most obvious way to satisfy this rule without
  // doing anything. Found by a test, not by inspection.
  const filed = (addedRunRecords || []).filter((p) => p.endsWith('.md') && !p.endsWith('TEMPLATE.md'))
  if (filed.length) return []
  return [finding('run-record-missing',
    `this change claims to close ${ids.join(', ')} but adds no run record under docs/work/runs/. ` +
    `Generate one with \`node scripts/newRunRecord.js\` — it fills everything git and the gate ` +
    `already know and leaves only the judgement to you.`)]
}

/**
 * A record generated and then forgotten must not pass for a filed one.
 *
 * `newRunRecord.js` emits NEEDS_JUDGEMENT wherever a machine must not guess:
 * which agents ran, why the others did not, the verdict. Those markers are what
 * makes the generator safe to have. Without this check, making filing cheap
 * would only make producing EMPTY records cheap — and the artifact would become
 * decoration, which is worse than the 283 missing ones, because decoration looks
 * like evidence.
 */
export function checkRunRecordsFilledIn(root, docs, readFile = readFileSync) {
  const out = []
  for (const doc of docs) {
    if (!doc.path.startsWith('docs/work/runs/')) continue
    if (doc.path.endsWith('TEMPLATE.md')) continue
    let text
    try {
      text = readFile(join(root, doc.path), 'utf8')
    } catch {
      continue // unreadable is checkDoc's problem, not this one
    }
    // A MARKER IN A VALUE POSITION, not a mention of one anywhere in the file.
    //
    // The first version matched the bare string, and flagged this very ticket's
    // own run record — which DISCUSSES the markers in prose while being fully
    // filled in. A check that cannot tell a placeholder from a description of a
    // placeholder makes writing about the mechanism impossible, and the record
    // explaining the rule is exactly the one most likely to mention it.
    //
    // So: a frontmatter field whose value is the marker (`verdict: <<...>>`, or
    // a list item's `reason: <<...>>`), or a body line that BEGINS with it —
    // which is the shape the generator's own "## Agents" stub takes. An inline
    // mention inside a sentence is left alone.
    const unfilled = /^\s*(?:-\s*)?[A-Za-z_]+:\s*<<NEEDS JUDGEMENT>>|^<<NEEDS JUDGEMENT>>/m
    if (!unfilled.test(text)) continue
    out.push(finding('run-record-unfilled',
      `${doc.path} still contains <<NEEDS JUDGEMENT>> markers — generated and not filled in. ` +
      `A record naming no agents and no verdict is decoration, not evidence.`))
  }
  return out
}

function gatherAddedRunRecords(root, execFn) {
  try {
    return execFn(`git -C ${root} diff --name-only --diff-filter=A origin/main..HEAD -- docs/work/runs`)
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.endsWith('.md') && !s.endsWith('TEMPLATE.md'))
  } catch {
    return null
  }
}

function gatherCompletionSubjects(root, execFn) {
  try {
    return execFn(`git -C ${root} log origin/main..HEAD --format=%s`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}


// Every entity a screen can WRITE must be able to reach another device — or be
// deliberately, documentedly local. There is no third state, and the third state
// is silent: a table registered in PROJECTIONS but absent from the Automerge
// document is one a director can fill in and nobody else will ever see, and
// which `projectAll`'s delete-reconcile may then remove, because it treats the
// document as the authoritative superset.
//
// docs/current/WHERE_DATA_LIVES.md ships this same diff as a command for a human
// to run. Running it by hand is how the current gaps were found; nothing ran it
// on its own, which is the part this closes.
//
// The allowlist is the "documentedly local" half. Adding to it is a real
// decision — say why here, and add the row to WHERE_DATA_LIVES.md — not a way
// to make this finding go away.
const SQLITE_ONLY_BY_DESIGN = new Set([
  // Each device tracks its own unresolved conflicts; a conflict is a fact about
  // THIS device's merge history, not shared camp data. Registered in PROJECTIONS
  // with `fields: []`, so no field op can target it either.
  'conflicts',
])

export function checkWritableEntitiesCanSync(projections, modeled) {
  if (!projections || !modeled) return []
  return Object.keys(projections)
    .filter((entity) => !modeled.has(entity) && !SQLITE_ONLY_BY_DESIGN.has(entity))
    .sort()
    .map((entity) =>
      finding('entity-cannot-sync',
        `\`${entity}\` is registered in PROJECTIONS but is not modeled in the Automerge document — ` +
        'a screen can write it, no other device will ever see it, and projectAll may delete it. ' +
        'Either model it in electron/automerge/campDocument.js, or — if it is deliberately ' +
        'device-local — add it to SQLITE_ONLY_BY_DESIGN here WITH a reason and give it a row in ' +
        'docs/current/WHERE_DATA_LIVES.md'))
}

/**
 * A descriptive doc must not name code that does not exist.
 *
 * Measured 2026-09-15: PLATFORM_STATE.md named ~25 files that had been deleted
 * (seven whole screens), SECURITY.md still named the removed WebSocket transport,
 * and CLAUDE.md described `syncServer.js`/`syncClient.js` and `JoinScreen`. None of
 * it was visible to the existing checks — `checkStatusDrift` reads frontmatter
 * status, `checkPlatformStateFreshness` compares commit dates, and neither can see
 * whether a SENTENCE names real code. A stale doc that is specific is trusted
 * BECAUSE it is specific; that is what makes this class expensive rather than
 * merely untidy.
 *
 * Scope is deliberately narrow — only the docs that claim to describe what IS.
 * ADRs, tickets, handoffs and archives legitimately name deleted code: that is
 * what a historical record is for, and flagging it would make the gate noise.
 *
 * Known limit, stated so it is not mistaken for an oversight: this catches
 * DELETED files only. A doc describing a file that still exists but now behaves
 * differently passes clean — `DEFAULT_LISTEN` being loopback while the shipped
 * app overrides it was exactly that kind of error, and no mechanical check of
 * this shape would have caught it.
 */
export const DESCRIPTIVE_DOC_PATHS = ['CLAUDE.md', 'README.md', 'SECURITY.md']
export const DESCRIPTIVE_DOC_DIRS = ['docs/current/']

/** Paths a descriptive doc names in order to say they are GONE. Reason required. */
export const DELIBERATELY_ABSENT = new Map([
  ['src/hooks/useSession.js',
    'removed when the Supabase path was retired; CLAUDE.md names it precisely to record that it no longer exists'],
  ['src/supabase.js',
    'moved to legacy/supabase/supabase.js; CLAUDE.md names the old path to document where it went'],
  ['syncServer.js',
    'the WebSocket sync layer deleted in the Stage 6 cutover; SECURITY.md and PLATFORM_STATE.md both name it to record that it is gone'],
  ['syncClient.js',
    'the WebSocket sync layer deleted in the Stage 6 cutover; SECURITY.md and PLATFORM_STATE.md both name it to record that it is gone'],
  ['electron/sync/syncServer.js',
    'same deletion, named by full path in PLATFORM_STATE.md\'s "Removed / Replaced" section'],
  ['electron/sync/syncClient.js',
    'same deletion, named by full path in PLATFORM_STATE.md\'s "Removed / Replaced" section'],
  ['provenance.s2a.test.js',
    'retired with the WebSocket transport; CRDT_SECURITY_GAPS.md names it to record which test went away and why'],
  ['v67_down.js',
    'reserved but never committed on THIS tree — an unmerged worktree elsewhere (claude/shoresh-rendezvous-wan-handoff-5f211b) has an unpushed v67_down.js; PLATFORM_STATE.md and localDb.js name it to record why v68 (T195) skips past 67 rather than claim it'],

  // Named inside a LIVE section of PLATFORM_STATE.md — a row or sentence whose
  // job is to say what the current thing replaced. Each is a one-line "X, which
  // replaced Y" note, which is why it is not inside a historical region marker.
  ['JoinScreen.jsx',
    'replaced by JoinByCodeScreen.jsx at Stage 6; the Screens table names it so the row explains what changed'],
  ['ReconciliationQueue.jsx',
    'folded into ReconciliationScreen.jsx (R2\'b); named to record which components it replaced'],
  ['ReconciliationSummary.jsx', 'same R2\'b rebuild — named to record what it replaced'],
  ['ReconciliationLedger.jsx', 'same R2\'b rebuild — named to record what it replaced'],
  ['SpecialDaysScreen.jsx',
    'merged into SpecialEventsScreen.jsx (ADR 2026-08-29); named to record the merge'],
  ['CalmEmptyState.jsx',
    'the never-imported empty-state component, named in the imagery section precisely to record that it was removed unused'],
  ['src/data/deriveOccupancy.js',
    'deleted with the spatial layer (PR #201); named by full path where the removal is explained'],
  ['run.js',
    'the integration runner before Stage 6, now run.automerge.js; the Test Coverage section names the old name to explain the rename'],
  ['electron/sync/scheduleE2E.sync.test.js',
    'the WS-transport end-to-end test, retired at Stage 6; named in a historical FIXED note about applyRemoteOp'],
])

// --- reference extraction ---------------------------------------------------
//
// The first implementation (recovered from tag archive/grpc-doc-gate) matched
// ONLY a `token.ext` sitting alone inside inline backticks, and resolved any
// slashed path by BASENAME. The anti-vacuity suite in checkDocFileRefs.test.js
// showed that shape is close to vacuous: a path inside a ```fence```, a
// `file.js:42` line reference, a directory, a `dir/**` glob tail, a dead
// markdown link, and a `.mjs`/`.md` file were all invisible — and
// `electron/sync/discovery.js` resolved CLEAN against the real
// electron/sync/automerge/discovery.js, which is precisely the wrong claim this
// gate exists to catch. Extraction is therefore wider and resolution stricter
// than the recovered code.

const SOURCE_EXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|json|sql|css|md|html|sh|ya?ml)$/

/**
 * A descriptive doc contains a historical layer inside it, and naming deleted
 * code there is the POINT — PLATFORM_STATE.md's "Removed / Replaced" section
 * exists to say what went away. Gating that would make the check pure noise and
 * get it switched off, so three exemptions are recognised, in rising order of
 * how explicit the author has to be:
 *
 *   1. A line whose FIRST content is struck through — a retired table row
 *      (`| ~~schedule:map~~ | …`) or a retired list item (`- ~~day_overrides~~ …`).
 *      The whole line is then about something withdrawn. Deliberately not "any
 *      line containing `~~`": on a corpus written one paragraph per line, an
 *      incidental mid-sentence strikethrough would blind the check to every
 *      live claim in the rest of that paragraph.
 *   2. A line opening with `_Prior:` — this corpus's convention for a dated
 *      header note kept for the record.
 *   3. An explicit `<!-- doc-refs:historical -->` … `<!-- /doc-refs:historical -->`
 *      region, for a whole section of changelog or removal notes.
 *
 * Each is line-scoped on purpose: these documents run one paragraph per line, so
 * the line is the unit an author actually reasons about.
 */
const HISTORICAL_OPEN = '<!-- doc-refs:historical -->'
const HISTORICAL_CLOSE = '<!-- /doc-refs:historical -->'

export function stripHistorical(text) {
  let inRegion = false
  return String(text).split('\n').map((line) => {
    if (line.includes(HISTORICAL_OPEN)) { inRegion = true; return '' }
    if (line.includes(HISTORICAL_CLOSE)) { inRegion = false; return '' }
    if (inRegion) return ''
    if (/^\s*(?:[-*+]|\|)?\s*~~/.test(line)) return ''
    if (/^\s*_?_?Prior:/.test(line)) return ''
    return line
  }).join('\n')
}

/**
 * Inline code spans, fenced-block bodies, markdown link targets — and any
 * root-anchored path sitting in bare prose.
 *
 * That last one matters more than it looks: the first three are all FORMATTING
 * conventions, and a copy-edit that unwraps a path from its backticks would
 * otherwise silently drop it out of coverage, leaving a doc that reads more
 * polished and is checked less. Requiring a repo-root first segment keeps bare
 * prose from dragging in every slash-shaped word in the file.
 */
const PROSE_PATH = /\b(?:src|electron|test|scripts|legacy|docs)\/[A-Za-z0-9_./*-]+/g

function* candidateTokens(text) {
  const src = String(text)
  for (const [, body] of src.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) yield* body.split(/\s+/)
  for (const [, span] of src.matchAll(/`([^`\n]+)`/g)) yield* span.split(/\s+/)
  for (const [, target] of src.matchAll(/\]\(([^)\s]+)\)/g)) yield target
  for (const [match] of src.matchAll(PROSE_PATH)) {
    // Unformatted prose is the noisiest source, so it must look unmistakably
    // like a path: an extension, or at least two segments below the repo root.
    // English writes "labelled legacy/dead in the file itself", and that is not
    // a claim about a directory named dead.
    if (SOURCE_EXT.test(match.replace(/[).,;]+$/, '')) || match.split('/').length > 2) yield match
  }
}

/**
 * Tokens shaped exactly like a source file that are names of things, not files.
 * `Node.js` is `stem.js` and no lexical rule separates it from `buildSchedule.js`,
 * so the separation is a list. Keep it short: if it grows past technology brand
 * names, the extraction rule is wrong rather than the list being incomplete.
 */
const NOT_A_FILE = new Set([
  'Node.js', 'React.js', 'Vue.js', 'Next.js', 'Three.js', 'Chart.js', 'D3.js',
  'Express.js', 'Nuxt.js', 'Backbone.js', 'Ember.js', 'Socket.io', 'Electron.js',
])

/** Strip the decoration prose puts around a path. */
function normalizeToken(raw) {
  let t = String(raw).trim().replace(/^[([{'"<]+/, '').replace(/[)\]},.;:'">]+$/, '')
  t = t.replace(/#.*$/, '')                          // path.js#exportName
  t = t.replace(/:\d+(?::\d+)?$/, '')                // file.js:42 and file.js:42:7
  t = t.replace(/\/\*\*?$/, '').replace(/\/+$/, '')  // dir/** , dir/* , dir/
  return t
}

/** A family or placeholder, not a claim about one real path. */
const isPattern = (t) => t.includes('*') || t.includes('?') || /(?:^|\/)v\d+N_/.test(t)

/**
 * Is this token a claim about a path in THIS repo?
 *
 * Two admissible shapes, deliberately narrow so shell words, URLs, absolute and
 * home-relative paths, and scoped package names are never mistaken for claims:
 *   - it carries a source extension with a real stem before it, or
 *   - it is a slashed path whose first segment is a top-level entry of the repo.
 * The second clause is what keeps `Support/shoresh-dev` (the tail of a quoted
 * ~/Library path, once split on whitespace) and `node_modules/...` out.
 */
function isPathClaim(t, topLevel) {
  if (!t || isPattern(t) || NOT_A_FILE.has(t)) return false
  if (!/^[A-Za-z0-9_]/.test(t)) return false   // ~/… , /… , ./… , @scope/… , -flag
  if (t.includes('://')) return false
  // Code, not a path: `readFileSync('../sync/x.js')` survives whitespace splitting
  // as one token and must not be read as a claim about `readFileSync('../sync/x.js`.
  if (/["'()[\]{}<>=]/.test(t)) return false
  if (t.endsWith('-')) return false            // `docs/adr/2026-08-17-` is a prefix
  const first = t.split('/')[0]
  if (first === 'node_modules') return false
  // A bare `.test.js` is a naming CONVENTION, not a file: require a stem.
  if (SOURCE_EXT.test(t)) return /[A-Za-z0-9_]\.[A-Za-z0-9]+$/.test(t.split('/').pop())
  return t.includes('/') && topLevel.has(first)
}

export function checkDocFileRefs(docs, resolve, topLevel = DEFAULT_TOP_LEVEL) {
  const findings = []
  for (const { path, text } of docs) {
    const seen = new Set()
    for (const raw of candidateTokens(stripHistorical(text))) {
      const token = normalizeToken(raw)
      if (!isPathClaim(token, topLevel) || seen.has(token)) continue
      seen.add(token)
      // The allowlist says "this path is absent ON PURPOSE". If it resolves
      // again, the entry has stopped documenting an absence and started
      // exempting a name — and would go on absorbing every future claim about
      // whatever now lives there. An exemption that outlives its reason is the
      // shape T184's v13 misclassification had, so it expires loudly.
      if (DELIBERATELY_ABSENT.has(token)) {
        if (resolve(token)) {
          findings.push(finding('doc-absence-allowlist-stale',
            `\`${token}\` is listed in DELIBERATELY_ABSENT but exists again. Remove the entry — ` +
            'while it stands, every claim any descriptive doc makes about that path is unchecked.'))
        }
        continue
      }
      if (resolve(token)) continue
      findings.push(finding('doc-names-missing-file',
        `${path} names \`${token}\`, which does not exist — the doc describes code that was ` +
        'deleted or moved. Correct the sentence (do not just delete the reference if the ' +
        'absence is the point: allowlist it in DELIBERATELY_ABSENT with a reason).'))
    }
  }
  return findings
}

/** The descriptive corpus: files that claim to describe what the code IS. */
function readDescriptiveDocs(root) {
  const out = []
  for (const rel of DESCRIPTIVE_DOC_PATHS) {
    const abs = join(root, rel)
    if (existsSync(abs)) out.push({ path: rel, text: readFileSync(abs, 'utf8') })
  }
  for (const dir of DESCRIPTIVE_DOC_DIRS) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.md')) continue
      out.push({ path: dir + name, text: readFileSync(join(abs, name), 'utf8') })
    }
  }
  return out
}

// `docs` is in here for the basename index specifically: docs legitimately name
// a sibling document by bare filename (`DESIGN_STANDARD.md`, an ADR's date-stem)
// without repeating its directory, and omitting the docs tree made every one of
// those a false positive.
const SEARCH_ROOTS = ['src', 'electron', 'test', 'scripts', 'legacy', 'docs']

/** Top-level repo entries a slashed path claim is allowed to start with. */
export const DEFAULT_TOP_LEVEL = new Set([...SEARCH_ROOTS, 'build', 'public'])

/**
 * Resolves a doc's path reference.
 *
 * Three shapes, resolved differently on purpose:
 *   - anchored at a repo root (`electron/sync/discovery.js`) — a claim about
 *     WHERE the file lives, so it must resolve EXACTLY, file or directory. The
 *     recovered implementation resolved everything by basename, which made a
 *     wrong-directory claim indistinguishable from a correct one.
 *   - a partial path (`rollback/v59_down.js`) — a common doc shorthand that was
 *     never claiming to start at the repo root; resolved by path suffix.
 *   - a bare module name (`buildSchedule.js`) — resolved by basename.
 *
 * Stated so it is not mistaken for an oversight: the last two answer "does a
 * file with this tail exist anywhere", not "is this sentence's claim true". A
 * doc naming a bare module that has since moved, or a partial path that matches
 * a same-named file under a different parent, resolves clean. That is the price
 * of supporting the shorthand docs actually use; write the anchored path when
 * you want the claim checked.
 */
export function makeResolver(root, topLevel = DEFAULT_TOP_LEVEL) {
  let index = null
  const build = () => {
    const names = new Set()
    const paths = new Set()
    const walk = (dir, depth) => {
      if (depth > 8) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const abs = join(dir, e.name)
        if (e.isDirectory()) { paths.add(abs); walk(abs, depth + 1) }
        else { names.add(e.name); paths.add(abs) }
      }
    }
    for (const r of SEARCH_ROOTS) {
      const abs = join(root, r)
      if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, 0)
    }
    return { names, paths }
  }
  return (token) => {
    if (existsSync(join(root, token))) return true
    index ??= build()
    if (!token.includes('/')) return index.names.has(token)
    // Anchored at a repo root: the exact-path check above was the whole answer.
    if (topLevel.has(token.split('/')[0])) return false
    const tail = '/' + token
    for (const p of index.paths) if (p.endsWith(tail)) return true
    return false
  }
}

export function checkAll(root, execFn = (cmd) => execSync(cmd, { encoding: 'utf8' })) {
  const exists = (p) => existsSync(join(root, p))
  const docs = readDocs(root)
  const findings = docs.flatMap((doc) => checkDoc(doc, exists))

  const path = join(root, INDEX_PATH)
  const committed = existsSync(path) ? readFileSync(path, 'utf8') : null
  findings.push(...checkIndexFreshness(committed, generate(root)))

  findings.push(...checkPlatformStateFreshness(root, execFn))

  findings.push(...checkDocFileRefs(readDescriptiveDocs(root), makeResolver(root)))

  // Loaded lazily and defensively: this check reads application modules rather
  // than documents, and a doc-hygiene run must not hard-fail because an app
  // module could not be imported (a native-module ABI mismatch, say). A skip is
  // announced, never silent — an unreported skip would read as a pass.
  findings.push(...checkWritableEntitiesCanSync(projectionsRegistry, modeledEntities))

  findings.push(...checkTicketNumberUniqueness(docs))

  findings.push(...checkRunRecordsFilledIn(root, docs))

  const subjects = gatherCompletionSubjects(root, execFn)
  if (subjects !== null) {
    findings.push(...checkStatusDrift(subjects, docs))
    const added = gatherAddedRunRecords(root, execFn)
    // A skip is announced, never silent. An unreported skip would read as a
    // pass, which is the defect class this whole ticket is about.
    if (added !== null) findings.push(...checkRunRecordFiled(subjects, added))
    else console.warn('check:governance — run-record check skipped (could not diff docs/work/runs)')
  } else {
    console.warn('check:governance — status-drift check skipped (no origin/main to diff against)')
  }

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
