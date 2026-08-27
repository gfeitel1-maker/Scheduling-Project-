import React, { useState, useEffect, useRef } from 'react'
import { describeWriteFailure, deleteRefusalMessage } from '../utils/writeErrorMessage'
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet, unescapeRow } from '../utils/exportSanitize.js'
import { localClient } from '../localClient'
import { S, prefersReducedMotion } from '../styles/shared'
import DeleteRecordDialog from '../components/DeleteRecordDialog'
import ConfirmDangerDialog from '../components/ConfirmDangerDialog'
import ImportModal from '../components/setup/ImportModal'
import SetupScreenShell from '../components/setup/SetupScreenShell'
import RecordHistory from '../components/RecordHistory'
import WeekContextBar from '../components/schedule/WeekContextBar'
import ExclusionConfirmDialog from '../components/schedule/ExclusionConfirmDialog'
import { createScheduleRepository } from '../data/scheduleRepository'
import { createSetupCrudRepository } from '../data/setupCrudRepository'

const repo = createScheduleRepository({ localClient })
// Repository-only migration (not the full useCrudScreen hook): load() fetches
// groups AND tiers in parallel plus a separate weekId-driven exclusions
// effect, which is outside the hook's single-entity load model.
// See docs/adr/2026-08-12-setup-crud-shared-persistence-seam.md.
const repository = createSetupCrudRepository({ localClient })

// Edit-mode Save/Cancel (and Delete, where present) must sit on one line —
// never wrap/stack — at the screen's normal width.
const rowActionsFlex = { display: 'flex', flexWrap: 'nowrap', gap: 6, justifyContent: 'flex-end' }

const AVAIL_OPTIONS = [
  { value: 'all', label: 'All Day' },
  { value: 'morning', label: 'Morning Only' },
  { value: 'afternoon', label: 'Afternoon Only' },
]

