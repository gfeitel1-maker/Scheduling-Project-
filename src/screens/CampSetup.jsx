import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { S } from '../styles/shared'

const STEPS = [
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
    desc: 'Events that hold the same slot every day — Aruchat Boker, Tefillah, Flagpole.',
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

  // eslint-disable-next-line react-hooks/immutability
  useEffect(() => { loadCamp(); loadCounts() }, [campId])

  async function loadCamp() {
    const { data } = await supabase.from('camps').select('name').eq('id', campId).single()
    if (data) { setCampName(data.name); setSavedName(data.name) }
  }

  async function loadCounts() {
    setLoadingCounts(true)
    setError(null)
    try {
      const results = await Promise.all(
        STEPS.map(s => supabase.from(s.table).select('id', { count: 'exact', head: true }).eq('camp_id', campId))
      )
      const map = {}
      STEPS.forEach((s, i) => { map[s.key] = results[i].count || 0 })
      setCounts(map)
    } catch {
      setError('Failed to load — check your connection and refresh')
    } finally {
      setLoadingCounts(false)
    }
  }

  async function saveName() {
    if (!campName.trim() || campName === savedName) return
    setSaving(true)
    await supabase.from('camps').update({ name: campName.trim() }).eq('id', campId)
    setSavedName(campName.trim())
    setNameSaved(true)
    setSaving(false)
    setTimeout(() => setNameSaved(false), 4000)
  }

  const doneCount = STEPS.filter(s => (counts[s.key] || 0) > 0).length
  const allDone = doneCount === STEPS.length

  return (
    <div style={{ maxWidth: 560 }}>
      {error && <div style={S.errorBanner}>{error}</div>}

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
          Complete each section in order. The engine needs all five before it can build a schedule.
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

      {/* Progress bar */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <div style={{
            fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-secondary)',
          }}>Progress</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
            {doneCount} / {STEPS.length} complete
          </div>
        </div>
        <div style={{ height: 4, background: 'var(--border)', borderRadius: 99, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 99,
            width: `${(doneCount / STEPS.length) * 100}%`,
            background: 'var(--primary)',
            transition: 'width 0.4s ease',
          }} />
        </div>
      </div>

      {/* Step cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
        {STEPS.map((step, idx) => {
          const count = counts[step.key] || 0
          const done = count > 0
          const prevAllDone = STEPS.slice(0, idx).every(s => (counts[s.key] || 0) > 0)
          const isActive = !done && prevAllDone

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
                boxShadow: isActive ? '0 2px 10px rgba(0,0,0,0.08)' : 'none',
                outline: isActive ? '1.5px solid var(--primary)' : 'none',
                outlineOffset: -1,
                transition: 'box-shadow 0.15s, border-color 0.15s',
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--primary)' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              {/* Icon */}
              <div style={{
                width: 26, height: 26, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                background: done ? 'rgba(0,170,89,0.12)' : isActive ? 'rgba(47,125,225,0.1)' : 'var(--border)',
                color: done ? 'var(--success)' : isActive ? 'var(--primary)' : 'var(--text-secondary)',
              }}>
                {done ? '✓' : idx + 1}
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
                  {loadingCounts ? '…' : done ? `${count} ${count === 1 ? 'item' : 'items'}` : '—'}
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

      {/* CTA */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button
          onClick={() => onNavigate('schedule')}
          disabled={!allDone}
          style={{
            ...S.btnPrimary, padding: '11px 22px', fontSize: 14,
            opacity: allDone ? 1 : 0.35,
            cursor: allDone ? 'pointer' : 'not-allowed',
          }}
        >
          Generate Schedule →
        </button>
        {!allDone && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {STEPS.length - doneCount} step{STEPS.length - doneCount !== 1 ? 's' : ''} remaining
          </span>
        )}
      </div>
    </div>
  )
}
