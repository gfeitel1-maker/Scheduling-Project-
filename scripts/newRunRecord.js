#!/usr/bin/env node
// Make filing a run record cheap (T167, part 1).
//
// THE MEASUREMENT THIS EXISTS FOR: 283 commits landed between 2026-08-25 and
// 2026-09-14 with zero run records. The reviewers ran — the session transcripts
// show maker 63, code-reviewer 23, verifier 21 — and then nobody transcribed the
// result, so the durable artifact was never produced.
//
// The step gets skipped because it costs effort at the exact moment the work
// feels done. So the fix is subtraction rather than exhortation: anything a
// machine already knows should not be retyped by a person or an agent.
//
// WHAT IT FILLS, because git and the gate already know it:
//   date, related_tickets (from `closes T###` across the range), task (the first
//   commit subject), task_class (read off the referenced ticket), and
//   completion_evidence (the commit shas plus the gate's own verdict line).
//
// WHAT IT REFUSES TO FILL, because inventing it would be worse than an empty
// file: which agents ran, and why the others did not. That is judgement, and a
// fabricated omission reason is exactly the "history invented to satisfy a gate"
// that T167 rules out. Those fields are emitted as NEEDS_JUDGEMENT markers, so a
// half-filled record cannot pass for a complete one — by eye or by gate.
import { execFileSync } from 'node:child_process'
import { AGENTS } from './check-governance.js'
import fs from 'node:fs'
import path from 'node:path'

export const NEEDS_JUDGEMENT = '<<NEEDS JUDGEMENT>>'

