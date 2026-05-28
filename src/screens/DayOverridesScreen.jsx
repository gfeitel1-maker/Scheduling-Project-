import { useState, useEffect } from 'react'
import { supabase } from '../supabase'
import { S } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'

const FREQUENCY_MODES = [
  { value: 'reduced',     label: 'Reduced — targets scale down proportionally' },
  { value: 'best_effort', label: 'Best effort — targets unchanged, engine does what it can' },
]

function OverrideModal({ template, cohortId, campId, onClose, onSaved }) {
  const isNew = !template?.id
  const [name, setName] = useState(template?.name || '')
  const [freqMode, setFreqMode] = useState(template?.frequency_mode || 'reduced')
  const [saving, setSaving] = useState(false)
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  // slots: { [blockId]: activityId | '' }  (presence = overridden, '' = clear block)
  const [slots, setSlots] = useState({})

  useEffect(() => { loadResources() }, [cohortId])

  async function loadResources() {
    const [{ data: blocks }, { data: acts }, { data: existing }] = await Promise.all([
      supabase.from('time_blocks').select('*').eq('camp_id', campId)
        .eq('cohort_id', cohortId).order('sort_order'),
      supabase.from('activities').select('id, name').eq('camp_id', campId).order('name'),
      template?.id
        ? supabase.from('day_override_template_slots').select('*').eq('template_id', template.id)
        : Promise.resolve({ data: [] }),
    ])
    setTimeBlocks(blocks || [])
    setActivities(acts || [])
    const map = {}
    for (const s of existing || []) {
      map[s.time_block_id] = s.activity_id || ''
    }
    setSlots(map)
  }

  function toggleSlot(blockId) {
    setSlots(prev => {
      if (blockId in prev) {
        const next = { ...prev }
        delete next[blockId]
        return next
      }
      return { ...prev, [blockId]: '' }
    })
  }

  function setSlotActivity(blockId, activityId) {
    setSlots(prev => ({ ...prev, [blockId]: activityId }))
  }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      let templateId = template?.id
      if (isNew) {
        const { data, error: insertErr } = await supabase.from('day_override_templates').insert({
          camp_id: campId,
          cohort_id: cohortId,
          name: name.trim(),
          frequency_mode: freqMode,
        }).select('id').single()
        if (insertErr || !data) throw insertErr || new Error('Insert returned no data')
        templateId = data.id
      } else {
        await supabase.from('day_override_templates').update({
          name: name.trim(),
          frequency_mode: freqMode,
        }).eq('id', templateId)
      }
      // Replace all slots
      await supabase.from('day_override_template_slots').delete().eq('template_id', templateId)
      const rows = Object.entries(slots).map(([blockId, activityId]) => ({
        template_id: templateId,
        time_block_id: blockId,
        activity_id: activityId || null,
      }))
      if (rows.length > 0) {
        await supabase.from('day_override_template_slots').insert(rows)
      }
      onSaved()
    } catch (err) {
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, width: 560 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'New Override Template' : `Edit: ${template.name}`}
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={S.label}>Template Name</div>
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !saving && save()} style={S.input}
            placeholder="e.g. Field Trip, Color War, Shabbaton" />
        </div>

        <div style={{ marginBottom: 18 }}>
          <div style={S.label}>Frequency Mode</div>
          <select value={freqMode} onChange={e => setFreqMode(e.target.value)} style={S.input}>
            {FREQUENCY_MODES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Block Overrides
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Check a block to override it on this day type. Leave activity blank to clear the block (free time).
          </div>
          {timeBlocks.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              No time blocks in this cohort yet.
            </div>
          ) : timeBlocks.map(block => {
            const overridden = block.id in slots
            return (
              <div key={block.id} style={{
                display: 'flex', gap: 10, alignItems: 'center',
                padding: '8px 10px', marginBottom: 4,
                background: overridden ? 'var(--surface)' : 'transparent',
                border: `1px solid ${overridden ? 'var(--border)' : 'transparent'}`,
                borderRadius: 7,
              }}>
                <input type="checkbox" checked={overridden} onChange={() => toggleSlot(block.id)}
                  style={{ flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 500, minWidth: 120 }}>{block.name}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', minWidth: 90 }}>
                  {block.start_time?.slice(0, 5)}–{block.end_time?.slice(0, 5)}
                </span>
                {overridden && (
                  <select value={slots[block.id] || ''}
                    onChange={e => setSlotActivity(block.id, e.target.value)}
                    style={{ ...S.input, flex: 1, fontSize: 12 }}>
                    <option value="">— Clear block (free time) —</option>
                    {activities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()}
            style={{ ...S.btnPrimary, opacity: (!name.trim() || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? 'Create Template' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DayOverridesScreen({ campId }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null) // null | { template: obj|null }
  const [error, setError] = useState(null)
  const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id])

  async function load() {
    if (!activeCohort) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await supabase
        .from('day_override_templates')
        .select('*, day_override_template_slots(*)')
        .eq('camp_id', campId)
        .eq('cohort_id', activeCohort.id)
        .order('name')
      setTemplates(data || [])
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  async function deleteTemplate(id) {
    if (!window.confirm('Delete this override template?')) return
    await supabase.from('day_override_template_slots').delete().eq('template_id', id)
    await supabase.from('day_override_templates').delete().eq('id', id)
    load()
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </div>
        <button onClick={() => setModal({ template: null })} style={S.btnPrimary}>+ New Template</button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Frequency Mode</th>
                <th style={S.th}>Block Overrides</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: '40px 16px', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No templates yet</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Create templates for field trips, color war, or other days with a different schedule.</div>
                </td></tr>
              ) : templates.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...S.td, fontWeight: 500 }}>{t.name}</td>
                  <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
                    {FREQUENCY_MODES.find(o => o.value === t.frequency_mode)?.label ?? t.frequency_mode}
                  </td>
                  <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t.day_override_template_slots?.length ?? 0} block{(t.day_override_template_slots?.length ?? 0) !== 1 ? 's' : ''}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button onClick={() => setModal({ template: t })} style={S.btnSecondary}>Edit</button>
                    <button onClick={() => deleteTemplate(t.id)} style={{ ...S.btnDanger, marginLeft: 6 }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Override templates define how specific days differ from the standard schedule.
        Apply them to individual calendar dates in the Schedule screen.
      </div>

      {modal && activeCohort && (
        <OverrideModal
          template={modal.template}
          cohortId={activeCohort.id}
          campId={campId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}
