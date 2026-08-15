import { useState, useEffect, useRef } from 'react'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { useCohorts } from '../hooks/useCohorts'
import CohortPicker from '../components/CohortPicker'
import ScreenIntro from '../components/ScreenIntro'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'

// Frequency mode is not yet a real choice — neither behaviour is built — so the
// control is hidden rather than shown disabled ("coming soon" advertises unfinished
// machinery on an already-optional screen). Templates still persist a stable default
// ('reduced') so the field is forward-compatible: when the modes ship, the control
// reappears and existing templates already carry a sensible value.
const DEFAULT_FREQUENCY_MODE = 'reduced'

// Fires one write() per field (the op-log is field-level) and surfaces the
// first failure rather than a silent partial write — mirrors
// AnchorsScreen.jsx's identical helper.
async function writeFields(entity, id, fields) {
  const token = localStorage.getItem('shoresh-token')
  for (const [field, value] of Object.entries(fields)) {
    const result = await localClient.write(token, entity, id, field, value)
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      throw new Error(`write failed for field "${field}"`)
    }
  }
}

// Best-effort rollback of a row from a mid-fan-out failure. Returns whether
// the delete actually succeeded — deleteEntity routes to a DELETE_FIELD
// write, which electron/main.js gates to admin-only, so a non-admin's
// cleanup attempt is *correctly* refused. Callers must not treat a refused
// cleanup as if nothing went wrong: the row is real and orphaned, and the
// user needs to be told, not reassured. Mirrors AnchorsScreen.jsx's
// cleanupPartialRow exactly.
async function cleanupPartialRow(entity, id) {
  try {
    const token = localStorage.getItem('shoresh-token')
    const result = await localClient.deleteEntity(token, entity, id)
    return !!(result && (result.status === 'applied' || result.status === 'queued'))
  } catch {
    return false
  }
}

