// T106 (docs/work/tickets/T106-special-day-author-ui.md;
// docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md D1;
// docs/work/specs/2026-08-21-special-day-author-ui-design.md;
// docs/work/specs/2026-08-21-special-day-author-ui-designer-spec.md §1).
//
// List screen over `special_days` — flat CRUD, directly analogous to the
// other setup screens (DayOverridesScreen is the direct precedent for the
// list+editor split, though its editor is a flat checkbox list, not a
// SlotCell grid). "Open" navigates into the grid editor sub-view
// (SpecialDayGridEditor); "Delete" wires the deleteSpecialDay cascade IPC.
import { Fragment, useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { describeWriteFailure } from '../utils/writeErrorMessage'
import { S, useEnterTransition } from '../styles/shared'
import ScreenIntro from '../components/ScreenIntro'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import SpecialDayGridEditor from './specialDay/SpecialDayGridEditor'

const LABELS = {
  emptyTitle: 'No special days yet',
  emptyBody: "Build a standalone schedule for Color War, a field trip, or any day that doesn't follow your normal program.",
  createCta: '+ New Special Day',
  seedPrompt: 'Special Day created. Start with your camp’s regular time blocks (you can edit them after), or start empty?',
  seedFromBlocks: 'Seed from Time Blocks',
  startEmpty: 'Start Empty',
  deleteConfirmTitle: (name) => `Delete "${name}"?`,
  deleteConfirmBody: (blocks, slots) =>
    `This special day and its ${blocks} time block${blocks === 1 ? '' : 's'} and ${slots} filled slot${slots === 1 ? '' : 's'} will be removed.`,
  deleteRecovery: (name) => `"${name}" goes to Trash, and you can put it back from there.`,
  deletedElsewhere: 'This special day was deleted.',
}

async function writeField(entity, id, field, value) {
  const token = localStorage.getItem('shoresh-token')
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
  return result
}

export default function SpecialDaysScreen({ campId, role }) {
  const [days, setDays] = useState([])
  const [timeBlocks, setTimeBlocks] = useState([])
  const [slots, setSlots] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [creating, setCreating] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [seedPromptForId, setSeedPromptForId] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [openId, setOpenId] = useState(null)
  const [toast, setToast] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [daysData, blocksData, slotsData, groupsData] = await Promise.all([
        localClient.list('special_days'),
        localClient.list('special_day_time_blocks'),
        localClient.list('special_day_slots'),
        localClient.list('groups'),
      ])
      setDays((daysData || []).filter((d) => d.camp_id === campId).sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''))))
      setTimeBlocks(blocksData || [])
      setSlots(slotsData || [])
      setGroups((groupsData || []).filter((g) => g.camp_id === campId))
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [campId])

  async function createDay() {
    const trimmed = nameDraft.trim()
    if (!trimmed) return
    const id = crypto.randomUUID()
    try {
      await writeField('special_days', id, 'name', trimmed)
      setDays((prev) => [...prev, { id, camp_id: campId, name: trimmed }])
      setNameDraft('')
      setCreating(false)
      setSeedPromptForId(id)
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not create that special day.'))
    }
  }

  async function seedFromCampTimeBlocks(specialDayId) {
    try {
      const campBlocks = await localClient.list('time_blocks')
      const scoped = (campBlocks || [])
        .filter((b) => b.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      for (const b of scoped) {
        const newId = crypto.randomUUID()
        await writeField('special_day_time_blocks', newId, 'special_day_id', specialDayId)
        await writeField('special_day_time_blocks', newId, 'name', b.name)
        await writeField('special_day_time_blocks', newId, 'sort_order', b.sort_order ?? 0)
        if (b.start_time) await writeField('special_day_time_blocks', newId, 'start_time', b.start_time)
        if (b.end_time) await writeField('special_day_time_blocks', newId, 'end_time', b.end_time)
      }
    } catch (err) {
      setError(describeWriteFailure(err, 'Could not seed time blocks.'))
    } finally {
      setSeedPromptForId(null)
      setOpenId(specialDayId)
      await load()
    }
  }

  function startEmpty(specialDayId) {
    setSeedPromptForId(null)
    setOpenId(specialDayId)
  }

  function requestDelete(day) {
    setPendingDelete(day)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = await localClient.deleteSpecialDay({ specialDayId: pendingDelete.id })
      if (result?.error) throw new Error(result.error)
      setPendingDelete(null)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That special day could not be deleted.'))
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  function blocksFor(dayId) {
    return timeBlocks.filter((b) => b.special_day_id === dayId)
  }
  function slotsFor(dayId) {
    return slots.filter((s) => s.special_day_id === dayId)
  }

  if (openId) {
    return (
      <SpecialDayGridEditor
        campId={campId}
        specialDayId={openId}
        onBack={() => { setOpenId(null); load() }}
        onDeletedElsewhere={() => {
          setOpenId(null)
          setToast(LABELS.deletedElsewhere)
          load()
        }}
      />
    )
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <ScreenIntro screen="specialdays" />
      {toast && (
        <div style={{ ...S.errorBanner, background: 'var(--surface)', marginBottom: 16 }}>{toast}</div>
      )}
      {error && <div style={S.errorBanner}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {days.length} special day{days.length !== 1 ? 's' : ''}
        </div>
        {!creating && (
          <button className="press-97" onClick={() => setCreating(true)} style={S.btnPrimary}>{LABELS.createCta}</button>
        )}
      </div>

      {creating && (
        <div style={{ ...enterStyle, display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createDay()}
            placeholder="Name your special day…"
            style={{ ...S.input, flex: 1 }}
          />
          <button className="press-97" onClick={createDay} style={S.btnPrimary} disabled={!nameDraft.trim()}>Create</button>
          <button className="press-97" onClick={() => { setCreating(false); setNameDraft('') }} style={S.btnSecondary}>Cancel</button>
        </div>
      )}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : days.length === 0 && !creating ? (
        <div style={{ ...S.emptyState, ...enterStyle }}>
          <div style={S.emptyStateTitle}>{LABELS.emptyTitle}</div>
          <div style={S.emptyStateBody}>{LABELS.emptyBody}</div>
          <button className="press-97" onClick={() => setCreating(true)} style={{ ...S.btnPrimary, marginTop: 12 }}>{LABELS.createCta}</button>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Time Blocks</th>
                <th style={S.th}>Groups Filled</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const dayBlocks = blocksFor(d.id)
                const daySlots = slotsFor(d.id)
                const filled = daySlots.filter((s) => s.activity_id).length
                const total = groups.length * dayBlocks.length
                return (
                  <Fragment key={d.id}>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
                    >
                      <td style={{ ...S.td, fontWeight: 500 }}>{d.name}</td>
                      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {dayBlocks.length} block{dayBlocks.length !== 1 ? 's' : ''}
                      </td>
                      <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                        {filled} / {total} cells filled
                      </td>
                      <td style={{ ...S.td, textAlign: 'right' }}>
                        <button className="press-97" onClick={() => setOpenId(d.id)} style={S.btnSecondary}>Open</button>
                        <button
                          onClick={() => requestDelete(d)}
                          disabled={role !== 'admin'}
                          title={role !== 'admin' ? 'Admin only' : undefined}
                          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                        >Delete</button>
                      </td>
                    </tr>
                    {seedPromptForId === d.id && (
                      <tr key={`${d.id}-seed`}>
                        <td colSpan={4} style={{ padding: '10px 14px', background: 'var(--bg)' }}>
                          <div style={enterStyle}>
                            <div style={{ fontSize: 13, marginBottom: 8 }}>{LABELS.seedPrompt}</div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button className="press-97" onClick={() => seedFromCampTimeBlocks(d.id)} style={S.btnSecondary}>{LABELS.seedFromBlocks}</button>
                              <button className="press-97" onClick={() => startEmpty(d.id)} style={S.btnSecondary}>{LABELS.startEmpty}</button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDangerDialog
          title={LABELS.deleteConfirmTitle(pendingDelete.name)}
          body={LABELS.deleteConfirmBody(blocksFor(pendingDelete.id).length, slotsFor(pendingDelete.id).filter((s) => s.activity_id).length)}
          recovery={LABELS.deleteRecovery(pendingDelete.name)}
          confirmLabel="Delete Special Day"
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
