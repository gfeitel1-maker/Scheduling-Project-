// Reports, over Claude Code session transcripts (~/.claude/projects/<slug>/**/*.jsonl):
// skills invoked, agents dispatched, and whether each dispatch resolved or was left hanging.
// Pure parse/fold logic below; I/O (file walking, cursor) is in main().

import { createReadStream, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { memoryProjectSlug } from './memoryProject.js'

// One JSONL line -> zero or more events. Never throws.
export function parseLine(rawLine) {
  let record
  try {
    record = JSON.parse(rawLine)
  } catch {
    return []
  }
  if (!record || typeof record !== 'object') return []

  const events = []

  if (record.type === 'assistant') {
    const content = record.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== 'tool_use') continue
        if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
          events.push({ kind: 'skill', name: block.input.skill })
        } else if (block.name === 'Agent' && typeof block.input?.subagent_type === 'string') {
          // tool_use_id is carried alongside subagent_type (additive, optional) so a consumer that
          // needs to join a dispatch to its later resolution can do so without re-parsing the
          // transcript itself — see opinionReportProvenance.js, which is the reason this exists.
          events.push({
            kind: 'dispatch',
            subagent_type: block.input.subagent_type,
            tool_use_id: typeof block.id === 'string' ? block.id : null,
          })
        }
      }
    }
  }

  if (record.type === 'user') {
    const tur = record.toolUseResult
    if (tur && typeof tur === 'object' && typeof tur.agentId === 'string' && typeof tur.status === 'string') {
      // The launch-ack record carries BOTH toolUseResult (agentId/status) and, in the same
      // message's content array, the tool_result block whose tool_use_id names the dispatch that
      // produced it. Joining the two here — rather than in a second pass — is what lets a
      // consumer answer "which subagent_type did this agentId come from" without inventing its
      // own correlation pass over the same records.
      let toolUseId = null
      const content = record.message?.content
      if (Array.isArray(content)) {
        const resultBlock = content.find((b) => b && b.type === 'tool_result' && typeof b.tool_use_id === 'string')
        if (resultBlock) toolUseId = resultBlock.tool_use_id
      }
      events.push({ kind: 'resolution', agentId: tur.agentId, status: tur.status, tool_use_id: toolUseId })
    }
  }

  if (record.type === 'attachment') {
    const att = record.attachment
    if (att && att.type === 'task_status' && typeof att.taskId === 'string' && typeof att.status === 'string') {
      events.push({ kind: 'resolution', agentId: att.taskId, status: att.status, tool_use_id: null })
    }
  }

  return events
}

// Exported (not just module-local) so opinionReportProvenance.js applies the exact same
// "what counts as done" rule Observer already uses, instead of restating it and risking drift.
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'error'])

// Pairs an Agent dispatch's tool_use id with the agentId reported in its launch-acknowledgment
// record (see parseLine — both are stamped with the same tool_use_id). This is what lets a
// dispatch be attributed to a specific agentId, rather than just counted by subagent_type.
//
// Only correlates within one flat event list, i.e. one file's events: a dispatch and its
// acknowledgment are adjacent records in the same session transcript in every case observed in
// the corpus (see T170). A dispatch whose acknowledgment record falls in a different file (e.g.
// split by compaction) will not correlate — it is counted as unresolved, not silently dropped;
// see the coverage numbers this produces in main().
export function correlateDispatches(events) {
  const launchesByToolUseId = new Map() // toolUseId -> subagent_type
  const correlated = []
  for (const ev of events) {
    if (ev.kind === 'dispatch' && ev.tool_use_id) {
      launchesByToolUseId.set(ev.tool_use_id, ev.subagent_type)
    } else if (ev.kind === 'resolution' && ev.tool_use_id && launchesByToolUseId.has(ev.tool_use_id)) {
      correlated.push({
        subagent_type: launchesByToolUseId.get(ev.tool_use_id),
        tool_use_id: ev.tool_use_id,
        agentId: ev.agentId,
      })
      launchesByToolUseId.delete(ev.tool_use_id) // one launch ack per dispatch
    }
  }
  return correlated
}

