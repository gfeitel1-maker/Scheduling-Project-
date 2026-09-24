// T229 -- camper assignment inside the elective set builder. Mounted below
// ElectiveSetDetail's offerings table; not a new screen (docs/work/tickets/
// T229-elective-assignment-in-set-detail.md). Owns the phase state machine:
// empty | parsing | mapping | parsed | solving | preview | committing | committed.
//
// Parse/map/solve are pure and stay in the renderer (main.js's own comment
// says so); the only IPC is localClient.commitElectiveRun. Never
// window.shoresh directly.
import { useEffect, useMemo, useRef, useState } from 'react'
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

// T249 / ADR 2026-09-23 decision (e) -- the D8 at-rest-encryption release gate,
// stated in the product rather than promised in a document.
//
// THE RULING THIS IMPLEMENTS (owner, 2026-09-23, Q4): the elective slices are
// built now against FABRICATED fixtures, and real camper data stays refused at
// a visible, tested gate until at-rest encryption ships and defaults on. So
// this row is not decoration and not a banner (the standing "no banners" rule
// is about dismissible chrome): it is a permanent disclosure row, rendered in
// every phase of this panel, with no dismiss control, using the codebase's
// existing caution primitive (S.cautionBanner, DESIGN_STANDARD §4).
//
// THREE PROPERTIES THE TEST PINS, because each one is a way this could rot back
// into a promise:
//   1. It renders whenever encryption is NOT active -- not once, not only on
//      the first render, and in every phase the panel can reach.
//   2. It cannot be dismissed. There is no control inside it, by construction.
//   3. It FAILS CLOSED. A status read that throws, or that comes back without a
//      literal `true`, is not evidence that anything is encrypted -- it is an
//      unknown, and an unknown must read as "not encrypted", never as silence.
//      That is the difference between a gate and a decoration: the only thing
//      that removes this warning is an affirmative `atRestEncryptionEnabled ===
//      true` from the same resolution the ciphers themselves use
//      (electron/db/atRestEncryption.js).
const ENCRYPTION_DISCLOSURE =
  'Camper data in this feature is not yet encrypted at rest. Do not use real camper names until this is enabled.'

// The `true` branch. The ADR allows either nothing or "a neutral confirmation"
// here, and nothing would be an over-claim: `atRestEncryptionEnabled` is one
// device's flag, and it is NOT the same statement as "this camper's name is
// encrypted on disk everywhere". Two gaps survive the flip, both real today:
// bytes written before the flag was turned on (the migration is T175/T179's
// job, still open), and a PEER syncing this camp with the flag off, whose copy
// of the same document is plaintext on ITS disk. So the row stays, in a neutral
// treatment, and says what the flag actually licenses.
const ENCRYPTION_CONFIRMATION =
  'At-rest encryption is on for this device. It does not cover data written before it was enabled, or a peer device syncing this camp with it off.'

function useAtRestEncryptionStatus() {
  // 'checking' is a real, rendered state (DESIGN_STANDARD §5b): the read is an
  // async IPC call, and a disclosure that is silently absent while it resolves
  // is absent exactly when a director first looks at the screen.
  const [state, setState] = useState({ status: 'checking', detail: null })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const out = await localClient.getSecurityStatus()
        if (cancelled) return
        setState({ status: out?.atRestEncryptionEnabled === true ? 'encrypted' : 'unencrypted', detail: null })
      } catch (err) {
        if (cancelled) return
        // Fail closed, and say why -- a swallowed read failure is the exact
        // shape this repo forbids (describeWriteFailure, standing rule).
        setState({
          status: 'unencrypted',
          detail: describeWriteFailure(err, 'This device’s encryption status could not be read.'),
        })
      }
    })()
    return () => { cancelled = true }
  }, [])
  return state
}

const disclosureStyles = {
  // Shared by the 'checking' and 'encrypted' states: both are informational,
  // neither is a caution, so neither takes the bronze caution fill.
  neutral: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 13,
    color: 'var(--text-secondary)',
    transition: 'opacity var(--motion-fast) var(--ease-out)',
  },
  detail: { marginTop: 4, fontSize: 12, opacity: 0.85 },
}

function EncryptionDisclosure() {
  const { status, detail } = useAtRestEncryptionStatus()
  if (status === 'encrypted') {
    return (
      <div data-testid="encryption-disclosure" data-encryption-state="encrypted" role="note" style={disclosureStyles.neutral}>
        {ENCRYPTION_CONFIRMATION}
      </div>
    )
  }
  if (status === 'checking') {
    return (
      <div data-testid="encryption-disclosure" data-encryption-state="checking" role="status" style={disclosureStyles.neutral}>
        Checking whether camper data is encrypted at rest on this device…
      </div>
    )
  }
  // No dismiss affordance, deliberately. Nothing in here is a control.
  return (
    <div data-testid="encryption-disclosure" data-encryption-state="unencrypted" role="note" style={S.cautionBanner}>
      {ENCRYPTION_DISCLOSURE}
      {detail ? <div style={disclosureStyles.detail}>{detail}</div> : null}
    </div>
  )
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
      const { attendance, unmatched, ambiguous } = buildAttendance({ campers: parsed.campers, occurrences: occs, tiers })
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
      // T255 Slice B — a division name that matches MORE THAN ONE tier on this
      // schedule (two divisions sharing a name, permitted since schema v73).
      // Unlike an unmatched name, this is not a spelling to fix on the sheet —
      // it is two same-named divisions in the camp's own setup — so there is
      // no suggestion, only the same never-unplaced fallback already applied.
      const ambiguousFindings = (ambiguous ?? []).map((a) => ({
        kind: 'AMBIGUOUS_DIVISION',
        division: a.division,
        message: `${a.camperCount} camper(s) list the division “${a.division}”, which matches more than one division on this schedule — rename one of them to tell them apart. They were considered for every occurrence.`,
      }))
      setResult({ assignments, findings: [...findings, ...mismatchFindings, ...attendanceFindings, ...ambiguousFindings] })
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
        <EncryptionDisclosure />
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
        <EncryptionDisclosure />
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
      {/* Outside every phase branch on purpose: this must not be reachable only
          from one state, and must not unmount as the director moves through
          import -> mapping -> preview -> committed. */}
      <EncryptionDisclosure />
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