function OverrideModal({ template, cohortId, campId, onClose, onSaved }) {
  const isNew = !template?.id
  const [name, setName] = useState(template?.name || '')
  // Not user-editable while the modes are unbuilt; preserves an existing template's
  // saved value on re-save and writes the stable default for new ones.
  const freqMode = template?.frequency_mode || DEFAULT_FREQUENCY_MODE
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [timeBlocks, setTimeBlocks] = useState([])
  const [activities, setActivities] = useState([])
  const [existingSlotIds, setExistingSlotIds] = useState([])
  const [loadError, setLoadError] = useState(null)
  // slots: { [blockId]: activityId | '' }  (presence = overridden, '' = clear block)
  const [slots, setSlots] = useState({})
  const enterStyle = useEnterTransition('liftFade')

  async function loadResources() {
    setLoadError(null)
    try {
      const [blocksData, actsData, slotsData] = await Promise.all([
        localClient.list('time_blocks'),
        localClient.list('activities'),
        template?.id ? localClient.list('day_override_template_slots') : Promise.resolve([]),
      ])
      const blocks = (blocksData || [])
        .filter(b => b.camp_id === campId && b.cohort_id === cohortId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      const acts = (actsData || [])
        .filter(a => a.camp_id === campId)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      const existing = template?.id
        ? (slotsData || []).filter(s => s.day_override_template_id === template.id)
        : []
      setTimeBlocks(blocks)
      setActivities(acts)
      const map = {}
      const ids = []
      for (const s of existing) {
        map[s.time_block_id] = s.activity_id || ''
        ids.push(s.id)
      }
      setSlots(map)
      setExistingSlotIds(ids)
    } catch {
      setLoadError('Failed to load data — check your connection and refresh')
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadResources() }, [cohortId])

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
    setSaveError(null)
    let templateId = template?.id
    const createdSlotIds = []
    let deletePhaseFailed = false
    let deletePhaseDone = false
    let createPhaseFailed = false
    try {
      if (isNew) {
        templateId = crypto.randomUUID()
        await writeFields('day_override_templates', templateId, {
          name: name.trim(),
          frequency_mode: freqMode,
          camp_id: campId,
          cohort_id: cohortId,
        })
      } else {
        await writeFields('day_override_templates', templateId, {
          name: name.trim(),
          frequency_mode: freqMode,
        })
      }

      // Replace all slots: delete every existing row for this template,
      // then create a fresh row per current entry in `slots`. Mirrors the
      // Supabase delete-then-insert semantics exactly. Delete-phase and
      // create-phase outcomes are tracked separately so a failure in
      // either phase can be reported with an honest description of the
      // template's actual final state, rather than a generic message
      // that could mask a partial wipe or a full wipe of prior overrides.
      try {
        for (const slotId of existingSlotIds) {
          const result = await localClient.deleteEntity(
            localStorage.getItem('shoresh-token'),
            'day_override_template_slots',
            slotId
          )
          if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
            throw new Error('delete failed for slot')
          }
        }
        deletePhaseDone = true
      } catch (err) {
        deletePhaseFailed = true
        throw err
      }

      try {
        for (const [blockId, activityId] of Object.entries(slots)) {
          const newId = crypto.randomUUID()
          createdSlotIds.push(newId)
          await writeFields('day_override_template_slots', newId, {
            day_override_template_id: templateId,
            time_block_id: blockId,
            activity_id: activityId || null,
          })
        }
      } catch (err) {
        createPhaseFailed = true
        throw err
      }

      onSaved()
    } catch (err) {
      // Known, accepted residual (same lesson as AnchorsScreen.jsx's
      // saveAnchor): a refused cleanup delete (admin-gated) is reported as
      // "may remain" even if the failed write never actually reached the
      // DB — the admin gate fires on the delete attempt regardless of
      // whether a row exists to delete.
      const cleanupResults = await Promise.all(
        createdSlotIds.map(id => cleanupPartialRow('day_override_template_slots', id))
      )
      const cleanupFailed = cleanupResults.some(ok => !ok)

      let message
      if (deletePhaseFailed) {
        message = 'Save failed while removing your old block overrides — some old blocks may still be set, and none of your new changes were saved. Reload and check this template before assuming your changes applied.'
      } else if (cleanupFailed) {
        message = `Save failed partway through, and ${cleanupResults.filter(ok => !ok).length} new block override(s) couldn't be removed automatically (admin required) — ask an admin to review and clean up this template.`
      } else if (deletePhaseDone && createPhaseFailed && existingSlotIds.length > 0) {
        message = 'Save failed after removing your previous block overrides — this template currently has NO block overrides set. Please try again.'
      } else {
        message = describeWriteFailure(err, 'Your changes could not be saved.')
      }
      setSaveError(message)
      console.error('Save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ ...S.overlay, ...enterStyle }}>
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

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Block Overrides
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Check a block to override it on this day type. Leave activity blank to clear the block (free time).
          </div>
          {loadError ? (
            <div style={{ fontSize: 13, color: 'var(--warning)', fontFamily: 'var(--font-mono)' }}>{loadError}</div>
          ) : timeBlocks.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
              No time blocks in this program yet.
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

        {saveError && <div style={S.errorBanner}>{saveError}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="press-97" onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button className="press-97" onClick={save} disabled={saving || !name.trim()}
            style={{ ...S.btnPrimary, opacity: (!name.trim() || saving) ? 0.5 : 1 }}>
            {saving ? 'Saving…' : isNew ? 'Create Template' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function DayOverridesScreen({ campId, role, onNavigate }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null) // null | { template: obj|null }
  const [error, setError] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null) // template being confirmed for delete
  const [deleting, setDeleting] = useState(false)
  const deleteInFlight = useRef(false)
  const { cohorts, activeCohort, setActiveCohortId } = useCohorts(campId)

  useEffect(() => {
    if (activeCohort) load()
  }, [campId, activeCohort?.id])

  async function load() {
    if (!activeCohort) return
    setLoading(true)
    setError(null)
    try {
      const [templatesData, slotsData] = await Promise.all([
        localClient.list('day_override_templates'),
        localClient.list('day_override_template_slots'),
      ])
      const scopedTemplates = (templatesData || [])
        .filter(t => t.camp_id === campId && t.cohort_id === activeCohort.id)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')))
      const slots = slotsData || []
      const withSlots = scopedTemplates.map(t => ({
        ...t,
        day_override_template_slots: slots.filter(s => s.day_override_template_id === t.id),
      }))
      setTemplates(withSlots)
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  function deleteTemplate(id) {
    const template = templates.find(t => t.id === id)
    if (!template) return
    setPendingDelete(template)
  }

  async function confirmTemplateDelete() {
    if (!pendingDelete || deleteInFlight.current) return
    deleteInFlight.current = true
    setDeleting(true)
    const id = pendingDelete.id
    let deletedChildCount = 0
    let totalChildCount = 0
    let childDeleteFailed = false
    try {
      const token = localStorage.getItem('shoresh-token')
      const allSlots = await localClient.list('day_override_template_slots')
      const childIds = (allSlots || [])
        .filter(s => s.day_override_template_id === id)
        .map(s => s.id)
      totalChildCount = childIds.length
      for (const slotId of childIds) {
        const result = await localClient.deleteEntity(token, 'day_override_template_slots', slotId)
        if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
          childDeleteFailed = true
          throw new Error('delete failed')
        }
        deletedChildCount++
      }
      const result = await localClient.deleteEntity(token, 'day_override_templates', id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      setPendingDelete(null)
      await load()
    } catch (err) {
      if (/admin role required/i.test(err?.message ?? '')) {
        setError('Only an admin can delete override templates.')
      } else if (childDeleteFailed && deletedChildCount > 0 && deletedChildCount < totalChildCount) {
        setError(`Delete failed partway through — some of this template's block overrides were removed (${deletedChildCount} of ${totalChildCount}) but the template itself was not deleted. Check this template before trying again.`)
      } else if (!childDeleteFailed && totalChildCount > 0) {
        setError("This template's block overrides were removed, but the template itself could not be deleted. Please try again.")
      } else {
        setError(describeWriteFailure(err, 'That template could not be deleted.'))
      }
      setPendingDelete(null)
      await load()
    } finally {
      setDeleting(false)
      deleteInFlight.current = false
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <ScreenIntro screen="dayoverrides" />
      <CohortPicker cohorts={cohorts} activeCohort={activeCohort} onChange={setActiveCohortId} />
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </div>
        <button className="press-97" onClick={() => setModal({ template: null })} style={S.btnPrimary}>+ New Template</button>
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Block Overrides</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr><td colSpan={4} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No templates yet</div>
                  <div style={S.emptyStateBody}>Create templates for field trips, color war, or other days with a different schedule.</div>
                </td></tr>
              ) : templates.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <td style={{ ...S.td, fontWeight: 500 }}>{t.name}</td>
                  <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                    {t.day_override_template_slots?.length ?? 0} block{(t.day_override_template_slots?.length ?? 0) !== 1 ? 's' : ''}
                  </td>
                  <td style={{ ...S.td, textAlign: 'right' }}>
                    <button className="press-97" onClick={() => setModal({ template: t })} style={S.btnSecondary}>Edit</button>
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      disabled={role !== 'admin'}
                      title={role !== 'admin' ? 'Admin only' : undefined}
                      style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                    >Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && activeCohort && (
        <OverrideModal
          template={modal.template}
          cohortId={activeCohort.id}
          campId={campId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}

      {pendingDelete && (
        <ConfirmDangerDialog
          title={`Delete "${pendingDelete.name}"?`}
          body={deleteBodyText(pendingDelete)}
          recovery={`"${pendingDelete.name}" goes to Trash, and you can put it back from there.`}
          confirmLabel="Delete Template"
          busy={deleting}
          onConfirm={confirmTemplateDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={() => onNavigate('schedule')} style={S.btnPrimary}>Go to Schedule</button>
      </div>
    </div>
  )
}

function deleteBodyText(template) {
  const n = template.day_override_template_slots?.length ?? 0
  if (n === 0) return 'This template has no block overrides. It will be removed from your programs.'
  if (n === 1) return 'This template and its 1 block override will be removed from your programs.'
  return `This template and its ${n} block overrides will be removed from your programs.`
}
