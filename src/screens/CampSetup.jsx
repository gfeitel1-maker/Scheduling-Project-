import { useState, useEffect } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { getSetupGaps, describeSetupGaps, OPTIONAL_AREAS } from '../engine/readiness'

// The rows a director walks, in the order they walk them. Which of these BLOCK
// building a week is not decided here — src/engine/readiness.js owns that, and
// this screen reads it. Before that split, this list was the de-facto required
// set and was wrong twice over: it counted Fixed Events, which is optional, and
// omitted Days and Programs, which are not.
const STEPS = [
  {
    key: 'cohorts',
    label: 'Programs',
    screen: 'cohorts',
    table: 'cohorts',
    desc: 'A session or division of camp with its own schedule — Session A, Machaneh Kayitz.',
  },
  {
    key: 'tiers',
    label: 'Units',
    screen: 'tiers',
    table: 'tiers',
    desc: 'Age divisions with their own schedule — Yeladim, Bonim, Edah Aleph, etc.',
  },
  {
    key: 'groups',
    label: 'Groups',
    screen: 'groups',
    table: 'groups',
    desc: 'Individual bunks or tzrifim within each unit — Tzrif Aleph, Bunk 4, etc.',
  },
  {
    key: 'days',
    label: 'Days',
    screen: 'days',
    table: 'days_of_operation',
    desc: 'Which days of the week camp runs — Sunday through Friday, or whatever your week is.',
  },
  {
    key: 'timeblocks',
    label: 'Time Blocks',
    screen: 'timeblocks',
    table: 'time_blocks',
    desc: 'Named periods in the daily timetable — Morning Activity, Free Swim, Menucha.',
  },
  {
    key: 'activities',
    label: 'Activities',
    screen: 'activities',
    table: 'activities',
    desc: 'What groups do during free blocks — archery, swimming, ceramics, peulot.',
  },
  {
    key: 'anchors',
    label: 'Fixed Events',
    screen: 'anchors',
    table: 'anchor_activities',
    desc: 'Events that happen at the same time every day — Aruchat Boker, Tefillah, Flagpole.',
  },
]

