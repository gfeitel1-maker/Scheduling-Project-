// T229 -- camper assignment inside the elective set builder. Mounted below
// ElectiveSetDetail's offerings table; not a new screen (docs/work/tickets/
// T229-elective-assignment-in-set-detail.md). Owns the phase state machine:
// empty | parsing | mapping | parsed | solving | preview | committing | committed.
//
// Parse/map/solve are pure and stay in the renderer (main.js's own comment
// says so); the only IPC is localClient.commitElectiveRun. Never
// window.shoresh directly.
import { useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { localClient } from '../../../localClient'
import { S, prefersReducedMotion, useEnterTransition } from '../../../styles/shared'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { assertImportFileSize, readWorkbookSafely, unescapeRow, IMPORT_LIMITS } from '../../../utils/exportSanitize.js'
import { inferPreferenceMapping, parsePreferenceSheet, hasContradictoryRanks } from '../../../ingest/preferenceSheet.js'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments.js'
import { SyncIcon } from '../../../components/icons/index.jsx'
import { deriveOccurrences } from './deriveOccurrences.js'
import { buildOfferings, findMismatches } from './buildOfferings.js'
import { buildAttendance } from './buildAttendance.js'
import { exportElectiveRunExcel, buildElectiveRunExport } from './exportElectiveRun.js'
import MappingCorrector from './MappingCorrector.jsx'
import ParseSummary from './ParseSummary.jsx'
import AssignmentPreview from './AssignmentPreview.jsx'
import { A } from './assignmentStyles.js'

const emptyStyles = {
  wrap: { padding: '32px 16px', textAlign: 'center' },
  title: { fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 },
  body: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 },
}

function Busy({ label }) {
  const reduced = prefersReducedMotion()
  return (
    <div style={{ ...A.busyRow, opacity: 1, transition: `opacity var(--motion-fast) var(--ease-out)` }}>
      <SyncIcon size={16} style={reduced ? undefined : { animation: 'shoresh-spin 900ms linear infinite' }} />
      <span>{label}</span>
    </div>
  )
}

// Reads the raw header+rows out of an uploaded file. A preference sheet is a
// flat table (name/id/division/rank columns), not a day x time-block grid, so
// this deliberately does NOT reuse workbookToPages/parseGridSchedule (the
// host's runImport pipeline) — those parse SCHEDULE grids and would not fit a
// camper roster. readWorkbookSafely/assertImportFileSize/unescapeRow ARE
// reused, exactly as the host does.
async function readSheetRows(file) {
  if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
    const wb = readWorkbookSafely(await file.arrayBuffer(), { type: 'array', byteLength: file.size })
    const firstSheet = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(firstSheet, { header: 1, blankrows: false, defval: '', raw: false }).map(unescapeRow)
  }
  assertImportFileSize(file.size)
  const text = await file.text()
  const rows = text.split(/\r?\n/).filter((l) => l.length > 0).map((line) => line.split(/\t|,/).map((c) => c.trim()))
  // M3 — the xlsx branch gets both size AND row-count guards via
  // readWorkbookSafely; this branch had only the byte cap, so a 10MB file of
  // millions of short lines passed the size check and then held an unbounded
  // array in the renderer. Same limit the xlsx path already enforces.
  if (rows.length > IMPORT_LIMITS.maxRowsPerSheet) {
    throw new Error(
      `A sheet in that file has too many rows (over ${IMPORT_LIMITS.maxRowsPerSheet}) to import safely. Nothing was imported.`
    )
  }
  return rows
}

