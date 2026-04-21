import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

const CHECKLIST = [
  { key: 'tiers',      label: 'Tiers',            screen: 'tiers',      table: 'tiers' },
  { key: 'groups',     label: 'Groups',      screen: 'groups',     table: 'groups' },
  { key: 'timeblocks', label: 'Time Blocks', screen: 'timeblocks', table: 'time_blocks' },
  { key: 'activities', label: 'Activities',       screen: 'activities', table: 'activities' },
  { key: 'anchors',    label: 'Anchors',          screen: 'anchors',    table: 'anchor_activities' },
]

export default function CampSetup({ campId, onNavigate }) {
  const [campName, setCampName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [saving, setSaving] = useState(false)
  const [counts, setCounts] = useState({})
  const [loadingCounts, setLoadingCounts] = useState(true)

  useEffect(() => {
    loadCamp()
    loadCounts()
  }, [campId])

  async function loadCamp() {
    const { data } = await supabase.from('camps').select('name').eq('id', campId).single()
    if (data) { setCampName(data.name); setSavedName(data.name) }
  }

  async function loadCounts() {
    setLoadingCounts(true)
    const results = await Promise.all(
      CHECKLIST.map(item =>
        supabase.from(item.table).select('id', { count: 'exact', head: true }).eq('camp_id', campId)
      )
    )
    const map = {}
    CHECKLIST.forEach((item, i) => { map[item.key] = results[i].count || 0 })
    setCounts(map)
    setLoadingCounts(false)
  }

  async function saveName() {
    if (!campName.trim() || campName === savedName) return
    setSaving(true)
    await supabase.from('camps').update({ name: campName.trim() }).eq('id', campId)
    setSavedName(campName.trim())
    setSaving(false)
  }

  const allDone = CHECKLIST.every(item => (counts[item.key] || 0) > 0)

  return (
    <div style={{ maxWidth: 600 }}>
      <section style={{ marginBottom: 32 }}>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16,
          marginBottom: 12, letterSpacing: '-0.1px',
        }}>Camp Name</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            value={campName}
            onChange={e => setCampName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveName()}
            style={{
              flex: 1, padding: '9px 12px', border: '1px solid var(--border)',
              borderRadius: 6, fontSize: 14, outline: 'none', background: 'var(--surface)',
            }}
            placeholder="Camp name"
          />
          <button
            onClick={saveName}
            disabled={saving || !campName.trim() || campName === savedName}
            style={{
              padding: '9px 18px', background: 'var(--primary)', color: '#fff',
              border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13,
              opacity: (saving || !campName.trim() || campName === savedName) ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {savedName && campName === savedName && (
          <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
            ✓ Saved
          </div>
        )}
      </section>

      <section>
        <div style={{
          fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16,
          marginBottom: 4, letterSpacing: '-0.1px',
        }}>Setup Checklist</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Complete each section before generating a schedule.
        </div>

        {allDone && !loadingCounts && (
          <div style={{
            background: 'var(--surface-elevated)', border: '1px solid var(--primary)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 16,
            fontSize: 13, color: 'var(--primary)', fontWeight: 600,
          }}>
            ✓ All sections complete — you're ready to generate a schedule.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {CHECKLIST.map(item => {
            const count = counts[item.key] || 0
            const done = count > 0
            return (
              <button
                key={item.key}
                onClick={() => onNavigate(item.screen)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '11px 14px', background: 'var(--surface)',
                  border: '1px solid var(--border)', borderRadius: 6,
                  textAlign: 'left', fontSize: 13, cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: '50%', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                    background: done ? 'var(--success)' : 'var(--border)',
                    color: done ? '#fff' : 'var(--text-secondary)',
                    flexShrink: 0,
                  }}>
                    {done ? '✓' : '○'}
                  </span>
                  <span style={{ fontWeight: done ? 500 : 400 }}>{item.label}</span>
                </div>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 12,
                  color: done ? 'var(--text-secondary)' : 'var(--border)',
                }}>
                  {loadingCounts ? '…' : `${count} item${count !== 1 ? 's' : ''}`}
                </span>
              </button>
            )
          })}
        </div>

        {allDone && !loadingCounts && (
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => onNavigate('schedule')}
              style={{
                padding: '10px 20px', background: 'var(--primary)', color: '#fff',
                border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 14,
              }}
            >
              Go to Schedule →
            </button>
          </div>
        )}
      </section>

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={() => onNavigate('tiers')}
          style={{ padding: '7px 14px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
        >
          Next: Tiers →
        </button>
      </div>
    </div>
  )
}