// Fold a flat list of events into a report. Optionally merge in prior partial
// reports (for incremental, cross-file accumulation) via `priorReports`.
// `correlated`, when supplied, is the result of correlateDispatches(events) for this same
// events list — callers that already computed it (main(), to also pull agentIds by role) can
// pass it through instead of paying for the correlation twice.
export function foldEvents(events, priorReports = [], correlated = null) {
  const skills = {}
  const dispatches = {}
  const completion = { completed: 0, truncated: 0 }
  // agentId -> 'pending' | 'completed', in dispatch order via a plain array
  const pendingByAgentId = new Map()

  for (const ev of events) {
    if (ev.kind === 'skill') {
      skills[ev.name] = (skills[ev.name] || 0) + 1
    } else if (ev.kind === 'dispatch') {
      dispatches[ev.subagent_type] = (dispatches[ev.subagent_type] || 0) + 1
    } else if (ev.kind === 'resolution') {
      const prior = pendingByAgentId.get(ev.agentId)
      if (TERMINAL_STATUSES.has(ev.status)) {
        pendingByAgentId.set(ev.agentId, 'completed')
      } else if (!prior) {
        pendingByAgentId.set(ev.agentId, 'pending')
      }
    }
  }

  for (const status of pendingByAgentId.values()) {
    if (status === 'completed') completion.completed += 1
    else completion.truncated += 1
  }

  // Per role, how many dispatches resolved an agentId at all (regardless of transcript/CLI
  // checks, which are Grader-only and done in main()). This is the coverage denominator the
  // ticket asks for: dispatches[role] is the population, agentIdCoverage[role] is how much of
  // it this instrument could actually attribute to an agentId.
  const agentIdCoverage = {}
  for (const c of correlated || correlateDispatches(events)) {
    agentIdCoverage[c.subagent_type] = (agentIdCoverage[c.subagent_type] || 0) + 1
  }

  let report = { skills, dispatches, completion, agentIdCoverage }

  for (const prior of priorReports) {
    report = mergeReports(report, prior)
  }

  return report
}

function mergeReports(a, b) {
  const skills = { ...a.skills }
  for (const [k, v] of Object.entries(b.skills)) skills[k] = (skills[k] || 0) + v

  const dispatches = { ...a.dispatches }
  for (const [k, v] of Object.entries(b.dispatches)) dispatches[k] = (dispatches[k] || 0) + v

  const completion = {
    completed: a.completion.completed + b.completion.completed,
    truncated: a.completion.truncated + b.completion.truncated,
  }

  const agentIdCoverage = { ...a.agentIdCoverage }
  for (const [k, v] of Object.entries(b.agentIdCoverage)) agentIdCoverage[k] = (agentIdCoverage[k] || 0) + v

  return { skills, dispatches, completion, agentIdCoverage }
}

// scripts/gateReportCli.js's own CLI entrypoint hardcodes runsDir to 'docs/work/runs' — there is
// no --runs-dir flag, so this is a known constant when the CLI form is detected, not something
// parsed off the command line. (`runGateReportCli()` called directly from JS could pass a
// different runsDir, but that call is invisible from a transcript's Bash command text either way.)
const GATE_REPORT_CLI_RE = /\bnode\s+(?:\.\/)?scripts\/gateReportCli\.js\b/
const GATE_REPORT_CLI_RUNS_DIR = 'docs/work/runs'

// Scans one subagent transcript's raw text for a Bash invocation of gateReportCli.js. Pure
// string -> object; the file read itself happens in main().
export function detectGateReportCliInvocation(transcriptText) {
  if (typeof transcriptText === 'string' && GATE_REPORT_CLI_RE.test(transcriptText)) {
    return { invoked: true, runsDir: GATE_REPORT_CLI_RUNS_DIR }
  }
  return { invoked: false, runsDir: null }
}