// Splitting git output on a character a commit subject cannot contain. A plain
// space or pipe would break on the first subject that used one.
const SEP = ''

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** `closes T123` / `Merge S4b` — the vocabulary WORK_RECORD_STANDARD 3.1 defines. */
export function ticketRefsFrom(subjects) {
  const out = []
  for (const s of subjects || []) {
    for (const m of String(s).matchAll(/(?:closes|merge)\s+([TS]\d+[a-z]?)/gi)) {
      const id = m[1].toUpperCase()
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

/**
 * The gate's own verdict line, so a record QUOTES the run rather than someone's
 * memory of it.
 *
 * Returns null when the log holds neither a verdict nor a test count. An absent
 * gate must read as absent and never as a pass — the defect class T171 and T174
 * both found, where a missing or unwritable record was taken for success.
 */
export function gateSummaryFrom(text) {
  if (!text) return null
  const verdict = text.match(/^(.*VERIFY (?:PASSED|FAILED).*)$/m)
  const tests = text.match(/^\s*Tests\s+(.+)$/m)
  if (!verdict && !tests) return null
  const parts = []
  if (verdict) parts.push(verdict[1].trim())
  if (tests) parts.push(`Tests ${tests[1].trim()}`)
  return parts.join(' — ')
}

/**
 * Any ticket the range MENTIONS, closure or not.
 *
 * Deliberately separate from ticketRefsFrom. `closes T123` is a CLOSURE CLAIM
 * and check-governance gates on it; a bare `T123` is an association and gates on
 * nothing. A run record wants both — found by using this tool on its own first
 * commit, whose subject is "T167 part 1: ..." and which therefore produced an
 * empty `related_tickets` while plainly being about T167.
 *
 * Kept as association only: nothing here feeds a closure check, so a looser
 * match cannot make the status-drift gate read differently.
 */
export function mentionedTicketsFrom(subjects) {
  const out = []
  for (const s of subjects || []) {
    for (const m of String(s).matchAll(/\b([TS]\d+[a-z]?)\b/gi)) {
      const id = m[1].toUpperCase()
      if (!out.includes(id)) out.push(id)
    }
  }
  return out
}

function ticketPathFor(root, id) {
  const dir = path.join(root, 'docs/work/tickets')
  if (!fs.existsSync(dir)) return null
  const n = id.slice(1)
  const hit = fs.readdirSync(dir).find((f) => new RegExp(`^T${n}[-.]`).test(f))
  return hit ? `docs/work/tickets/${hit}` : null
}

function taskClassFrom(root, ticketPaths) {
  for (const p of ticketPaths) {
    const m = fs.readFileSync(path.join(root, p), 'utf8').match(/^task_class:\s*(\S+)/m)
    if (m) return m[1]
  }
  return NEEDS_JUDGEMENT
}

// EVERY roster agent is pre-listed in omitted_agents, each with NEEDS_JUDGEMENT
// for its reason — found by filing this generator's own first record and having
// `check:governance` reject it: `maker` and `grader` were simply forgotten.
//
// Article VII requires every agent to be selected or omitted-with-a-reason. A
// blank template relies on the author remembering ten roles at the moment they
// are least inclined to; pre-listing them turns remembering into deleting, which
// is the same subtraction principle as the rest of this file. An agent that DID
// run is moved up to selected_agents and its stub removed.
export function buildRunRecord({ subjects, shas, ticketPaths, taskClass, date, gateSummary }) {
  const task = (subjects && subjects[0]) || NEEDS_JUDGEMENT
  const evidence = [
    ...(shas || []).map((s) => `commit ${s}`),
    gateSummary ? `gate: ${gateSummary}` : `gate: ${NEEDS_JUDGEMENT} — paste the verify verdict line`,
  ]
  return `---
task: ${task}
document_type: run
date: ${date}
round: 1
status: pass
task_class: ${taskClass}
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/WORK_RECORD_STANDARD.md]
related_tickets: [${(ticketPaths || []).join(', ')}]
related_specs: []
related_adrs: []
selected_agents: ${NEEDS_JUDGEMENT}
omitted_agents:
${AGENTS.map((a) => `  - agent: ${a}\n    reason: ${NEEDS_JUDGEMENT}\n    note: ${NEEDS_JUDGEMENT}`).join('\n')}
deterministic_checks: [npm run verify]
human_gates: []
verdict: ${NEEDS_JUDGEMENT}
completion_evidence:
${evidence.map((e) => `  - ${e}`).join('\n')}
archive_when: ${NEEDS_JUDGEMENT}
---

# ${task}

## What shipped

${(subjects || []).map((s) => `- ${s}`).join('\n')}

## Evidence

${evidence.map((e) => `- ${e}`).join('\n')}

## Agents

${NEEDS_JUDGEMENT} — name who ran, and for each who did not, a reason from
\`no-predicate\` / \`not-applicable\` / \`human-waived\` (the last quoting the
owner verbatim).

This is the part a machine must not guess. A fabricated omission reason is worse
than an absent record, because it looks like diligence.
`
}

export function generate({ root, range, gateLogPath, date }) {
  const log = git(['log', `--format=%h${SEP}%s`, range], root)
  const entries = log ? log.split('\n').map((l) => l.split(SEP)) : []
  if (!entries.length) throw new Error(`no commits in range ${range} — nothing to record`)
  const shas = entries.map((e) => e[0])
  const subjects = entries.map((e) => e[1])
  // Closure references first (they are the authoritative link), then any other
  // ticket the range merely mentions — see mentionedTicketsFrom.
  const ids = [...new Set([...ticketRefsFrom(subjects), ...mentionedTicketsFrom(subjects)])]
  const ticketPaths = ids.map((id) => ticketPathFor(root, id)).filter(Boolean)
  const gateSummary =
    gateLogPath && fs.existsSync(gateLogPath)
      ? gateSummaryFrom(fs.readFileSync(gateLogPath, 'utf8'))
      : null
  return buildRunRecord({
    subjects,
    shas,
    ticketPaths,
    taskClass: taskClassFrom(root, ticketPaths),
    date: date || new Date().toISOString().slice(0, 10),
    gateSummary,
  })
}

if (process.argv[1] && process.argv[1].endsWith('newRunRecord.js')) {
  const args = process.argv.slice(2)
  const range = args.find((a) => !a.startsWith('--')) || 'origin/main..HEAD'
  const gateArg = args.find((a) => a.startsWith('--gate='))
  const root = process.cwd()
  const content = generate({
    root,
    range,
    gateLogPath: gateArg ? gateArg.slice('--gate='.length) : null,
  })
  const slug = content
    .match(/^task: (.+)$/m)[1]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  const out = path.join('docs/work/runs', `${new Date().toISOString().slice(0, 10)}-${slug}.md`)
  fs.writeFileSync(path.join(root, out), content)
  console.log(`wrote ${out}`)
  console.log(`${NEEDS_JUDGEMENT} markers remain — fill them before committing.`)
  console.log('They are what stops a half-filled record passing for a complete one.')
}