export default function CampSetup({ campId, onNavigate }) {
  const [campName, setCampName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [saving, setSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [counts, setCounts] = useState({})
  const [loadingCounts, setLoadingCounts] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => { loadCamp(); loadCounts() }, [campId])

  async function loadCamp() {
    try {
      const camp = await localClient.getCamp()
      if (camp) {
        setCampName(camp.name)
        setSavedName(camp.name)
      } else {
        // A zero-camp-row state is an error state (bootstrap should have
        // created the single camps row), not a legitimate blank name field
        // to silently let the director type into.
        setError('No camp found — refresh the app')
      }
    } catch {
      setError('Failed to load camp — check your connection and refresh')
    }
  }

  async function loadCounts() {
    setLoadingCounts(true)
    setError(null)
    try {
      // Round-2 fix: Promise.all meant ONE failing list() call blanked out
      // ALL counts, even if the other four succeeded. Promise.allSettled
      // preserves the previously-known count for any step that failed this
      // round, while still surfacing an error banner so the director knows
      // something is degraded.
      const results = await Promise.allSettled(STEPS.map(s => localClient.list(s.table)))
      let anyFailed = false
      setCounts(prev => {
        const map = { ...prev }
        results.forEach((r, i) => {
          const key = STEPS[i].key
          if (r.status === 'fulfilled') {
            map[key] = (r.value || []).length
          } else {
            anyFailed = true
            map[key] = prev[key] || 0
          }
        })
        return map
      })
      if (anyFailed) {
        setError("Some sections couldn't be loaded just now — your saved data is safe. The counts below may be out of date.")
      }
    } catch {
      setError('Failed to load — check your connection and refresh')
    } finally {
      setLoadingCounts(false)
    }
  }

  async function saveName() {
    if (!campName.trim() || campName === savedName) return
    if (!campId) {
      setError('No camp loaded — refresh the app')
      return
    }
    setSaving(true)
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.write(token, 'camps', campId, 'name', campName.trim())
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        setError('That camp name could not be saved. It is unchanged.')
        return
      }
      setSavedName(campName.trim())
      setNameSaved(true)
      setTimeout(() => setNameSaved(false), 4000)
    } catch (err) {
      setError(describeWriteFailure(err, 'That camp name could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  // Counts are keyed by STEPS.key; getSetupGaps wants collections. Length is
  // all it inspects, so a count becomes an array of that length.
  const gaps = getSetupGaps({
    cohorts: Array(counts.cohorts || 0).fill(null),
    tiers: Array(counts.tiers || 0).fill(null),
    groups: Array(counts.groups || 0).fill(null),
    days: Array(counts.days || 0).fill(null),
    timeBlocks: Array(counts.timeblocks || 0).fill(null),
    activities: Array(counts.activities || 0).fill(null),
  })
  const gapKeys = new Set(gaps.map(g => g.key))

  return (
    <div style={{ maxWidth: 560 }}>
      {error && (
        <div style={{ ...S.errorBanner, display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button
            onClick={() => { loadCamp(); loadCounts() }}
            style={{
              flexShrink: 0, padding: '4px 12px', fontSize: 12, fontWeight: 600,
              fontFamily: 'inherit', cursor: 'pointer', borderRadius: 6,
              color: 'var(--warning)', background: 'transparent',
              border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          color: 'var(--text-secondary)', marginBottom: 6,
        }}>
          Getting started
        </div>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 26,
          color: 'var(--text)', letterSpacing: '-0.3px', marginBottom: 8,
        }}>
          Camp Setup
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Set these up in whatever order suits you. Every row can be opened at any time.
        </div>
      </div>

      {/* Camp name */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
        padding: '14px 16px', marginBottom: 24,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--text-secondary)', whiteSpace: 'nowrap',
        }}>
          Camp name
        </div>
        <input
          value={campName}
          onChange={e => { setCampName(e.target.value); setNameSaved(false) }}
          onKeyDown={e => e.key === 'Enter' && saveName()}
          style={{
            flex: 1, padding: '7px 10px', border: '1px solid var(--border)',
            borderRadius: 6, fontSize: 14, outline: 'none',
            background: 'var(--bg)', color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
          }}
          placeholder="Camp name"
        />
        <button
          onClick={saveName}
          disabled={saving || !campName.trim() || campName === savedName}
          style={{
            ...S.btnPrimary, whiteSpace: 'nowrap', fontSize: 13,
            opacity: (saving || !campName.trim() || campName === savedName) ? 0.45 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {nameSaved && (
          <div style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
            ✓ Saved
          </div>
        )}
      </div>

      {/* Where setup stands, in one sentence. This replaced a progress bar
          that reported a fraction of the wrong set — see readiness.js. */}
      {!loadingCounts && (
        <div style={{
          marginBottom: 20, padding: '10px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5,
          background: 'var(--surface)',
          borderLeft: `3px solid var(--${gaps.length === 0 ? 'success' : 'accent'})`,
          border: '1px solid var(--border)',
          borderLeftWidth: 3,
          borderLeftColor: `var(--${gaps.length === 0 ? 'success' : 'accent'})`,
          color: 'var(--text)',
        }}>
          {describeSetupGaps(gaps)}
        </div>
      )}

      {/* Step cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
        {STEPS.map((step) => {
          const count = counts[step.key] || 0
          const done = count > 0
          // Was `prevAllDone` — a sequential gate that only ever changed a
          // shadow, since every row always navigated. What a director needs
          // marked is what stops them building a week.
          const isBlocking = gapKeys.has(step.key)
          const isOptional = OPTIONAL_AREAS.some(a => a.key === step.key)

          return (
            <button
              key={step.key}
              onClick={() => onNavigate(step.screen)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 14,
                padding: '14px 16px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10, textAlign: 'left', cursor: 'pointer',
                boxShadow: 'none',
                outline: isBlocking ? '1.5px solid var(--accent)' : 'none',
                outlineOffset: -1,
                transition: 'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { if (!isBlocking) e.currentTarget.style.borderColor = 'var(--primary)' }}
              onMouseLeave={e => { if (!isBlocking) e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              {/* Icon */}
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                background: done ? 'rgba(0,170,89,0.12)' : isBlocking ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'var(--border)',
                color: done ? 'var(--success)' : isBlocking ? 'var(--accent)' : 'var(--text-secondary)',
              }}>
                {done ? '✓' : isBlocking ? '!' : '·'}
              </div>

              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 14,
                  color: done ? 'var(--text-secondary)' : 'var(--text)', marginBottom: 3,
                }}>
                  {step.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {step.desc}
                </div>
              </div>

              {/* Count + chevron */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 2 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: done ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {loadingCounts ? '…' : done ? `${count} ${count === 1 ? 'item' : 'items'}` : isOptional ? 'optional' : 'needed'}
                </span>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>›</span>
              </div>
            </button>
          )
        })}
      </div>

      {/* Structural summary */}
      {!loadingCounts && (
        <div style={{
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
          padding: '10px 16px', marginBottom: 24,
          display: 'flex', gap: 0, flexWrap: 'wrap',
        }}>
          {STEPS.map((step, i) => {
            const count = counts[step.key] || 0
            return (
              <div key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 14, marginRight: i < STEPS.length - 1 ? 14 : 0, borderRight: i < STEPS.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: count > 0 ? 'var(--text)' : 'var(--text-secondary)' }}>
                  {count}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-condensed)' }}>
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

    </div>
  )
}
