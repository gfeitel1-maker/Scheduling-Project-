// T229 -- camper assignment inside the elective set builder. Mounted below
// ElectiveSetDetail's offerings table; not a new screen (docs/work/tickets/
// T229-elective-assignment-in-set-detail.md). Owns the phase state machine:
// empty | parsing | mapping | parsed | solving | preview | committing | committed.
//
// Parse/map/solve are pure and stay in the renderer (main.js's own comment
// says so); the only IPC is localClient.commitElectiveRun. Never
// window.shoresh directly.
import { useEffect, useMemo, useRef, useState } from 'react'
import { localClient } from '../../../localClient'
import { S, prefersReducedMotion, useEnterTransition } from '../../../styles/shared'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'
import { readWorkbookRows } from '../../../utils/exportSanitize.js'
import { detectWholeSheetGrid, inferPreferenceLayout, hasContradictoryRanks } from '../../../ingest/preferenceSheet.js'
import { residueIsDecision } from '../../../ingest/residueKinds.js'
import { importEventRunName } from '../../../ingest/importEventRunName.js'
import { recallColumnMapping, bindingFromMapping } from '../../../ingest/mappingSeedling.js'
import { proposeActivityMatch, resolutionMap, RESOLUTION } from '../../../ingest/labelResolutions.js'
import { journalEntriesFor } from '../../../ingest/decisionJournal.js'
import {
  buildPreferenceCatalog,
  readPreferenceSheet,
  selectPreferenceSheet,
  submissionKeyFromRows,
} from '../../../ingest/preferenceImport.js'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments.js'
import { SyncIcon } from '../../../components/icons/index.jsx'
import { deriveOccurrences } from './deriveOccurrences.js'
import { deriveChoices } from './deriveChoices.js'
import { buildOfferings, findMismatches, findBlankCapacities } from './buildOfferings.js'
import { resolvePreferenceCoordinates } from './resolvePreferenceCoordinates.js'
import { electiveChoiceLabelKey } from '../../../../electron/ops/electiveDerivedIds.js'
import { buildAttendance } from './buildAttendance.js'
import { exportElectiveRunExcel, buildElectiveRunExport } from './exportElectiveRun.js'
import MappingCorrector from './MappingCorrector.jsx'
import ParseSummary from './ParseSummary.jsx'
import AssignmentPreview from './AssignmentPreview.jsx'
import { A } from './assignmentStyles.js'
// T250 — the Draft/Final director UI for a PERSISTED run. Mounted here, not as
// a new sidebar screen, deliberately: this panel already sits under
// ElectiveSetDetail and so inherits its admin posture (the participant entities
// are absent from permissions.js's ENTITIES, so authorize() default-denies
// staff). A nav row would have meant re-implementing that gate.
import RunList from '../run/RunList.jsx'
import DraftRunView from '../run/DraftRunView.jsx'
import FinalRunView from '../run/FinalRunView.jsx'

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

// THE DECISIONS THIS PANEL PRESENTED, one per distinct LABEL rather than one per
// cell \u2014 the label is the unit of resolution, so forty rows naming "Quidditch" are
// one question, not forty. Pure, so the journal's view of what was asked is derived
// from the parse rather than from whatever the UI happened to render.
//
// TWO KINDS NOW (T298), and they are separate journal kinds rather than one, because
// the ANSWER SETS differ: an unknown label can be added or mapped, a packed cell can
// also be split. Collapsing them would make "split_packed" look available on a
// decision where it never was, and the journal's whole value is that a later slice
// can trust what it says was on offer.
const JOURNAL_KIND = {
  UNRESOLVED_CHOICE_LABEL: 'resolve_unknown_label',
  AMBIGUOUS_PACKED_CELL: 'resolve_packed_cell',
}

function presentedDecisions(parsed, activityNames) {
  const byLabel = new Map()
  for (const item of parsed?.residue ?? []) {
    if (!residueIsDecision(item.kind) || !item.label) continue
    const kind = JOURNAL_KIND[item.kind]
    if (!kind || byLabel.has(item.label)) continue
    byLabel.set(item.label, {
      id: `${kind}:${item.label}`,
      kind,
      entityName: item.label,
      // WHAT WE SUGGESTED, recorded alongside the question. Without this the
      // journal can say a director mapped a label but not whether they took our
      // proposal or overrode it \u2014 and "was the proposal right" is the first
      // question the deferred learning layer has to answer.
      proposal: proposeActivityMatch(item.label, activityNames)?.name ?? null,
    })
  }
  return [...byLabel.values()]
}

// Only the labels actually settled get an answer; every other presented decision
// falls through `journalEntriesFor` as UNANSWERED, which is the recording the
// journal exists for.
const JOURNAL_ACTION = {
  [RESOLUTION.ADD_ACTIVITY]: 'added_activity',
  [RESOLUTION.MAP_TO_EXISTING]: 'mapped_to_existing',
  [RESOLUTION.SPLIT_PACKED]: 'split_packed',
}