function GroupRow({ group, tiers, role, onSave, onDelete, onHistory, weekToggle }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(group.name)
  const [tierId, setTierId] = useState(group.tier_id || '')
  const [avail, setAvail] = useState(group.availability)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await onSave(group.id, { name: name.trim(), tier_id: tierId || null, availability: avail })
    setSaving(false)
    setEditing(false)
  }

  const tierName = tiers.find(t => t.id === group.tier_id)?.name || '—'

  if (editing) {
    return (
      <tr style={{ background: 'var(--surface-elevated)' }}>
        <td style={S.td}><input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} /></td>
        <td style={S.td}>
          <select value={tierId} onChange={e => setTierId(e.target.value)} style={S.input}>
            <option value="">— No age division —</option>
            {tiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </td>
        <td style={S.td}>
          <select value={avail} onChange={e => setAvail(e.target.value)} style={S.input}>
            {AVAIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </td>
        <td style={{ ...S.td, textAlign: 'right' }}>
          <div style={rowActionsFlex}>
            <button className="press-97" onClick={save} disabled={saving} style={{ ...S.btnPrimary, whiteSpace: 'nowrap' }}>{saving ? 'Saving…' : 'Save'}</button>
            <button className="press-97" onClick={() => { setName(group.name); setTierId(group.tier_id||''); setAvail(group.availability); setEditing(false) }} style={{ ...S.btnSecondary, whiteSpace: 'nowrap' }}>Cancel</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <td style={S.td}>{group.name}</td>
      <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 13 }}>{tierName}</td>
      <td style={{ ...S.td, fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{AVAIL_OPTIONS.find(o => o.value === group.availability)?.label || '—'}</td>
      {weekToggle}
      <td style={{ ...S.td, textAlign: 'right', borderLeft: weekToggle ? '1px solid var(--border)' : undefined }}>
        <button className="press-97" onClick={() => setEditing(true)} style={S.btnSecondary}>Edit</button>
        <button className="press-97" onClick={() => onHistory(group)} style={{ ...S.btnSecondary, marginLeft: 6 }}>History</button>
        <button
          onClick={() => onDelete(group.id)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
        >Delete</button>
      </td>
    </tr>
  )
}

export default function GroupsScreen({ campId, role, onNavigate, weekId, weeks = [], onSelectWeek }) {
  const [groups, setGroups] = useState([])
  const [tiers, setTiers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newTierId, setNewTierId] = useState('')
  const [newAvail, setNewAvail] = useState('all')
  const [adding, setAdding] = useState(false)
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [excludedGroupIds, setExcludedGroupIds] = useState(new Set())
  const [pendingExclusion, setPendingExclusion] = useState(null)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])
  useEffect(() => { loadExclusions() }, [weekId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [gData, tData] = await Promise.all([
        localClient.list('groups'),
        localClient.list('tiers'),
      ])
      const gList = (gData || [])
        .filter(g => g.camp_id === campId)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      const tList = (tData || [])
        .filter(t => t.camp_id === campId)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      setGroups(gList)
      setTiers(tList)
    } catch {
      setError("Couldn't load your camp setup — check your connection and refresh.")
    } finally {
      setLoading(false)
    }
  }

  async function loadExclusions() {
    if (!weekId) { setExcludedGroupIds(new Set()); return }
    try {
      const { groupExclusions } = await repo.loadWeekExclusions(weekId)
      setExcludedGroupIds(new Set(groupExclusions.map(e => e.group_id)))
    } catch {
      setExcludedGroupIds(new Set())
    }
  }

  async function handleToggleExclusion(group, currentlyExcluded) {
    if (!weekId) return
    if (currentlyExcluded) {
      await repo.toggleGroupExclusion(weekId, group.id, false)
      setExcludedGroupIds(prev => { const next = new Set(prev); next.delete(group.id); return next })
      return
    }
    const allSlots = await localClient.list('template_slots') || []
    const templates = await localClient.list('schedule_templates') || []
    const weekTemplateIds = new Set(templates.filter(t => t.week_id === weekId).map(t => t.id))
    const slotCount = allSlots.filter(s => weekTemplateIds.has(s.template_id) && s.group_id === group.id).length
    if (slotCount === 0) {
      await repo.toggleGroupExclusion(weekId, group.id, true)
      setExcludedGroupIds(prev => new Set([...prev, group.id]))
    } else {
      setPendingExclusion({ group, slotCount })
    }
  }

  async function confirmExclusion() {
    if (!pendingExclusion || !weekId) return
    const { group } = pendingExclusion
    await repo.toggleGroupExclusion(weekId, group.id, true)
    setExcludedGroupIds(prev => new Set([...prev, group.id]))
    setPendingExclusion(null)
  }

  async function addGroup() {
    if (!newName.trim()) return
    setAdding(true)
    try {
      const id = crypto.randomUUID()
      // `name` is written FIRST — mirrors ensureCohort.js/CohortsScreen.jsx's
      // ordering. ensureExists creates the row as part of applying whichever
      // field write lands first, so a UNIQUE(camp_id, name) collision on the
      // `name` write fails atomically before the row ever exists, rather
      // than leaving a camp_id-only orphan behind. createRecord does the
      // write-then-cleanup-on-failure dance.
      await repository.createRecord('groups', id, {
        name: newName.trim(),
        camp_id: campId,
        tier_id: newTierId || null,
        availability: newAvail,
      })
      setNewName(''); setNewTierId(''); setNewAvail('all')
      await load()
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'A group with this name already exists — choose a different name.'
          : describeWriteFailure(err, 'That group could not be added.')
      )
    } finally {
      setAdding(false)
    }
  }

  async function saveGroup(id, fields) {
    try {
      await repository.writeFields('groups', id, fields)
      await load()
    } catch (err) {
      setError(describeWriteFailure(err, 'That group could not be saved.'))
      throw err
    }
  }

  // Deleting a record a schedule uses: count first, confirm with the count
  // shown, then clear and delete in one Host-side transaction.
  // docs/adr/2026-07-30-deleting-a-record-a-schedule-uses.md
  async function deleteGroup(id) {
    setError(null)
    let preview
    try {
      preview = await localClient.previewDelete('groups', id)
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? 'Only an admin can delete groups.'
          : describeWriteFailure(err, 'That could not be checked before deleting.')
      )
      return
    }
    if (!preview || preview.error) {
      setError(deleteRefusalMessage(preview?.error ?? 'unknown', preview || {}))
      return
    }
    setPendingDelete(preview)
  }

  function deleteAll() {
    setPendingDeleteAll(true)
  }

  async function confirmDeleteAll() {
    setDeletingAll(true)
    try {
      // Re-fetch immediately before building the id list rather than using the
      // closed-over `groups` state — if another device synced in new groups
      // between page-load and this click, the stale in-memory snapshot would
      // silently skip them with no indication anything was missed.
      const freshGroups = await localClient.list('groups')
      const ids = (freshGroups || [])
        .filter(g => g.camp_id === campId)
        .map(g => g.id)
      const { succeeded, failed, failedDueToRole } = await repository.deleteAllRecords('groups', ids)
      await load()
      if (failed > 0) {
        setError(
          failedDueToRole
            ? 'Only an admin can delete groups — no groups were deleted.'
            : `Deleted ${succeeded} of ${ids.length} groups (${failed} failed — see console).`
        )
      }
    } catch (err) {
      setError(describeWriteFailure(err, 'Those groups could not be deleted.'))
    } finally {
      setDeletingAll(false)
      setPendingDeleteAll(false)
    }
  }

  function downloadTemplate() {
    const ws = aoaToSanitizedSheet([
      ['name', 'tier_name', 'availability'],
      ['Yeladim 1', 'Yeladim', 'all'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Groups')
    XLSX.writeFile(wb, 'groups_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }).map(unescapeRow)
      const tierMap = Object.fromEntries(tiers.map(t => [t.name.toLowerCase(), t.id]))
      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        const tierName = String(r.tier_name || '').trim()
        const avail = String(r.availability || 'all').trim().toLowerCase()
        let warning = null
        if (!name) warning = 'Missing name'
        const tierId = tierName ? tierMap[tierName.toLowerCase()] : null
        if (tierName && !tierId) warning = `Age Division "${tierName}" not found`
        const availability = ['all','morning','afternoon'].includes(avail) ? avail : 'all'
        return { name, tierName, tierId: tierId || null, availability, warning }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    const existingNames = new Set(groups.map(g => g.name.toLowerCase()))
    let added = 0, skipped = 0
    for (const row of importRows) {
      if (!row.name || row.warning) { skipped++; continue }
      if (existingNames.has(row.name.toLowerCase())) { skipped++; continue }
      try {
        const id = crypto.randomUUID()
        // `name` first — same collision-fails-atomically reasoning as
        // addGroup. createRecord does the write-then-cleanup-on-failure dance.
        await repository.createRecord('groups', id, {
          name: row.name,
          camp_id: campId,
          tier_id: row.tierId,
          availability: row.availability,
        })
        added++
      } catch (err) {
        console.error(`Failed to import group "${row.name}"`, err)
        skipped++
      }
    }
    setImportResult({ added, skipped }); setImportStep('done')
    setImporting(false); await load()
  }

  // Group by tier
  const grouped = {}
  const noTier = []
  for (const g of groups) {
    if (g.tier_id) {
      if (!grouped[g.tier_id]) grouped[g.tier_id] = []
      grouped[g.tier_id].push(g)
    } else {
      noTier.push(g)
    }
  }

  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)

  const currentWeek = weeks.find(w => w.id === weekId)

  return (
    <>
    {weeks.length > 0 && (
      <WeekContextBar
        weekId={weekId}
        weeks={weeks}
        onSelectWeek={onSelectWeek}
        exclusionCount={excludedGroupIds.size}
        totalCount={groups.length}
        entityLabel="groups"
      />
    )}
    <SetupScreenShell
      countLabel={`${groups.length} group${groups.length !== 1 ? 's' : ''}`}
      role={role}
      actions={{ onDownloadTemplate: downloadTemplate, onImport: () => fileRef.current.click(), onDeleteAll: deleteAll }}
      fileInputRef={fileRef}
      onFileChange={onFileChange}
      maxWidth={720}
      nextLabel="Next: Days →"
      onNext={() => onNavigate('days')}
      error={error}
    >
      {tiers.length === 0 && !loading && (
        <div style={{ background: '#FFF8E7', border: '1px solid #F5A623', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#7a5100' }}>
          No age divisions found. Set up age divisions first so you can assign groups to them.
        </div>
      )}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', marginBottom: 16 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Age Division</th>
                <th style={S.th}>Availability</th>
                {weekId && <th style={{ ...S.th, textAlign: 'center' }}>{currentWeek?.name ?? 'Week'}</th>}
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr><td colSpan={weekId ? 5 : 4} style={S.emptyState}>
                  <div style={S.emptyStateTitle}>No groups yet</div>
                  <div style={S.emptyStateBody}>Add your first group below.</div>
                </td></tr>
              ) : (
                <>
                  {tiers.map(tier => {
                    const tierGroups = grouped[tier.id] || []
                    if (!tierGroups.length) return null
                    return (
                      <React.Fragment key={tier.id}>
                        <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                          <td colSpan={weekId ? 5 : 4} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                            {tier.name}
                          </td>
                        </tr>
                        {tierGroups.map(g => (
                          <GroupRow key={g.id} group={g} tiers={tiers} role={role} onSave={saveGroup} onDelete={deleteGroup} onHistory={setHistoryFor} weekToggle={weekId ? <td style={{ ...S.td, textAlign: 'center' }}><WeekToggle on={!excludedGroupIds.has(g.id)} label={excludedGroupIds.has(g.id) ? `Off in ${currentWeek?.name ?? 'this week'}` : `Runs in ${currentWeek?.name ?? 'this week'}`} onToggle={() => handleToggleExclusion(g, excludedGroupIds.has(g.id))} /></td> : null} />
                        ))}
                      </React.Fragment>
                    )
                  })}
                  {noTier.length > 0 && (
                    <>
                      <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                        <td colSpan={weekId ? 5 : 4} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                          No Age Division
                        </td>
                      </tr>
                      {noTier.map(g => (
                        <GroupRow key={g.id} group={g} tiers={tiers} role={role} onSave={saveGroup} onDelete={deleteGroup} onHistory={setHistoryFor} weekToggle={weekId ? <td style={{ ...S.td, textAlign: 'center' }}><WeekToggle on={!excludedGroupIds.has(g.id)} label={excludedGroupIds.has(g.id) ? `Off in ${currentWeek?.name ?? 'this week'}` : `Runs in ${currentWeek?.name ?? 'this week'}`} onToggle={() => handleToggleExclusion(g, excludedGroupIds.has(g.id))} /></td> : null} />
                      ))}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Add Group</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="Group name" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGroup()} style={{ ...S.input, flex: '1 1 160px', minWidth: 120 }} />
          <select value={newTierId} onChange={e => setNewTierId(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGroup()} style={{ ...S.input, flex: '0 0 140px' }}>
            <option value="">— No age division —</option>
            {tiers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select value={newAvail} onChange={e => setNewAvail(e.target.value)} onKeyDown={e => e.key === 'Enter' && addGroup()} style={{ ...S.input, flex: '0 0 150px' }}>
            {AVAIL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="press-97" onClick={addGroup} disabled={adding || !newName.trim()} style={{ ...S.btnPrimary, flexShrink: 0 }}>
            {adding ? 'Adding…' : '+ Add'}
          </button>
        </div>
      </div>
      </SetupScreenShell>

      <ImportModal
        step={importStep}
        title={importStep === 'done' ? 'Import Complete' : 'Import Preview'}
        width={560}
        columns={[{ key: 'name', label: 'Name' }, { key: 'tier', label: 'Age Division' }, { key: 'availability', label: 'Availability' }, { key: 'status', label: 'Status' }]}
        rows={importRows}
        readyCount={readyRows.length}
        warnCount={warnRows.length}
        result={importResult}
        importing={importing}
        onConfirm={confirmImport}
        onCancel={() => { setImportStep(null); setImportRows([]) }}
        previewSubtitle={<>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings (skipped)`}</>}
        renderCell={(r, c) => {
          if (c.key === 'name') return r.name || <span style={{ color: 'var(--warning)' }}>—</span>
          if (c.key === 'tier') return r.tierName || '—'
          if (c.key === 'availability') return AVAIL_OPTIONS.find(o => o.value === r.availability)?.label ?? '—'
          if (c.key === 'status') return <span style={r.warning ? S.importWarnText : { color: 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</span>
        }}
      />

      {pendingDelete && (
        <DeleteRecordDialog
          preview={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDeleted={() => { setPendingDelete(null); load() }}
        />
      )}

      {pendingDeleteAll && (
        <ConfirmDangerDialog
          title="Delete all groups?"
          recovery="They can be restored from Trash."
          confirmLabel="Delete All Groups"
          busy={deletingAll}
          onConfirm={confirmDeleteAll}
          onCancel={() => setPendingDeleteAll(false)}
        />
      )}

      {historyFor && (
        <RecordHistory
          entity="groups"
          entityId={historyFor.id}
          name={historyFor.name}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {pendingExclusion && (
        <ExclusionConfirmDialog
          entityName={pendingExclusion.group.name}
          weekName={currentWeek?.name ?? 'this week'}
          slotCount={pendingExclusion.slotCount}
          onCancel={() => setPendingExclusion(null)}
          onConfirm={confirmExclusion}
        />
      )}
    </>
  )
}

function WeekToggle({ on, label, onToggle }) {
  const reduced = prefersReducedMotion()
  const W = 32, H = 18, PAD = 2, KNOB = H - PAD * 2
  const knobLeft = on ? W - KNOB - PAD : PAD
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: W,
        height: H,
        borderRadius: H / 2,
        background: on ? 'var(--primary)' : 'var(--border)',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        position: 'relative',
        transition: reduced ? 'none' : 'background-color 120ms ease',
        flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        left: knobLeft,
        top: PAD,
        width: KNOB,
        height: KNOB,
        borderRadius: '50%',
        background: '#fff',
        transition: reduced ? 'none' : 'left 120ms ease',
      }} />
    </button>
  )
}

