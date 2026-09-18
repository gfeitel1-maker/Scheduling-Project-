// T195 — the preference import screen. Admin-only (ADR D9): upload a sheet,
// map its columns to the CLOSED target enum (ALLOWED_MAPPING_TARGETS —
// mapping.js), preview the resolution, resolve every blocked row explicitly,
// then commit through the op log.
//
// No banners (feedback_no_banners_flags_instead) — every state that needs
// surfacing is a per-row flag in the blocked-row list, not chrome.
//
// FIXTURE DATA ONLY. There is no real preference sheet in this repo and no
// real camper data may be imported through this screen until the owner
// dates their acceptance of that — see the notice below the upload control.
import { useState } from 'react'
import { localClient } from '../localClient'
import { parsePreferenceSheet } from '../ingest/preferenceImport/parseSheet.js'
import { ALLOWED_MAPPING_TARGETS, validateMapping } from '../ingest/preferenceImport/mapping.js'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S } from '../styles/shared'

// Keyed off ALLOWED_MAPPING_TARGETS (mapping.js) so a picker can never label
// a target outside the closed enum — widening the enum is the only way to
// add a new pickable target, and it shows up here automatically.
const TARGET_LABELS = {
  displayName: 'Camper name',
  group: 'Group',
  externalId: 'External ID (optional)',
  choiceRank: 'Ranked choice',
}
for (const target of ALLOWED_MAPPING_TARGETS) {
  if (!(target in TARGET_LABELS)) TARGET_LABELS[target] = target
}

function emptyMapping() {
  return { displayName: null, group: null, externalId: null, noPreferenceValues: [], choices: [] }
}

function ColumnPicker({ headers, value, onChange, target }) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      style={S.input}
      aria-label={TARGET_LABELS[target] ?? target}
    >
      <option value="">— not mapped —</option>
      {headers.map((h, i) => (
        <option key={i} value={i}>
          {h}
        </option>
      ))}
    </select>
  )
}

function BlockedRow({ rowIndex, rowResult, onResolve, onExclude }) {
  const camper = rowResult.camper
  const candidates = camper.disambiguation?.candidates ?? []
  const [pick, setPick] = useState('')
  const [excludeReason, setExcludeReason] = useState('')

  return (
    <div style={{ ...S.card, marginBottom: 8, padding: 12 }}>
      <div style={{ fontWeight: 600 }}>Row {rowIndex + 1}</div>
      {camper.status === 'blocked' && (
        <div style={{ color: 'var(--danger, #b00020)' }}>{camper.reason}</div>
      )}
      {rowResult.rowErrors?.map((e, i) => (
        <div key={i} style={{ color: 'var(--danger, #b00020)' }}>
          {e.reason} (rank {e.rank})
        </div>
      ))}
      {camper.reason === 'AMBIGUOUS_SAME_GROUP' && candidates.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div>Which existing camper is this?</div>
          {candidates.map((c) => (
            <label key={c.camperId} style={{ display: 'block' }}>
              <input
                type="radio"
                name={`disambiguate-${rowIndex}`}
                checked={pick === c.camperId}
                onChange={() => setPick(c.camperId)}
              />{' '}
              Camper {c.camperId} (created {c.createdAt ?? 'unknown date'})
            </label>
          ))}
          <button
            type="button"
            style={S.btnSecondary}
            disabled={!pick}
            onClick={() => onResolve(rowIndex, pick)}
          >
            Use this camper
          </button>
        </div>
      )}
      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          style={S.input}
          placeholder="Reason for excluding this row"
          value={excludeReason}
          onChange={(e) => setExcludeReason(e.target.value)}
        />
        <button
          type="button"
          style={S.btnSecondary}
          disabled={!excludeReason.trim()}
          onClick={() => onExclude(rowIndex, excludeReason.trim())}
        >
          Exclude row
        </button>
      </div>
    </div>
  )
}