function answersFor(decisions, resolutions) {
  const byLabel = resolutionMap(resolutions)
  const answers = {}
  for (const d of decisions) {
    const settled = byLabel[d.entityName]
    if (!settled) continue
    answers[d.id] = {
      action: JOURNAL_ACTION[settled.action] ?? settled.action,
      activityName: settled.activityName ?? undefined,
    }
  }
  return answers
}

// Reads the raw header+rows out of an uploaded file. A preference sheet is a
// flat table (name/id/division/rank columns), not a day x time-block grid, so
// this deliberately does NOT reuse workbookToPages/parseGridSchedule (the
// host's runImport pipeline) — those parse SCHEDULE grids and would not fit a
// camper roster.
//
// ONE READER, shared with the CLI (T313). There used to be a second branch here
// that hand-split CSV and TSV on `/\t|,/` after a `.trim()`, and it was reading
// real files wrong: over the 32-file probe corpus SEVEN read differently from the
// CLI's, including the packed cell `"Archery, Ceramics, Woodworking"` that P09 and
// P10 exist to exercise — through this door it became THREE columns with literal
// quote characters in the activity labels, so the director was never offered the
// `split_packed` resolution. A hand-rolled delimited reader cannot do RFC4180
// quoting, and a preference sheet is exactly the document where a comma inside a
// cell carries meaning. It forked IDENTITY too: a provisional subject is keyed on
// the rows, so two readers of one file are two camper ids depending on the door.
// SheetJS sniffs CSV and TSV from the same buffer, so there is nothing the removed
// branch could read that this cannot.
//
// The size and row-count caps still apply, and now from ONE place: `readWorkbookRows`
// goes through `readWorkbookSafely`, which asserts the byte cap before the parser
// runs and the per-sheet row cap before any cell is walked — the same
// `maxRowsPerSheet` limit and the same message the hand-rolled check raised (M3).
//
// EVERY SHEET, and the one to read is chosen by `selectPreferenceSheet` — the same rule
// the CLI uses (T314). _Prior: this returned ~~`sheets[0].rows`~~, and a director whose
// table sat on tab 2 either imported nothing or, worse, had an offerings MENU on tab 1
// read as a camper's own planner: the import succeeded, minted a phantom unattributed
// camper named after the file, and never touched the real table. Owner ruling
// 2026-09-29: "a director who has two tabs on an import won't get their thing read.
// that is fucking absurd. and should be a fix."_
async function readSheetRows(file) {
  return readWorkbookRows(await file.arrayBuffer(), { type: 'array', byteLength: file.size })
}

