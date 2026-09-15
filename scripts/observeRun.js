// Reports, over Claude Code session transcripts (~/.claude/projects/<slug>/**/*.jsonl):
// skills invoked, agents dispatched, and whether each dispatch resolved or was left hanging.
// Pure parse/fold logic below; I/O (file walking, cursor) is in main().

import { createReadStream, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
          events.push({ kind: 'dispatch', subagent_type: block.input.subagent_type })
        }
      }
    }
  }

  if (record.type === 'user') {
    const tur = record.toolUseResult
    if (tur && typeof tur === 'object' && typeof tur.agentId === 'string' && typeof tur.status === 'string') {
      events.push({ kind: 'resolution', agentId: tur.agentId, status: tur.status })
    }
  }

  if (record.type === 'attachment') {
    const att = record.attachment
    if (att && att.type === 'task_status' && typeof att.taskId === 'string' && typeof att.status === 'string') {
      events.push({ kind: 'resolution', agentId: att.taskId, status: att.status })
    }
  }

  return events
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'error'])

// Fold a flat list of events into a report. Optionally merge in prior partial
// reports (for incremental, cross-file accumulation) via `priorReports`.
export function foldEvents(events, priorReports = []) {
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

  let report = { skills, dispatches, completion }

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

  return { skills, dispatches, completion }
}

// ---- I/O: file walking + cursor (not unit tested; exercised by the real-corpus run) ----

const SLUGS_GLOB_PREFIXES = [
  '-Users-gregfeitel-dev-shoresh',
  '-Users-gregfeitel-Desktop-Camp-App-System--Applications-Schedule-Project',
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
function readEventsFromOffset(filePath, startByte) {
  return new Promise((resolve, reject) => {
    const events = []
    const size = statSync(filePath).size
    if (startByte >= size) {
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
  let nextIndex = 0
  async function worker() {
    while (nextIndex < files.length) {
      const filePath = files[nextIndex++]
      const startByte = cursor[filePath] || 0
      const { events, endByte, bytesRead } = await readEventsFromOffset(filePath, startByte)
      if (bytesRead > 0) filesTouched += 1
      totalBytesRead += bytesRead
      cursor[filePath] = endByte
      if (events.length > 0) perFileReports.push(foldEvents(events))
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  const report = foldEvents([], perFileReports)
  saveCursor(cursor)

  const elapsedMs = Date.now() - start

  console.log(JSON.stringify({
    filesScanned: files.length,
    filesWithNewData: filesTouched,
    bytesRead: totalBytesRead,
    elapsedMs,
    report,
  }, null, 2))
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