export default function PreferenceImportScreen({ campId, role, runId }) {
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [sourceFilename, setSourceFilename] = useState(null)
  const [sourceSha256, setSourceSha256] = useState(null)
  const [mapping, setMapping] = useState(emptyMapping())
  const [preview, setPreview] = useState(null)
  const [decisions, setDecisions] = useState({}) // rowIndex -> { camperId } | { excludeReason }
  const [error, setError] = useState(null)
  const [committing, setCommitting] = useState(false)
  const [committed, setCommitted] = useState(null)

  if (role !== 'admin') {
    return (
      <div style={S.screen}>
        <div style={S.pageTitle}>Import preferences</div>
        <div>Admin only.</div>
      </div>
    )
  }

  async function onFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    try {
      const buf = await file.arrayBuffer()
      const { headers: h, rows: r } = parsePreferenceSheet(buf)
      setHeaders(h)
      setRows(r)
      setSourceFilename(file.name)
      const digest = await crypto.subtle.digest('SHA-256', buf)
      setSourceSha256(Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''))
      setMapping(emptyMapping())
      setPreview(null)
      setDecisions({})
      setCommitted(null)
    } catch (err) {
      setError(describeWriteFailure(err))
    }
  }

  function addChoiceColumn() {
    setMapping((m) => ({
      ...m,
      choices: [...m.choices, { label: `Choice ${m.choices.length + 1}`, isLinked: false, memberColumns: [] }],
    }))
  }

  function updateChoice(i, patch) {
    setMapping((m) => ({
      ...m,
      choices: m.choices.map((c, idx) => (idx === i ? { ...c, ...patch } : c)),
    }))
  }

  async function runPreview() {
    setError(null)
    const { ok, errors } = validateMapping(mapping, headers)
    if (!ok) {
      setError(errors.join('; '))
      return
    }
    try {
      const result = await localClient.electiveImportPreview({
        camp_id: campId,
        run_id: runId,
        headers,
        rows,
        mapping,
        source_sha256: sourceSha256,
      })
      if (result?.duplicate) {
        setError(`This exact file was already imported as run ${result.existingRunId}.`)
        return
      }
      setPreview(result)
    } catch (err) {
      setError(describeWriteFailure(err))
    }
  }

  function resolveDisambiguation(rowIndex, camperId) {
    setDecisions((d) => ({ ...d, [rowIndex]: { camperId } }))
  }

  function excludeRow(rowIndex, reason) {
    setDecisions((d) => ({ ...d, [rowIndex]: { excludeReason: reason } }))
  }

  async function commit() {
    if (!preview) return
    setCommitting(true)
    setError(null)
    try {
      const rowResults = preview.rowResults.map((r) => {
        const decision = decisions[r.rowIndex]
        if (decision?.excludeReason) {
          return { ...r, camper: { status: 'blocked', reason: 'excluded_by_director', excludeReason: decision.excludeReason } }
        }
        if (decision?.camperId) {
          return { ...r, camper: { ...r.camper, status: 'offered', camperId: decision.camperId } }
        }
        return r
      })
      const result = await localClient.electiveImportCommit({
        camp_id: campId,
        run_id: runId,
        headers,
        rows,
        mapping,
        resolutions: { rowResults },
        source_filename: sourceFilename,
        source_sha256: sourceSha256,
        client_write_id: `pref-import-${sourceSha256}`,
      })
      if (!result?.committed) {
        setError(`Import could not be committed: ${result?.reason ?? 'unknown reason'}`)
      } else {
        setCommitted(result)
      }
    } catch (err) {
      setError(describeWriteFailure(err))
    } finally {
      setCommitting(false)
    }
  }

  const blockedRows = (preview?.rowResults ?? []).filter((r) => r.blocked && !decisions[r.rowIndex])

  return (
    <div style={S.screen}>
      <div style={S.pageTitle}>Import preferences</div>
      <div style={{ ...S.card, padding: 12, marginBottom: 12 }}>
        This path is for <strong>fixture data only</strong>, pending the owner's dated acceptance of
        real camper data.
      </div>

      <input type="file" accept=".csv,.tsv,.xlsx,.xls" onChange={onFile} />

      {error && <div style={{ color: 'var(--danger, #b00020)', marginTop: 8 }}>{error}</div>}

      {headers.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={S.sectionTitle}>Map columns</div>
          <label style={{ display: 'block', marginTop: 8 }}>
            {TARGET_LABELS.displayName}
            <ColumnPicker headers={headers} value={mapping.displayName} target="displayName" onChange={(v) => setMapping((m) => ({ ...m, displayName: v }))} />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            {TARGET_LABELS.group}
            <ColumnPicker headers={headers} value={mapping.group} target="group" onChange={(v) => setMapping((m) => ({ ...m, group: v }))} />
          </label>
          <label style={{ display: 'block', marginTop: 8 }}>
            {TARGET_LABELS.externalId}
            <ColumnPicker headers={headers} value={mapping.externalId} target="externalId" onChange={(v) => setMapping((m) => ({ ...m, externalId: v }))} />
          </label>

          <div style={{ marginTop: 12 }}>
            <div style={S.sectionTitle}>Ranked choices</div>
            {mapping.choices.map((choice, i) => (
              <div key={i} style={{ ...S.card, padding: 8, marginTop: 8 }}>
                <input
                  style={S.input}
                  value={choice.label}
                  onChange={(e) => updateChoice(i, { label: e.target.value })}
                />
                <label style={{ display: 'block', marginTop: 4 }}>
                  <input
                    type="checkbox"
                    checked={choice.isLinked}
                    onChange={(e) => updateChoice(i, { isLinked: e.target.checked })}
                  />{' '}
                  These columns are one linked choice (spans multiple periods)
                </label>
                <select
                  multiple
                  style={{ ...S.input, marginTop: 4 }}
                  value={choice.memberColumns.map(String)}
                  onChange={(e) =>
                    updateChoice(i, { memberColumns: Array.from(e.target.selectedOptions).map((o) => Number(o.value)) })
                  }
                >
                  {headers.map((h, hi) => (
                    <option key={hi} value={hi}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <button type="button" style={S.btnSecondary} onClick={addChoiceColumn}>
              Add ranked choice column
            </button>
          </div>

          <button type="button" style={{ ...S.btnPrimary, marginTop: 16 }} onClick={runPreview}>
            Preview
          </button>
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 16 }}>
          <div style={S.sectionTitle}>
            Preview: {preview.blockedCount} blocked, {preview.warnCount} need confirmation
          </div>

          {blockedRows.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={S.sectionTitle}>Rows needing a decision</div>
              {blockedRows.map((r) => (
                <BlockedRow
                  key={r.rowIndex}
                  rowIndex={r.rowIndex}
                  rowResult={r}
                  onResolve={resolveDisambiguation}
                  onExclude={excludeRow}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            style={{ ...S.btnPrimary, marginTop: 16 }}
            disabled={committing || blockedRows.length > 0}
            onClick={commit}
          >
            {committing ? 'Committing…' : 'Commit import'}
          </button>
        </div>
      )}

      {committed && (
        <div style={{ marginTop: 16 }}>
          Imported {committed.campersWritten} new camper(s) and {committed.preferencesWritten} preference(s).
        </div>
      )}
    </div>
  )
}