// Subagent transcripts live at <sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl, sibling
// to the main transcript file <sessionDir>/<sessionId>.jsonl. Pure path arithmetic, no I/O.
export function subagentTranscriptPath(mainTranscriptPath, agentId) {
  const sessionId = basename(mainTranscriptPath, '.jsonl')
  return join(dirname(mainTranscriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`)
}

// ---- I/O: file walking + cursor (not unit tested; exercised by the real-corpus run) ----

// The second entry is the live memory store's slug, which lives in
// scripts/memoryProject.js so the shell pipeline and this file cannot drift about
// where it is (T171 item 4). The first is a literal prefix on purpose: it matches
// ~/dev/shoresh AND every worktree slug beneath it, which is a pattern, not a path.
const SLUGS_GLOB_PREFIXES = [
  '-Users-gregfeitel-dev-shoresh',
  memoryProjectSlug(),
]

const CURSOR_PATH = join(homedir(), '.claude', 'observeRun.cursor.json')

/**
 * Every `.jsonl` under a matching slug, at ANY depth.
 *
 * This walked one level only — `<slug>/*.jsonl` — while its own doc comment claimed
 * `<slug>/**` + `/*.jsonl`. Most transcripts live one level deeper, in per-session
 * UUID directories, so it saw 132 files out of 1,936 and reported dispatch counts that were
 * wrong by a factor of five, plus "isSidechain is essentially absent" when there are 156,802
 * of them. A report that silently measures a seventh of the corpus is worse than no report:
 * it is confidently wrong, and it was believed. Recurse.
 */
function findJsonlFiles(projectsDir) {
  const out = []
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return out
  }
  const walk = (dir) => {
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.isFile() && item.name.endsWith('.jsonl')) out.push(full)
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!SLUGS_GLOB_PREFIXES.some((p) => entry.name.startsWith(p))) continue
    walk(join(projectsDir, entry.name))
  }
  return out
}