export default function AssignmentPanel({
  electiveSetId, campId, setActivities, activities, groups, tiers, days, timeBlocks,
  templateSlots, scheduleTemplates, scheduleWeeks, role, onError, onNavigate,
}) {
  const [phase, setPhase] = useState('empty')
  const [rows, setRows] = useState(null)
  const [mapping, setMapping] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [templateId, setTemplateId] = useState(null)
  const [occurrences, setOccurrences] = useState([])
  const [runId, setRunId] = useState(null)
  const [result, setResult] = useState(null) // { assignments, findings }
  const [committedInfo, setCommittedInfo] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  const fileInputRef = useRef(null)
  // H3 — a synchronous guard against a double-tap committing twice. The
  // `committing` prop below covers the ordinary case (React has re-rendered
  // past the preview branch), but a re-render is not synchronous with the
  // click, and this is exactly the tablet-double-tap window a state-driven
  // disabled prop cannot close on its own.
  const committingRef = useRef(false)
  const enter = useEnterTransition('liftFade')
  const settleEnter = useEnterTransition('settle')

  // H2 — deriveOccurrences runs unconditionally in the render body, even in
  // phase 'empty' (candidateTemplateIds gates the whole panel below). A
  // malformed slot must never throw past this boundary and take the whole
  // set-detail screen down with it; memoized because a whole-camp slot scan
  // on every keystroke is a real cost at up to 480 cells.
  const { templates, deriveError } = useMemo(() => {
    try {
      const { templates: t } = deriveOccurrences({ slots: templateSlots, groups, electiveSetId })
      return { templates: t, deriveError: null }
    } catch (err) {
      return { templates: {}, deriveError: err }
    }
  }, [templateSlots, groups, electiveSetId])
  const candidateTemplateIds = Object.keys(templates)

  function reset() {
    setPhase('empty')
    setRows(null)
    setMapping(null)
    setParsed(null)
    setTemplateId(null)
    setOccurrences([])
    setRunId(null)
    setResult(null)
    setCommittedInfo(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function onFileSelected(file) {
    if (!file) return
    onError?.(null)
    setPhase('parsing')
    try {
      const fileRows = await readSheetRows(file)
      if (!fileRows || fileRows.length === 0) {
        onError?.('No rows could be read out of that file.')
        setPhase('empty')
        return
      }
      setRows(fileRows)
      setMapping(inferPreferenceMapping(fileRows[0]))
      setPhase('mapping')
    } catch (err) {
      onError?.(describeWriteFailure(err, 'Could not read that file.'))
      setPhase('empty')
    }
  }

  function confirmMapping() {
    const result = parsePreferenceSheet(rows, { campId, mapping })
    setParsed(result)
    setPhase('parsed')
    setAnnouncement(
      result.sameNameCampers.length > 0 || hasContradictoryRanks(result)
        ? 'This sheet cannot be assigned yet.'
        : `Parsed ${result.campers.length} campers, ${result.preferences.length} preferences.`
    )
  }

  // H1 — the runId is minted HERE, once per solve, and used to derive
  // OCCURRENCE ids too (not just the run/choice/preference/assignment ids
  // commitElectiveRun.js derives) -- deriveOccurrences defaults its runId to
  // the literal string 'preview' otherwise, which collided every run onto one
  // elective_occurrences row. Re-deriving against the chosen template with the
  // new runId (rather than reusing the top-level `templates`, which used the
  // 'preview' default for the candidate-count check) is what keeps the
  // occurrence ids and the runId consistent with each other.
  function chooseTemplateAndSolve(chosenTemplateId) {
    const newRunId = crypto.randomUUID()
    let occs
    try {
      occs = deriveOccurrences({ slots: templateSlots, groups, electiveSetId, runId: newRunId }).templates[chosenTemplateId]?.occurrences ?? []
    } catch (err) {
      onError?.(describeWriteFailure(err, 'Could not prepare this schedule for assignment.'))
      return
    }
    setRunId(newRunId)
    setTemplateId(chosenTemplateId)
    setOccurrences(occs)
    solve(occs)
  }

  function solve(occs) {
    setPhase('solving')
    // Deliberately async-shaped so the busy phase actually paints before the
    // (synchronous, potentially heavy) solve runs.
    setTimeout(() => {
      const offerings = buildOfferings({ occurrences: occs, setActivities, activities })
      // H4 — occurrences are tier-scoped but campers are not; without this a
      // set placed on both a Juniors cell and a Seniors cell at the same
      // day/block seats the SAME campers in both. attendance is null (skip
      // matching) when occurrences span at most one tier -- the common case,
      // where there is nothing to disambiguate.
      const { attendance, unmatched } = buildAttendance({ campers: parsed.campers, occurrences: occs, tiers })
      const { assignments, findings } = buildElectiveAssignments({
        campers: parsed.campers, occurrences: occs, offerings, preferences: parsed.preferences, attendance,
      })
      const mismatchFindings = findMismatches({ offerings, preferences: parsed.preferences })
      // T232 — one finding PER unmatched division value, naming the value and
      // the division it probably meant. The previous version reported only a
      // count, which told a director that something was wrong and nothing
      // about what to fix: they were left to find three rows in a hundred-row
      // spreadsheet they may not have authored.
      //
      // The suggestion is a PROPOSAL and nothing acts on it (T144's standing
      // decision that word-form variants are never merged automatically). The
      // camper's placement is unchanged — still considered for every
      // occurrence rather than dropped, per the never-unplaced ruling.
      const attendanceFindings = (unmatched ?? []).map((u) => ({
        kind: 'UNMATCHED_DIVISION',
        division: u.division,
        suggestion: u.suggestion,
        message: u.suggestion
          ? `${u.camperCount} camper(s) list the division \u201C${u.division}\u201D, which is not a division on this schedule \u2014 did you mean \u201C${u.suggestion}\u201D? They were considered for every occurrence.`
          : `${u.camperCount} camper(s) list the division \u201C${u.division}\u201D, which is not a division on this schedule. They were considered for every occurrence.`,
      }))
      setResult({ assignments, findings: [...findings, ...mismatchFindings, ...attendanceFindings] })
      setPhase('preview')
      setAnnouncement(
        assignments.length === 0
          ? 'No campers could be placed.'
          : `Solved: ${assignments.length} placements across ${occs.length} occurrences.`
      )
    }, 0)
  }

  async function commit() {
    // H3 — synchronous re-entrancy guard; see the committingRef comment above.
    if (committingRef.current) return
    committingRef.current = true
    setPhase('committing')
    try {
      const week = scheduleTemplates?.find((t) => t.id === templateId)
      const out = await localClient.commitElectiveRun({
        name: `Elective assignment — ${new Date().toISOString().slice(0, 10)}`,
        parsed,
        assignments: result.assignments,
        occurrences,
        scheduleTemplateId: templateId,
        scheduleWeekId: week?.week_id ?? null,
        runId,
      })
      if (!out.ok) {
        onError?.(out.error)
        setPhase('preview')
        return
      }
      setCommittedInfo({ runId: out.runId, camperCount: out.counts.campers, occurrenceCount: occurrences.length })
      setPhase('committed')
    } catch (err) {
      onError?.(describeWriteFailure(err, 'Could not commit these assignments.'))
      setPhase('preview')
    } finally {
      committingRef.current = false
    }
  }

  function exportExcel() {
    exportElectiveRunExcel({
      assignments: result.assignments, campers: parsed.campers, activities, occurrences, days, timeBlocks,
    })
  }

  function exportJson() {
    const data = buildElectiveRunExport({
      assignments: result.assignments, campers: parsed.campers, activities, occurrences, days, timeBlocks,
      runName: committedInfo?.runId ?? null,
    })
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'elective-assignments.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const liveRegion = <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>{announcement}</div>

  // H2 — a slot that could not be read for assignment (see the useMemo
  // above). Reported rather than crashing the host screen.
  if (deriveError) {
    return (
      <div style={{ marginTop: 24, ...enter }}>
        {liveRegion}
        <div style={S.emptyStateBody}>This set&apos;s placement on the schedule could not be read for assignment.</div>
      </div>
    )
  }

  // M1 — "place it on the grid first" was a dead end: no control here led
  // anywhere. onNavigate is the same callback ScheduleElectivesScreen already
  // receives and threads down through ElectiveSetDetail.
  if (candidateTemplateIds.length === 0) {
    return (
      <div style={{ marginTop: 24, ...enter }}>
        {liveRegion}
        <div style={emptyStyles.body}>This set isn&apos;t on a schedule yet.</div>
        <button className="press-97" onClick={() => onNavigate?.('schedule')} style={S.btnSecondary}>
          Go to Schedule
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 24 }}>
      {liveRegion}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xlsm,.xls,.txt"
        style={{ display: 'none' }}
        onChange={(e) => onFileSelected(e.target.files?.[0])}
      />

      {phase === 'empty' && (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <div style={emptyStyles.title}>No camper preferences yet</div>
          <div style={emptyStyles.body}>Import a preference sheet to assign campers into this set&apos;s offerings.</div>
          <button className="press-97" onClick={() => fileInputRef.current?.click()} style={S.btnSecondary}>
            Import Camper Preferences
          </button>
        </div>
      )}

      {phase === 'parsing' && <Busy label="Reading the file…" />}

      {phase === 'mapping' && (
        <MappingCorrector
          header={rows[0]}
          sampleRows={rows.slice(1, 4)}
          mapping={mapping}
          onChange={setMapping}
          onConfirm={confirmMapping}
          onChooseDifferentFile={reset}
        />
      )}

      {phase === 'parsed' && (
        candidateTemplateIds.length > 1 && !templateId ? (
          <div>
            <div style={S.label}>This set is placed on more than one schedule — choose which to assign against:</div>
            {candidateTemplateIds.map((id) => {
              const t = scheduleTemplates?.find((st) => st.id === id)
              const week = scheduleWeeks?.find((w) => w.id === t?.week_id)
              return (
                <button
                  key={id} className="press-97" style={{ ...S.btnSecondary, display: 'block', width: '100%', marginBottom: 6, textAlign: 'left' }}
                  onClick={() => chooseTemplateAndSolve(id)}
                >
                  {t?.name ?? id} · {t?.kind ?? 'schedule'} · {week?.name ?? 'All weeks'}
                </button>
              )
            })}
            <button className="press-97" onClick={reset} style={S.btnUtility}>Choose a Different File</button>
          </div>
        ) : (
          <ParseSummary
            parsed={parsed}
            contradictoryRanks={hasContradictoryRanks(parsed)}
            onSolve={() => chooseTemplateAndSolve(candidateTemplateIds[0])}
            onChooseDifferentFile={reset}
          />
        )
      )}

      {phase === 'solving' && <Busy label="Solving assignments…" />}

      {phase === 'preview' && result && (
        <AssignmentPreview
          assignments={result.assignments}
          findings={result.findings}
          occurrences={occurrences}
          days={days}
          timeBlocks={timeBlocks}
          tiers={tiers}
          activities={activities}
          campers={parsed.campers}
          role={role}
          onCommit={commit}
          committing={phase === 'committing'}
        />
      )}

      {phase === 'committing' && <Busy label="Committing…" />}

      {phase === 'committed' && committedInfo && (
        <div style={settleEnter}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, color: 'var(--success)', marginBottom: 6 }}>
            Assignments committed
          </div>
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            {committedInfo.camperCount} campers assigned across {committedInfo.occurrenceCount} occurrences.
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
            <button className="press-97" onClick={exportExcel} style={S.btnSecondary}>Export as Excel</button>
            <button className="press-97" onClick={exportJson} style={S.btnSecondary}>Export as JSON</button>
          </div>
          <button className="press-97" onClick={reset} style={S.btnUtility}>Assign Another Sheet</button>
        </div>
      )}
    </div>
  )
}
