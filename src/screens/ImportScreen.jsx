import { useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { parseTextGrid } from '../ingest/textGrid'
import { extractEntities, INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { buildPreview, describePreview } from '../ingest/preview'
import { describeWriteFailure } from '../utils/writeErrorMessage'

// Read last year's schedule and propose the camp's setup from it.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
//
// The shape of this screen IS the decision: read → propose → the director
// edits → commit. There is no path that skips the middle two, because
// everything here is inference and a wrong guess written silently into a
// camp's setup is the failure this feature must not have (ADR §1).
//
// So the proposal arrives with every row already checked, and every row
// unchecked-able. Approving is the director's act, not a formality.

const LABEL = {
  cohorts: 'Programs',
  tiers: 'Units',
  groups: 'Groups',
  days_of_operation: 'Days',
  time_blocks: 'Time Blocks',
  activities: 'Activities',
}

export default function ImportScreen({ onNavigate }) {
  const [fileName, setFileName] = useState(null)
  const [preview, setPreview] = useState(null)
  const [chosen, setChosen] = useState({})
  const [error, setError] = useState(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState(null)

  async function readFile(file) {
    setError(null)
    setResult(null)
    if (!file) return
    setFileName(file.name)
    try {
      const text = await file.text()
      const proposal = extractEntities(parseTextGrid(text))
      const existing = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        existing[entity] = await localClient.list(entity).catch(() => [])
      }
      const next = buildPreview(proposal, existing)
      setPreview(next)
      // Everything starts approved except values seen only once in the whole
      // document. On a 33-page bunk schedule a real activity recurs dozens of
      // times and a parse artifact appears once, so this is the difference
      // between a director unticking sixty rows and ticking two. Nothing is
      // hidden either way — the unticked rows are right there with their count.
      const initial = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        const { create, lowConfidence = [] } = next.perEntity[entity]
        const low = new Set(lowConfidence)
        initial[entity] = new Set(create.filter((n) => !low.has(n)))
      }
      setChosen(initial)
    } catch (err) {
      setPreview(null)
      setError(describeWriteFailure(err, 'That file could not be read.'))
    }
  }

  function toggle(entity, name) {
    setChosen(prev => {
      const set = new Set(prev[entity])
      if (set.has(name)) set.delete(name)
      else set.add(name)
      return { ...prev, [entity]: set }
    })
  }

  const approvedCount = Object.values(chosen).reduce((n, set) => n + set.size, 0)

  async function commit() {
    setWorking(true)
    setError(null)
    try {
      const approved = {}
      for (const entity of INGESTIBLE_ENTITIES) approved[entity] = [...(chosen[entity] ?? [])]
      const outcome = await localClient.ingestCommit(approved)
      setResult(outcome)
      setPreview(null)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can import a schedule.'
          : describeWriteFailure(err, 'Nothing was imported. Your camp is exactly as it was.')
      )
    } finally {
      setWorking(false)
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.6, color: 'var(--text-secondary)', maxWidth: '62ch' }}>
        Already have last year's schedule? Open it here and Shoresh will read the groups, days,
        periods and activities out of it. Nothing is added until you have looked at the list and
        said so.
      </p>

      {error && <div style={{ ...S.errorBanner, marginBottom: 16 }}>{error}</div>}

      {result && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderLeft: '3px solid var(--success)', borderRadius: 8, padding: '12px 14px',
          marginBottom: 16, fontSize: 13, lineHeight: 1.6,
        }}>
          <strong>Imported {result.total} {result.total === 1 ? 'record' : 'records'}.</strong>{' '}
          They are ordinary records now — edit or delete any of them from the setup screens, and
          anything you delete can be brought back from Trash.
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onNavigate('groups')} style={S.btnSecondary}>Go to Groups</button>
          </div>
        </div>
      )}

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '16px', marginBottom: 20,
      }}>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 8, color: 'var(--text)' }}>
          Choose the file
        </label>
        <input
          type="file"
          accept=".txt,.csv,.tsv"
          onChange={e => readFile(e.target.files?.[0])}
          style={{ fontSize: 13 }}
        />
        {fileName && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {fileName}
          </div>
        )}
      </div>

      {preview && (
        <>
          <div style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderLeft: `3px solid var(--${preview.isNoOp ? 'accent' : 'primary'})`,
            borderRadius: 8, padding: '12px 14px', marginBottom: 8, fontSize: 13, lineHeight: 1.6,
          }}>
            {describePreview(preview)}
          </div>

          {/* The orientation was detected, not known. Saying so lets a director
              catch a misread before it becomes their data (ADR §7). */}
          {preview.orientation && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
              {preview.orientation.confident
                ? `Read as one page per ${preview.orientation.pages === 'groups' ? 'group, with the days across the top' : 'day, with the groups across the top'}.`
                : 'Could not tell how this file is laid out, so some of the list below may be wrong. Worth checking closely.'}
            </div>
          )}

          {INGESTIBLE_ENTITIES.map(entity => {
            const { create, skip, lowConfidence = [] } = preview.perEntity[entity]
            if (create.length === 0 && skip.length === 0) return null
            return (
              <div key={entity} style={{ marginBottom: 20 }}>
                <div style={{
                  fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-secondary)', marginBottom: 8,
                }}>
                  {LABEL[entity]}
                </div>

                {lowConfidence.length > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.6 }}>
                    {lowConfidence.length} of these appeared only once in the file, so they are more
                    likely to be a misread than something your camp does. They are left unticked —
                    tick any that are real.
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {create.map(name => {
                    const on = chosen[entity]?.has(name)
                    const seen = preview.perEntity[entity].counts?.[name]
                    return (
                      <button
                        key={name}
                        title={seen ? `Found ${seen} ${seen === 1 ? 'time' : 'times'} in the file` : undefined}
                        onClick={() => toggle(entity, name)}
                        style={{
                          fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer',
                          fontFamily: 'inherit',
                          background: on ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : 'var(--bg)',
                          border: `1px solid ${on ? 'var(--success)' : 'var(--border)'}`,
                          color: on ? 'var(--text)' : 'var(--text-secondary)',
                          textDecoration: on ? 'none' : 'line-through',
                        }}
                      >
                        {on ? '✓ ' : ''}{name}
                        {seen > 1 && (
                          <span style={{ marginLeft: 6, opacity: 0.55, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                            ×{seen}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>

                {/* ADR §5 — a skip is silently partial unless it is named
                    before the confirm, with what it matched. */}
                {skip.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    Already in your camp, so they will be left alone:{' '}
                    {skip.map(s => s.name).join(', ')}.
                  </div>
                )}
              </div>
            )
          })}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 24, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <button
              onClick={commit}
              disabled={working || approvedCount === 0}
              style={{ ...S.btnPrimary, opacity: working || approvedCount === 0 ? 0.45 : 1 }}
            >
              {working ? 'Importing…' : `Add ${approvedCount} ${approvedCount === 1 ? 'record' : 'records'}`}
            </button>
            <button onClick={() => { setPreview(null); setFileName(null) }} disabled={working} style={S.btnSecondary}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}