export default function AssignmentPanel({
  electiveSetId, campId, setActivities, activities, groups, tiers, days, timeBlocks,
  // Mints an activity AND offers it in this set, returning the created activity.
  // ElectiveSetDetail's `createAndAddOffering` — the same path populateElectiveSet
  // uses, so a residue-resolved activity is indistinguishable from any other.
  onAddActivity,
  templateSlots, scheduleTemplates, scheduleWeeks, role, onError, onNavigate,
  // T301 slice 3 — this elective set's authored bundles (ElectiveSetDetail
  // loads them, same as templateSlots/scheduleTemplates above). Re-derived
  // fresh into run-scoped choices on EVERY solve via deriveChoices, below —
  // never read back from a stored run (ADR D10).
  bundles = [], bundlePeriods = [], bundleTiers = [],
}) {
  const [phase, setPhase] = useState('empty')
  const [rows, setRows] = useState(null)
  const [mapping, setMapping] = useState(null)
  // T312 — the id of the remembered binding this mapping came from, or null when
  // the mapping was inferred. Drives the "remembered" line on the corrector; a
  // director confirming a memory should know that is what they are confirming.
  const [recalledFromId, setRecalledFromId] = useState(null)
  const [sourceLabel, setSourceLabel] = useState(null)
  const [submissionKey, setSubmissionKey] = useState(null)
  const [arrivalId, setArrivalId] = useState(null)
  // T314 — the tabs this workbook has that were NOT read, as residue items. Held in state
  // for the same reason `rows` is: `confirmMapping` re-parses each time the director settles
  // a label, and a residue item that vanished on the second parse would be worse than one
  // never shown.
  const [unreadSheets, setUnreadSheets] = useState([])
  const [parsed, setParsed] = useState(null)
  const [templateId, setTemplateId] = useState(null)
  const [occurrences, setOccurrences] = useState([])
  const [runId, setRunId] = useState(null)
  const [result, setResult] = useState(null) // { assignments, findings }
  const [committedInfo, setCommittedInfo] = useState(null)
  const [announcement, setAnnouncement] = useState('')
  // T250 — a persisted run the director opened from the run list, viewed
  // independently of the import phase machine above (which it deliberately
  // does not disturb).
  const [viewRun, setViewRun] = useState(null)
  const [danglingFindings, setDanglingFindings] = useState([])
  // What this director settled on THIS parse \u2014 a list of
  // `{ label, action, activityName }` \u2014 and the label currently being acted on.
  // A LIST, not a set of labels: slice 1 only needed to know WHETHER a label was
  // resolved, and slice 2 needs to know HOW, because two of the three resolutions
  // feed the re-parse and the third does not.
  const [resolutions, setResolutions] = useState([])
  const [resolvingLabel, setResolvingLabel] = useState(null)
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

  // ONE DERIVATION of the camp's activity names, read by the picker, by the proposal
  // rule and by the journal's record of what we proposed. Three copies of this would
  // be three chances for the journal to record a proposal the director never saw.
  const activityNames = useMemo(
    () => (activities ?? []).map((a) => a?.name).filter(Boolean),
    [activities]
  )

  function reset() {
    setPhase('empty')
    setRows(null)
    // T314 — cleared with `rows`, because these describe the WORKBOOK that produced them:
    // a second import of a one-tab file would otherwise still report the first file's
    // unread tabs, which is a false residue about a workbook that no longer exists.
    setUnreadSheets([])
    setMapping(null)
    setParsed(null)
    setTemplateId(null)
    setOccurrences([])
    setRunId(null)
    setResult(null)
    setCommittedInfo(null)
    setViewRun(null)
    setDanglingFindings([])
    setResolutions([])
    setResolvingLabel(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function onFileSelected(file) {
    if (!file) return
    onError?.(null)
    setPhase('parsing')
    try {
      const fileSheets = await readSheetRows(file)
      if (!fileSheets || fileSheets.length === 0) {
        onError?.('No rows could be read out of that file.')
        setPhase('empty')
        return
      }
      // WHICH TAB holds the camper preferences, by the rule the CLI uses (T314). Chosen
      // rather than asked: a workbook's shape is the camp's data, not this app's model, so
      // handing the director a tab picker would hand them classification this code does.
      // The catalog goes in because an INVERTED MATRIX is recognisable only by matching
      // headers against the camp's own activities, so a tab cannot be classified without it.
      const selectionCatalog = buildPreferenceCatalog({ activities, groups, tiers })
      const selection = selectPreferenceSheet({ sheets: fileSheets, catalog: selectionCatalog })
      // Nothing readable on any tab still LANDS as a read that found nothing rather than a
      // refusal (ADR §14.1) — `confirmMapping` reports what could not be resolved. Falling
      // back to tab 1 keeps that message about a real sheet instead of an empty array.
      const fileRows = selection.selected?.sheet.rows ?? fileSheets[0]?.rows ?? []
      if (fileRows.length === 0) {
        onError?.('No rows could be read out of that file.')
        setPhase('empty')
        return
      }
      setRows(fileRows)
      setUnreadSheets(selection.unread)
      // WHAT IDENTIFIES A PROVISIONAL SUBJECT: the SUBMISSION, never the file name.
      // Keying on the name merged two real children whose planners were both
      // exported as `planner.csv`. The label is kept for the director to recognise;
      // the key is the content.
      const label = file.name.replace(/\.[^.]+$/, '')
      setSourceLabel(label)
      const key = submissionKeyFromRows(fileRows)
      setSubmissionKey(key)
      // T299 — WHICH IMPORT this is, the other half of a provisional subject's
      // identity. Minted once per file SELECTION rather than per parse, because
      // confirmMapping runs again each time the director settles a label and every
      // one of those re-parses must land on the same subject.
      //
      // A fresh id per selection is the point: two children handing in matching
      // planners are two selections and so two subjects, which is what stops one
      // camper row holding both their answers. The director is told they are
      // indistinguishable by content (the attention surface) and merges them by
      // naming both, if it turns out to be one child.
      const arrival = crypto.randomUUID()
      setArrivalId(arrival)
      // The mapping shown to the director is LOCATED, not assumed to be row 1, and
      // is resolved against the camp's own entities — so what they are asked to
      // confirm is what the transform will actually do. `inferPreferenceMapping`
      // on row 0 with no catalog was a different reading from the one that ran.
      const catalog = buildPreferenceCatalog({ activities, groups, tiers })
      const inferred = inferPreferenceLayout(fileRows, { catalog })

      // T312 — a mapping this camp has confirmed before arrives PRE-FILLED, and
      // the director still presses Confirm. It is re-proposed rather than
      // auto-applied on purpose: ADR 6.1's worst failure is a confirmed-WRONG
      // binding re-applying pre-confirmed with no residue and no unlearn path,
      // and that cannot arise if the binding never lands without a human looking
      // at it. The saving is real either way -- six dropdowns and two
      // "+ Add Rank Column" presses become a glance and one press -- and the
      // unlearn path is then free: the director changes what they see.
      //
      // A recall that fails for ANY reason is simply not offered. The list read
      // is wrapped because an unavailable seedling table must not fail an import
      // that is otherwise fine; the director maps by hand, as they did before.
      let recalled = null
      try {
        const seedlings = await localClient.list('camp_seedlings')
        recalled = recallColumnMapping(seedlings, fileRows[inferred.headerIndex] ?? [], inferred)
      } catch {
        recalled = null
      }
      setMapping(recalled ?? inferred)
      setRecalledFromId(recalled?.recalledFromId ?? null)
      // T305 — A SHEET THAT IS NOTHING BUT A PLANNER GRID HAS NOTHING TO CORRECT, so it
      // is not asked about. A child's own planner has no camper-name column and no rank
      // columns BY DESIGN (ADR §14.1a: the identity comes from the submission, and the
      // cells ARE the ranks), which is exactly the shape MappingCorrector's confirm gate
      // refuses — so the director met a permanently disabled button under advice ("add a
      // rank column") that would have broken the read. A refusal at the UI seam, which
      // §14.1a forbids: land the data and report the uncertainty.
      //
      // The four values are passed EXPLICITLY rather than read from state, for the same
      // reason `extraActivities` and `resolutionList` are below: none of the setters
      // above have landed in this render, so confirmMapping reading state here would
      // re-parse the PREVIOUS sheet — an empty one on the first import, which would look
      // like a clean no-op rather than a failure.
      if (detectWholeSheetGrid(fileRows, inferred)) {
        confirmMapping([], resolutions, {
          rows: fileRows, sourceLabel: label, submissionKey: key, arrivalId: arrival,
          unreadSheets: selection.unread,
          // No corrector was shown, so there is no director's answer to send — and
          // `mapping` state here is the PREVIOUS sheet's (T307).
          mapping: null,
        })
        return
      }
      setPhase('mapping')
    } catch (err) {
      onError?.(describeWriteFailure(err, 'Could not read that file.'))
      setPhase('empty')
    }
  }

  // THE THREE RESOLUTIONS. The director confirms; the app does not decide \u2014 each of
  // these runs only from an explicit press on a named label, and nothing is proposed
  // or applied on its own.
  //
  // All three end the same way, in `confirmMapping`, which RE-PARSES: residue was
  // computed against the old catalog and the old resolutions, the sheet's rows for
  // that label are still sitting unimported, and the whole point of every one of
  // these actions is that they stop being residue. Resolving is never a gate \u2014 Solve
  // Assignments is available before, during and after, and a failure leaves the parse
  // exactly as it was.
  //
  // ONLY THE FIRST WRITES ANYTHING. Adding an activity is a mutation and goes through
  // describeWriteFailure. Mapping and splitting mutate NOTHING: they are statements
  // about how to read this file, so they cost one re-parse and no database call at
  // all. That asymmetry is worth naming rather than hiding \u2014 a director who maps a
  // label has not changed their camp, they have corrected a spelling in a sheet.
  function settle(label, entry) {
    const next = [...resolutions.filter((r) => r.label !== label), entry]
    setResolutions(next)
    return next
  }

  async function resolveUnknownLabel(label) {
    if (!onAddActivity || resolvingLabel) return
    setResolvingLabel(label)
    try {
      const created = await onAddActivity(label)
      const next = settle(label, { label, action: RESOLUTION.ADD_ACTIVITY })
      confirmMapping(created ? [created] : [], next)
    } catch (err) {
      onError?.(describeWriteFailure(err, `Could not add \u201c${label}\u201d as an activity.`))
    } finally {
      setResolvingLabel(null)
    }
  }

  function mapLabelToActivity(label, activityName) {
    if (!activityName || resolvingLabel) return
    setResolvingLabel(label)
    try {
      confirmMapping([], settle(label, { label, action: RESOLUTION.MAP_TO_EXISTING, activityName }))
    } finally {
      setResolvingLabel(null)
    }
  }

  function splitPackedCell(label) {
    if (resolvingLabel) return
    setResolvingLabel(label)
    try {
      confirmMapping([], settle(label, { label, action: RESOLUTION.SPLIT_PACKED }))
    } finally {
      setResolvingLabel(null)
    }
  }

  // `extraActivities` is the activity a residue resolution JUST created. The
  // `activities` prop is refreshed by the parent and does not land in this render,
  // so the re-parse is handed the new row directly rather than waiting a tick and
  // hoping — a re-parse against a stale catalog would resolve nothing and look like
  // the resolution failed.
  // `resolutionList` defaults to the state value rather than to empty: this is also
  // called from the ordinary mapping-confirmation path, where nothing has been
  // settled yet and the state IS the answer. Passed explicitly by the three settle
  // paths above because `setResolutions` has not landed in this render yet \u2014 reading
  // state there would re-parse against the resolutions as they were BEFORE the
  // director's press, which is the same stale-catalog trap `extraActivities` exists
  // to avoid, one field over.
  // `sheet` defaults to the state values, and is passed explicitly by the direct-to-parse
  // path in onFileSelected, where no setter has landed yet (T305).
  // T312 — remember what the director just confirmed, so the next sheet from
  // this form arrives pre-filled. BEST-EFFORT BY DESIGN and not awaited: the
  // import has already succeeded by the time this runs, and a camp that fails to
  // remember is in exactly the state every camp was in before this shipped. It
  // is deliberately NOT wired into describeWriteFailure for that reason -- a
  // modal about a memo would be a worse outcome than the memo not being kept.
  function rememberMapping() {
    try {
      const binding = bindingFromMapping(mapping, rows[mapping?.headerIndex ?? 0] ?? rows[0] ?? [])
      if (!binding) return
      // The CALL is inside the try, not just the promise: a synchronous throw
      // here -- an absent IPC method on an older preload, say -- would otherwise
      // escape a `.catch()` that only ever sees rejections, and take the
      // director's Confirm press down with it.
      Promise.resolve(localClient.rememberColumnMapping(binding)).catch(() => {})
    } catch {
      // Not remembered. That is the state every camp was in before this shipped,
      // and it is not worth interrupting a completed import to say so.
    }
  }

  function confirmMapping(extraActivities = [], resolutionList = resolutions, sheet = {}) {
    const {
      rows: sheetRows = rows,
      sourceLabel: sheetLabel = sourceLabel,
      submissionKey: sheetKey = submissionKey,
      arrivalId: sheetArrival = arrivalId,
      // T307 — the mapping the director is looking at, which from here on is the one
      // the transform uses. The grid path below passes null deliberately: it never
      // showed a corrector, so there is no director's answer to honour and the
      // transform locates the layout itself.
      mapping: sheetMapping = mapping,
      // T314 — the tabs this workbook had that were not read. Merged into the residue the
      // director reads, alongside everything else the import wants to tell them.
      unreadSheets: sheetUnread = unreadSheets,
    } = sheet
    // THE SAME CALL SHAPE THE CLI AND THE MCP TOOLS USE. This used to be
    // `parsePreferenceSheet(rows, { campId, mapping })` — no catalog, no grid, no
    // subject — so in the director's own import path the header locator never ran,
    // every resolver abstained for want of a catalog, and the planner-grid path was
    // unreachable. Every number this program measured described the CLI and not the
    // product. ADR section 3.2: a second call shape is a second T224, because the
    // arguments are where the behaviour lives.
    const catalog = buildPreferenceCatalog({ activities: [...activities, ...extraActivities], groups, tiers })
    let result
    try {
      // The transform is pure but not incapable of throwing — a derived id's
      // `opaque()` guard rejects a malformed component rather than encoding it, and
      // that surfaces here. An unhandled throw would leave the panel stuck in
      // 'mapping' with no explanation, which is the silent failure the
      // describeWriteFailure rule exists to prevent.
      result = readPreferenceSheet({
        rows: sheetRows,
        campId,
        catalog,
        mapping: sheetMapping,
        sourceLabel: sheetLabel,
        submissionKey: sheetKey,
        arrivalId: sheetArrival,
        resolutions: resolutionMap(resolutionList),
      }).parsed
    } catch (err) {
      onError?.(describeWriteFailure(err, 'Could not read that sheet.'))
      setPhase('mapping')
      return
    }
    if (!result) {
      onError?.(
        'That file does not read as a camper preference sheet — no camper-name column and no ' +
        'day/period grid. Nothing was changed.'
      )
      setPhase('mapping')
      return
    }
    // THE TABS THIS WORKBOOK HAD THAT WERE NOT READ, merged in here rather than inside the
    // pure module, which takes ONE sheet's rows and cannot know a second tab existed — the
    // same reason `scripts/preferenceSheetCli.js` merges them in `finishRun` (T314). Prepended
    // so the workbook-level fact reads before the row-level ones, as on the CLI.
    setParsed(sheetUnread.length > 0 ? { ...result, residue: [...sheetUnread, ...result.residue] } : result)
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
    // The chosen id is passed EXPLICITLY rather than read from state: setTemplateId
    // above has not applied by the time solve's timeout runs, so resolution would
    // otherwise name the PREVIOUS template in its residue. `newRunId` for the
    // same reason — `setRunId` above has not applied either, and deriveChoices
    // inside solve() must key its choice ids off the SAME runId the occurrence
    // ids above were just derived against.
    solve(occs, [], chosenTemplateId, null, [], newRunId)
  }

  // T297 — `runPreferences`/`runChoices` re-solve from the run's OWN stored rows
  // instead of the parsed sheet. Both null/empty on every other path, where
  // `parsed.preferences` is the only truth there is (nothing is committed yet on
  // a first solve). This is what makes an edit take effect: a director who
  // corrects a preference and re-solves must not get a solve built from the file
  // they did not re-import.
  //
  // `solveRunId` defaults to the `runId` state value, which is current for
  // regenerate() (called on a later render, after setRunId has long since
  // applied) but NOT for chooseTemplateAndSolve()'s first solve — that call
  // site passes its own `newRunId` explicitly, for the same reason it already
  // passes `chosenTemplateId` explicitly rather than trusting state (see its
  // own comment): the occurrence ids `occs` were just derived against that
  // exact runId, and deriveChoices below must key its choice ids off the
  // same one or a re-solve would silently mint different bundle choice ids
  // than the ones this run already committed.
  function solve(occs, lockedAssignments = [], chosenTemplateId = null, runPreferences = null, runChoices = [], solveRunId = runId) {
    setPhase('solving')
    // Deliberately async-shaped so the busy phase actually paints before the
    // (synchronous, potentially heavy) solve runs.
    setTimeout(() => {
      const offerings = buildOfferings({ occurrences: occs, setActivities, activities })
      // T316 — a confirmed offering declared 'limited' with a blank capacity
      // (`resolveOfferingCapacity`'s `unknownLimit`) is blocking: the run
      // refuses to solve while one exists, rather than reaching the engine
      // as capacity 0. Owner ruling 2026-09-29: "blank capacities need to be
      // filled in." Checked before deriveChoices/buildElectiveAssignments
      // run at all — nothing past this point executes on a blocked run.
      const blankCapacityFindings = findBlankCapacities({ setActivities, activities })
      if (blankCapacityFindings.length > 0) {
        setResult({ assignments: [], findings: blankCapacityFindings, choices: [] })
        setPhase('preview')
        setAnnouncement('Some offerings have a blank capacity and must be fixed before this run can be solved.')
        return
      }
      // T301 slice 3 (ADR D10) — a director's authored bundles, expanded into
      // THIS run's per-tier linked choices, called fresh on EVERY solve
      // (first or re-solve) — never read back from a stored run, because a
      // bundle's CURRENT definition must govern, not a stale snapshot from
      // whenever it was last solved. Independent of the sheet-derived
      // `choices` below, which only ever come from a re-solve's own stored
      // rows; a bundle exists at the elective-set level, outside any one run.
      const bundleDerivation = deriveChoices({
        bundles, bundlePeriods, bundleTiers, occurrences: occs, runId: solveRunId,
      })
      // RESOLVER 5's SECOND HALF, and THIS IS THE SEAM IT BELONGS AT (ADR §13.2:
      // resolution is solve-time and template-scoped, because the coordinate set
      // is per-template and the two candidate routes may bind one coordinate
      // differently — neither is canonical).
      //
      // Without this call the coordinate columns had NO READERS at all: a
      // per-cell sheet reached the engine with `occurrence_id` absent on every
      // row, every cell collapsed onto the engine's single whole-run scalar, and
      // campers were placed in activities they had not chosen for that cell while
      // `preference_rank` reported a first choice that was not honoured. A
      // confident wrong answer, where before the branch the sheet had simply been
      // refused.
      //
      // Nothing is written back: the stored rows keep their coordinates, and the
      // resolved occurrence lives only for this solve against this template.
      const resolvedPreferences = resolvePreferenceCoordinates({
        preferences: runPreferences ?? parsed.preferences,
        occurrences: occs,
        days,
        timeBlocks,
        templateId: chosenTemplateId ?? templateId,
      })
      // H4 — occurrences are tier-scoped but campers are not; without this a
      // set placed on both a Juniors cell and a Seniors cell at the same
      // day/block seats the SAME campers in both. attendance is null (skip
      // matching) when occurrences span at most one tier -- the common case,
      // where there is nothing to disambiguate.
      const { attendance, unmatched, ambiguous } = buildAttendance({ campers: parsed.campers, occurrences: occs, tiers })
      const { assignments, findings } = buildElectiveAssignments({
        campers: parsed.campers, occurrences: occs, offerings, preferences: resolvedPreferences.preferences, attendance,
        // T250/T246 — seats the director locked by hand on the Draft screen.
        // Empty on a first solve; non-empty only on a regenerate, which is the
        // only path that has a persisted run to read locks from.
        lockedAssignments,
        // T297 — THE RUN'S CHOICES, and only on a re-solve from stored rows.
        //
        // A stored preference names `choice_id` and nothing else; the engine's
        // ranks and buildOfferings' offerings are both keyed by `labelKey`. The
        // engine resolves a choice_id perfectly well — but ONLY when handed
        // `choices` (its own note says nothing in production passes them yet).
        // Without this, every stored row resolves to no choice and no labelKey,
        // the preference loop records no rank at all, and the solve fills the
        // week with fallbacks while reporting nothing wrong. A confident wrong
        // answer, not a visible failure.
        //
        // `labelKey` is `electiveChoiceLabelKey(choice.label)` — the same
        // function buildOfferings applies to the ACTIVITY name, so a choice and
        // the offering it refers to meet. Empty on the parsed path (those
        // preferences already carry labelKey and there is no persisted run yet
        // to read a sheet-derived choice back from).
        //
        // T301 slice 3 — UNIONED with `bundleDerivation.choices`, which is
        // populated on BOTH paths (feeding the engine's linked-choice tier is
        // now the whole point — a bundle exists independent of any run, so it
        // has nothing to do with which path this solve is). `choiceOfferings`
        // comes ONLY from the fresh derivation: nothing persists a sheet-
        // derived choice's member occurrences (there are none — a plain
        // choice is never linked), and getElectiveRunHandler does not read
        // elective_choice_offerings back at all.
        choices: [
          ...bundleDerivation.choices,
          ...runChoices.map((c) => ({
            id: c.id, labelKey: electiveChoiceLabelKey(c.label), is_linked: c.is_linked ?? 0,
          })),
        ],
        choiceOfferings: bundleDerivation.choiceOfferings,
      })
      // DELIBERATELY `parsed.preferences`, even on a re-solve from the database.
      // findMismatches keys on `labelKey` and on `label` for its wording, and it
      // reports about THE FILE ("was ranked by campers but does not match any
      // offered activity") — a sentence about the sheet the director imported.
      // It is not an oversight that the re-solve's own rows are not used here.
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
      // A coordinate that bound to NOTHING is the director's business, not a
      // silent drop: either the sheet names a day or period this camp does not
      // have (provably wrong, ADR §11.2's domain check), or it names a real cell
      // that THIS schedule puts no elective in — and the other candidate route
      // may well have it, which is why the residue names the template.
      const coordinateFindings = resolvedPreferences.residue
      setResult({
        assignments,
        findings: [
          ...findings, ...mismatchFindings, ...attendanceFindings, ...ambiguousFindings,
          ...coordinateFindings,
        ],
        // T301 slice 3 — so AssignmentPreview can name a bundle by its real
        // name in an UNSUPPORTED_LINKED_CHOICE finding (T300's
        // findingDisplayMessage) instead of the raw labelKey the engine's own
        // message quotes.
        choices: bundleDerivation.choices,
      })
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
      // Computed before the call, not inline: test/perCellSolvePlacement.test.js reads
      // this payload up to its first `})`, so an inline call would hide `parsed,` from it.
      const name = importEventRunName({ at: new Date(), sheetCount: parsed?.campers?.length ?? 0 })
      const out = await localClient.commitElectiveRun({
        // T319 — the shared import-event name, not a bare date. `sheetCount` is
        // how many campers THIS parsed sheet read, the same fact the CLI door
        // derives from its own `parsed`.
        //
        // Red Hat round 2, LOW — WHY commitElectiveRun's first-name-wins guard
        // is correct for a re-commit from THIS panel, stated once rather than
        // left to infer from three separate places: the file `<input>` that
        // sets `parsed` only renders in `phase === 'empty'`; `reset()` nulls
        // `parsed` and `runId` together; and `chooseTemplateAndSolve` always
        // mints a FRESH `runId`. So the only way this panel re-commits onto an
        // EXISTING `runId` is `regenerate()`, which re-solves against the SAME
        // `parsed` already on the run — the suppressed name would have been
        // identical anyway. If a future affordance ever let a director swap
        // the source file without losing the template (keeping `runId` but
        // replacing `parsed`), that invariant breaks: the run would keep this
        // stale name and stale sheet count permanently, since the guard this
        // payload feeds never re-asserts them on an existing row.
        name,
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
      // T173's journal — what the importer ASKED about this sheet's unknown labels
      // and what the director did, INCLUDING the ones left alone. An unresolved
      // label costs nothing and is the default, so the unanswered entries are the
      // ones a later learning slice needs most: a question nobody ever answers is a
      // question not worth asking. Best-effort and never blocking, the same posture
      // as ReconciliationScreen's call — a committed run must stay committed.
      try {
        const presented = presentedDecisions(parsed, activityNames)
        const entries = journalEntriesFor(presented, answersFor(presented, resolutions), crypto.randomUUID())
        if (entries.length > 0) await localClient.recordImportDecisions({ entries })
      } catch {
        /* diagnostics only — never surfaced, never blocking */
      }
      setDanglingFindings(out.findings ?? [])
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

  // T250 — a regenerate offered on the Draft screen when some of the run's
  // placements came from an earlier version of the schedule. Re-solves in
  // place, carrying the director's locked seats through, and lands back on the
  // preview so they commit the new solve deliberately. Only offered when this
  // session still holds the parsed sheet (a run opened cold from the list has
  // no sheet in memory to re-solve from).
  // T297 — `preferences`/`choices` are the RUN's own stored rows, passed up by
  // DraftRunView after a preference edit. See solve()'s `choices` note for why
  // both halves have to travel together.
  function regenerate({ lockedAssignments, preferences: runPreferences = null, choices: runChoices = [] }) {
    setViewRun(null)
    solve(occurrences, lockedAssignments, null, runPreferences, runChoices)
  }

  // Q1/Q2: a finalized run is immutable and there is no reopen. With today's
  // IPC the honest minimal behaviour is to put the director back at the import
  // flow, which mints a fresh runId on the next solve — a NEW run, never this
  // one reopened.
  function startRevision() {
    reset()
  }

  // T296 renamed `occurrences` -> `templateOccurrences` on the way into the run
  // views. It is NOT the run's occurrence set: it is derived from the CURRENT
  // template by chooseTemplateAndSolve and is therefore empty for a run opened
  // from the run list. The run's own set now comes from getElectiveRun
  // (useRunState().occurrences). The two were one unqualified name, and every
  // consumer that wanted the run's set silently got whichever this happened to
  // hold — the name says which is which now.
  const runViewCatalogs = {
    activities, days, timeBlocks, groups, tiers,
    templateOccurrences: occurrences,
    scheduleTemplates, scheduleWeeks,
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
        // `.csv` and `.tsv` were MISSING while `readSheetRows` could always read
        // them and the CLI reads them happily — so a camp exporting CSV, which the
        // probe corpus says is the common case, could not select their own file in
        // the app at all. Found by driving the real picker rather than by reading
        // the code. _Prior: readSheetRows had a separate ~~delimited branch~~ for
        // these; T313 removed it, and SheetJS sniffs both from the same buffer._
        accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt"
        style={{ display: 'none' }}
        onChange={(e) => onFileSelected(e.target.files?.[0])}
      />

      {viewRun ? (
        viewRun.status === 'final' ? (
          <FinalRunView
            run={viewRun}
            campers={parsed?.campers ?? []}
            onStartRevision={startRevision}
            onBack={() => setViewRun(null)}
            {...runViewCatalogs}
          />
        ) : (
          <DraftRunView
            run={viewRun}
            /* KNOWN GAP, not an oversight: danglingFindings are SESSION-SCOPED.
               commitElectiveRun returns them, this panel holds them in React
               state, and a run reopened in a later session therefore always
               gets []. A genuinely dangling row is invisible until the next
               regenerate, with no path to show it.

               It cannot be derived durably today. commitElectiveRun computes
               DANGLING_MANUAL_ASSIGNMENT against the occurrence set the
               RENDERER just derived for this generation, and the persisted
               `elective_occurrences` rows are NOT the same set: nothing in
               electron/ ever deletes one, so the table accumulates the union of
               every generation's occurrences. An occurrence a template edit
               removed — precisely the case that makes a manual row dangle —
               is still sitting in `elective_occurrences`, so a DB-derived check
               in getElectiveRunHandler would find it present and report a clean
               run. That is a false all-clear, which is worse than this silence.
               Pruning `elective_occurrences` is the prerequisite; it is not
               T250's to do. */
            danglingFindings={viewRun.id === committedInfo?.runId ? danglingFindings : []}
            onRegenerate={parsed && viewRun.id === committedInfo?.runId ? regenerate : undefined}
            onBack={() => setViewRun(null)}
            {...runViewCatalogs}
          />
        )
      ) : (<>

      {phase === 'empty' && (
        <div style={{ ...emptyStyles.wrap, ...enter }}>
          <div style={emptyStyles.title}>No camper preferences yet</div>
          <div style={emptyStyles.body}>Import a preference sheet to assign campers into this set&apos;s offerings.</div>
          <button className="press-97" onClick={() => fileInputRef.current?.click()} style={S.btnSecondary}>
            Import Camper Preferences
          </button>
          <div style={{ marginTop: 20, textAlign: 'left' }}><RunList onOpen={setViewRun} /></div>
        </div>
      )}

      {phase === 'parsing' && <Busy label="Reading the file…" />}

      {phase === 'mapping' && (
        // THE LOCATED HEADER, not row 0. The locator can put the table at row 3
        // (a title and a season line above it are ordinary), and feeding row 0
        // here showed the director a corrector whose column options were the
        // TITLE's cells — so every rank read "Not mapped" even though the
        // transform had mapped them correctly, and any "correction" they made
        // would have broken a working read. Found by driving the real picker in
        // the browser, not by reading the code.
        <MappingCorrector
          recalled={recalledFromId != null}
          header={rows[mapping?.headerIndex ?? 0] ?? rows[0]}
          sampleRows={rows.slice((mapping?.headerIndex ?? 0) + 1, (mapping?.headerIndex ?? 0) + 4)}
          mapping={mapping}
          onChange={setMapping}
          // Wrapped, NOT passed by reference: MappingCorrector's onConfirm is a click
          // handler, so a bare reference hands the click EVENT to `extraActivities`.
          onConfirm={() => { rememberMapping(); confirmMapping() }}
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
            onAddActivity={onAddActivity ? resolveUnknownLabel : undefined}
            onMapToActivity={mapLabelToActivity}
            onSplitPacked={splitPackedCell}
            activityNames={activityNames}
            resolutions={resolutionMap(resolutions)}
            busyLabel={resolvingLabel}
          />
        )
      )}

      {phase === 'solving' && <Busy label="Solving assignments…" />}

      {phase === 'preview' && result && (
        <AssignmentPreview
          assignments={result.assignments}
          findings={result.findings}
          choices={result.choices}
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
          <div style={{ marginTop: 20 }}><RunList onOpen={setViewRun} /></div>
        </div>
      )}
      </>)}
    </div>
  )
}