function loadCursor() {
  if (!existsSync(CURSOR_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CURSOR_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function saveCursor(cursor) {
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2))
}

// A line can only carry an event we care about if it mentions one of these -
// cheap substring check to skip JSON.parse on the (large majority of) lines
// that can't possibly contain a Skill/Agent tool_use or a dispatch resolution.
function couldContainEvent(line) {
  return line.includes('"tool_use"') || line.includes('agentId') || line.includes('task_status')
}

// Read only the bytes appended since `startByte`, split into complete lines,
// parse each. Manual chunked read (rather than readline) to keep per-file
// overhead low across ~1600 files. Only bytes up to the last complete '\n'
// are counted as consumed, so a partial trailing line is re-read next run.
export function readEventsFromOffset(filePath, startByte) {
  return new Promise((resolve, reject) => {
    const events = []
    const size = statSync(filePath).size
    // A file SHORTER than our cursor was truncated, rotated, or replaced — the offset now points
    // into different content, and `startByte >= size` would silently reset it to the new size,
    // discarding every event in the first `size` bytes with no symptom. Red Hat, 2026-09-15.
    // Re-read from zero and say so; a double count is visible and arguable, a silent hole is not.
    if (startByte > size) {
      resolve({ events, endByte: size, bytesRead: 0, rewound: true, restartFrom: 0 })
      return
    }
    if (startByte === size) {
      resolve({ events, endByte: size, bytesRead: 0 })
      return
    }
    const stream = createReadStream(filePath, { start: startByte, highWaterMark: 1024 * 1024 })
    // Carry is kept as a Buffer, not a decoded string: some lines in this
    // corpus run several MB (a single tool_result can embed a large file
    // read), and string-concatenating a growing decoded carry across many
    // chunks turned that into quadratic work. Buffer.concat + a byte-level
    // newline search avoids re-decoding anything until a line is complete.
    let carry = Buffer.alloc(0)
    let consumedBytes = 0
    stream.on('data', (chunk) => {
      let buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
      let searchFrom = 0
      let newlineIdx
      while ((newlineIdx = buf.indexOf(0x0a, searchFrom)) !== -1) {
        const line = buf.toString('utf8', searchFrom, newlineIdx)
        consumedBytes += newlineIdx - searchFrom + 1
        searchFrom = newlineIdx + 1
        if (line.length > 0 && couldContainEvent(line)) {
          for (const ev of parseLine(line)) events.push(ev)
        }
      }
      carry = buf.subarray(searchFrom)
    })
    stream.on('end', () => {
      resolve({ events, endByte: startByte + consumedBytes, bytesRead: consumedBytes })
    })
    stream.on('error', reject)
  })
}

export async function main() {
  const start = Date.now()
  const projectsDir = join(homedir(), '.claude', 'projects')
  const files = findJsonlFiles(projectsDir)
  const cursor = loadCursor()

  const perFileReports = []
  let totalBytesRead = 0
  let filesTouched = 0

  // Sequential awaits left this I/O-bound and slow across ~1600 files; overlap
  // reads with a bounded concurrency so the OS/disk can service many at once.
  const CONCURRENCY = 16
  const rewoundFiles = []
  // Grader is the role that produces the durable artifact (a committed gate report), so it's
  // the one dispatch stream we follow all the way to "did the CLI run and where did it write" —
  // see T170. Collected as (filePath, agentId) pairs here (foldEvents/mergeReports only keep
  // per-role counts, not identities) so the per-dispatch filesystem check below has enough to
  // find the right subagent transcript.
  const graderDispatchSources = []
  let nextIndex = 0
  async function worker() {
    while (nextIndex < files.length) {
      const filePath = files[nextIndex++]
      const startByte = cursor[filePath] || 0
      let res = await readEventsFromOffset(filePath, startByte)
      if (res.rewound) {
        // Truncated, rotated or replaced since the last run. Re-read the whole file rather than
        // accept a hole, and COUNT it, so the summary can never look clean while data was lost.
        rewoundFiles.push(filePath)
        res = await readEventsFromOffset(filePath, 0)
      }
      const { events, endByte, bytesRead } = res
      if (bytesRead > 0) filesTouched += 1
      totalBytesRead += bytesRead
      cursor[filePath] = endByte
      if (events.length > 0) {
        const correlated = correlateDispatches(events)
        perFileReports.push(foldEvents(events, [], correlated))
        for (const c of correlated) {
          if (c.subagent_type === 'grader') graderDispatchSources.push({ filePath, agentId: c.agentId })
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const report = foldEvents([], perFileReports)
  saveCursor(cursor)

  // Per-Grader-dispatch detail: does its subagent transcript exist, and did it invoke
  // gateReportCli.js. Only Grader gets this (transcript-content) level of check — reading and
  // regexing ~74 multi-MB files is cheap; doing it for all 947 dispatches would not be "cheap".
  const graderPerDispatch = graderDispatchSources.map(({ filePath, agentId }) => {
    const transcriptPath = subagentTranscriptPath(filePath, agentId)
    const transcriptExists = existsSync(transcriptPath)
    let cli = { invoked: false, runsDir: null }
    if (transcriptExists) {
      try {
        cli = detectGateReportCliInvocation(readFileSync(transcriptPath, 'utf8'))
      } catch {
        // Unreadable (permissions, deleted between existsSync and readFileSync): report as
        // found-but-unchecked rather than silently counting it as "did not invoke".
        cli = { invoked: false, runsDir: null, unreadable: true }
      }
    }
    return { agentId, sourceFile: filePath, transcriptExists, gateReportCliInvoked: cli.invoked, runsDir: cli.runsDir }
  })

  const graderDispatchTotal = report.dispatches.grader || 0
  const graderResolvedAgentId = report.agentIdCoverage.grader || 0
  const graderUnresolvedAgentId = graderDispatchTotal - graderResolvedAgentId
  const graderTranscriptFound = graderPerDispatch.filter((d) => d.transcriptExists).length
  const graderCliInvoked = graderPerDispatch.filter((d) => d.gateReportCliInvoked).length

  const elapsedMs = Date.now() - start

  console.log(JSON.stringify({
    filesScanned: files.length,
    filesWithNewData: filesTouched,
    // Coverage, reported rather than assumed. Every probe that preceded this tool silently
    // excluded part of its population and quoted a percentage as though it covered all of it.
    filesRewound: rewoundFiles.length,
    rewoundPaths: rewoundFiles.slice(0, 10),
    bytesRead: totalBytesRead,
    elapsedMs,
    report,
    grader: {
      coverage:
        `${graderDispatchTotal} grader dispatches this run; ${graderResolvedAgentId} resolved an ` +
        `agentId, ${graderUnresolvedAgentId} did not (no launch-acknowledgment record correlated ` +
        `to the dispatch's tool_use id in this file — see correlateDispatches). Of the ` +
        `${graderResolvedAgentId} with a resolved agentId, ${graderTranscriptFound} have a subagent ` +
        `transcript on disk and ${graderCliInvoked} of those invoked gateReportCli.js. ` +
        `Percentages below cover only the ${graderResolvedAgentId} resolved dispatches, not the ` +
        `full ${graderDispatchTotal} — read totalDispatches/resolvedAgentId/unresolvedAgentId ` +
        `together, not the invocation count alone.`,
      totalDispatches: graderDispatchTotal,
      resolvedAgentId: graderResolvedAgentId,
      unresolvedAgentId: graderUnresolvedAgentId,
      transcriptFound: graderTranscriptFound,
      transcriptMissing: graderPerDispatch.length - graderTranscriptFound,
      gateReportCliInvoked: graderCliInvoked,
      gateReportCliNotInvoked: graderPerDispatch.length - graderCliInvoked,
      perDispatch: graderPerDispatch,
    },
  }, null, 2))
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
