import React, { useState, useEffect, useRef } from 'react'
import * as XLSX from 'xlsx'
import { localClient } from '../localClient'
import { S } from '../styles/shared'

const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

// operations.value only accepts strings/null (better-sqlite3 throws on a raw
// boolean/array) — every write must pre-serialize through these before
// hitting localClient.write. Reads go through normalizeActivity below.
const BOOL_FIELDS = new Set(['is_outdoor', 'same_tier_only'])
const ARRAY_FIELDS = new Set(['eligible_tier_ids', 'eligible_group_ids'])

function serializeFieldValue(field, value) {
  if (BOOL_FIELDS.has(field)) return value ? 1 : 0
  if (ARRAY_FIELDS.has(field)) return JSON.stringify(value ?? [])
  return value ?? null
}

// Defense-in-depth: malformed JSON in an eligible_*_ids column (e.g. from a
// corrupted/tampered op) must not crash the list render — default to [].
function parseIdList(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeActivity(row) {
  return {
    ...row,
    is_outdoor: row.is_outdoor === 1 || row.is_outdoor === true,
    same_tier_only: row.same_tier_only === 1 || row.same_tier_only === true,
    max_groups_per_slot: row.max_groups_per_slot ?? 1,
    min_per_week: row.min_per_week ?? 0,
    max_per_week: row.max_per_week ?? 5,
    span_blocks: row.span_blocks ?? 1,
    priority: row.priority || 'low',
    eligible_tier_ids: parseIdList(row.eligible_tier_ids),
    eligible_group_ids: parseIdList(row.eligible_group_ids),
  }
}

function ActivityModal({ activity, tiers, groups, activities, onSave, onClose }) {
  const isNew = !activity?.id
  const [name, setName] = useState(activity?.name || '')
  const [location, setLocation] = useState(activity?.location || '')
  const [isOutdoor, setIsOutdoor] = useState(activity?.is_outdoor || false)
  const [maxGroups, setMaxGroups] = useState(activity?.max_groups_per_slot ?? 1)
  const [minWeek, setMinWeek] = useState(activity?.min_per_week ?? 0)
  const [maxWeek, setMaxWeek] = useState(activity?.max_per_week ?? 5)
  const [sameTier, setSameTier] = useState(activity?.same_tier_only || false)
  const [priority, setPriority] = useState(activity?.priority || 'low')
  const [eligTiers, setEligTiers] = useState(activity?.eligible_tier_ids || [])
  const [groupOverride, setGroupOverride] = useState((activity?.eligible_group_ids || []).length > 0)
  const [eligGroups, setEligGroups] = useState(activity?.eligible_group_ids || [])
  const [preferDay, setPreferDay] = useState(activity?.prefer_before_day != null)
  const [preferDayVal, setPreferDayVal] = useState(activity?.prefer_before_day ?? 5)
  const [preferMin, setPreferMin] = useState(activity?.prefer_before_day_min ?? 2)
  const [weatherAlt, setWeatherAlt] = useState(activity?.weather_alternative_id || '')
  const [notes, setNotes] = useState(activity?.notes || '')
  const [spanBlocks, setSpanBlocks] = useState(activity?.span_blocks ?? 1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  function toggleTier(id) { setEligTiers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) }
  function toggleGroup(id) { setEligGroups(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    setSaveError(null)
    const record = {
      name: name.trim(), location: location.trim() || null, is_outdoor: isOutdoor,
      max_groups_per_slot: Number(maxGroups), min_per_week: Number(minWeek), max_per_week: Number(maxWeek), span_blocks: Number(spanBlocks),
      same_tier_only: sameTier, priority,
      eligible_tier_ids: eligTiers, eligible_group_ids: groupOverride ? eligGroups : [],
      prefer_before_day: preferDay ? Number(preferDayVal) : null,
      prefer_before_day_min: preferDay ? Number(preferMin) : null,
      weather_alternative_id: weatherAlt || null,
      notes: notes.trim() || null,
    }
    try {
      // onSave must re-throw on failure — that's what keeps saveError
      // (rather than a silent modal close) visible to the user.
      await onSave(activity?.id || null, record)
    } catch {
      setSaveError('Failed to save — check your connection and try again')
      setSaving(false)
      return
    }
    setSaving(false)
  }

  const otherActivities = activities.filter(a => a.id !== activity?.id)

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000, padding: '24px 16px', overflowY: 'auto' }}>
      <div style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 600, maxWidth: '100%' }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 18, marginBottom: 20 }}>
          {isNew ? 'Add Activity' : `Edit: ${activity.name}`}
        </div>

        <div style={grid2}>
          <Field label="Name">
            <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} style={S.input} placeholder="Activity name" />
          </Field>
          <Field label="Location">
            <input value={location} onChange={e => setLocation(e.target.value)} style={S.input} placeholder="e.g. Pool, Gym" />
          </Field>
        </div>

        <div style={{ display: 'flex', gap: 24, marginBottom: 16, flexWrap: 'wrap' }}>
          <label style={checkLabel}><input type="checkbox" checked={isOutdoor} onChange={e => setIsOutdoor(e.target.checked)} style={{ marginRight: 6 }} />Outdoor activity</label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={checkLabel}>
            <input type="checkbox" checked={maxGroups > 1} onChange={e => {
              if (e.target.checked) { setMaxGroups(prev => Math.max(2, Number(prev))); }
              else { setMaxGroups(1); setSameTier(false); }
            }} style={{ marginRight: 6 }} />
            Allow multiple groups at this activity at the same time
          </label>
          {maxGroups > 1 && (
            <div style={{ paddingLeft: 22, marginTop: 10, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <Field label="Max groups at once">
                <input type="number" min={2} value={maxGroups} onChange={e => setMaxGroups(Math.max(2, Number(e.target.value)))} style={{ ...S.input, width: 80 }} />
              </Field>
              <div style={{ paddingTop: 22 }}>
                <label style={checkLabel}>
                  <input type="checkbox" checked={sameTier} onChange={e => setSameTier(e.target.checked)} style={{ marginRight: 6 }} />
                  Groups must be from the same unit
                </label>
              </div>
            </div>
          )}
        </div>

        <div style={grid3}>
          <Field label="Min per week">
            <input type="number" min={0} value={minWeek} onChange={e => setMinWeek(e.target.value)} style={S.input} />
          </Field>
          <Field label="Max per week">
            <input type="number" min={0} value={maxWeek} onChange={e => setMaxWeek(e.target.value)} style={S.input} />
          </Field>
          <Field label="Blocks per session">
            <input type="number" min={1} value={spanBlocks} onChange={e => setSpanBlocks(Math.max(1, Number(e.target.value)))} style={S.input} />
          </Field>
        </div>

        <Field label="Scheduling Priority">
          <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content' }}>
            {['high','low'].map(p => (
              <button key={p} onClick={() => setPriority(p)} style={{
                padding: '7px 20px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: priority === p ? 'var(--primary)' : 'var(--surface)',
                color: priority === p ? '#fff' : 'var(--text)',
              }}>{p.charAt(0).toUpperCase() + p.slice(1)}</button>
            ))}
          </div>
        </Field>

        <Field label="Eligible Units (leave all unchecked = eligible for all)">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
            {tiers.length === 0 ? <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No units set up yet</span> : tiers.map(t => (
              <label key={t.id} style={checkLabel}>
                <input type="checkbox" checked={eligTiers.includes(t.id)} onChange={() => toggleTier(t.id)} style={{ marginRight: 5 }} />{t.name}
              </label>
            ))}
          </div>
        </Field>

        <label style={{ ...checkLabel, display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <input type="checkbox" checked={groupOverride} onChange={e => setGroupOverride(e.target.checked)} />
          Override by specific groups
        </label>
        {groupOverride && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', paddingLeft: 8, marginBottom: 16 }}>
            {groups.map(g => (
              <label key={g.id} style={checkLabel}>
                <input type="checkbox" checked={eligGroups.includes(g.id)} onChange={() => toggleGroup(g.id)} style={{ marginRight: 5 }} />{g.name}
              </label>
            ))}
          </div>
        )}

        <label style={{ ...checkLabel, display: 'flex', alignItems: 'center', marginBottom: 8, gap: 8 }}>
          <input type="checkbox" checked={preferDay} onChange={e => setPreferDay(e.target.checked)} />
          Distribute early in the week
        </label>
        {preferDay && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', paddingLeft: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>At least</span>
            <input type="number" min={1} value={preferMin} onChange={e => setPreferMin(e.target.value)} style={{ ...S.input, width: 60 }} />
            <span style={{ fontSize: 13 }}>times before</span>
            <select value={preferDayVal} onChange={e => setPreferDayVal(e.target.value)} style={{ ...S.input, width: 130 }}>
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </div>
        )}

        <Field label="Weather alternative (shown when weather mode is on)">
          <select value={weatherAlt} onChange={e => setWeatherAlt(e.target.value)} style={S.input}>
            <option value="">— None —</option>
            {otherActivities.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>

        <Field label="Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...S.input, resize: 'vertical' }} />
        </Field>

        {saveError && (
          <div style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 10, padding: '8px 10px', background: '#fff5f5', borderRadius: 5, border: '1px solid #f5c6c6' }}>
            {saveError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button onClick={onClose} style={S.btnSecondary}>Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} style={S.btnPrimary}>{saving ? 'Saving…' : isNew ? 'Add Activity' : 'Save Changes'}</button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

export default function ActivitiesScreen({ campId, role, onNavigate }) {
  const [activities, setActivities] = useState([])
  const [tiers, setTiers] = useState([])
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(null) // null | { activity } — activity=null means new
  const [importStep, setImportStep] = useState(null)
  const [importRows, setImportRows] = useState([])
  const [importResult, setImportResult] = useState(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef()

  useEffect(() => { load() }, [campId])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [aData, tData, gData] = await Promise.all([
        localClient.list('activities'),
        localClient.list('tiers'),
        localClient.list('groups'),
      ])
      const list = (aData || [])
        .filter(a => a.camp_id === campId)
        .map(normalizeActivity)
        .sort((a, b) =>
          (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) ||
          String(a.name ?? '').localeCompare(String(b.name ?? ''))
        )
      setActivities(list)
      setTiers((tData || []).filter(t => t.camp_id === campId))
      setGroups((gData || []).filter(g => g.camp_id === campId))
    } catch {
      setError('Failed to load data — check your connection and refresh')
    } finally {
      setLoading(false)
    }
  }

  // Fires one write() per field (the op-log is field-level) and surfaces
  // the first failure rather than a silent partial write — see
  // TiersScreen.jsx's identical helper. Boolean/array fields are serialized
  // here since operations.value only accepts strings/null.
  async function writeFields(id, fields) {
    const token = localStorage.getItem('shoresh-token')
    for (const [field, value] of Object.entries(fields)) {
      const result = await localClient.write(token, 'activities', id, field, serializeFieldValue(field, value))
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  async function cleanupPartialRow(id) {
    try {
      const token = localStorage.getItem('shoresh-token')
      await localClient.deleteEntity(token, 'activities', id)
    } catch {
      // best-effort only
    }
  }

  // Called by ActivityModal. Re-throws on failure so the modal's own
  // saveError state stays visible instead of silently closing.
  async function saveActivity(id, fields) {
    const { name, ...rest } = fields
    const trimmedName = String(name ?? '').trim()
    if (!id && activities.some(a => String(a.name ?? '').trim().toLowerCase() === trimmedName.toLowerCase())) {
      const err = new Error('An activity with this name already exists')
      setError('An activity with this name already exists — choose a different name.')
      throw err
    }
    try {
      if (id) {
        // `name` written first — a UNIQUE(camp_id, name) collision on the
        // `name` write fails atomically before any other field commits.
        await writeFields(id, { name: trimmedName, ...rest })
      } else {
        const newId = crypto.randomUUID()
        try {
          await writeFields(newId, { name: trimmedName, camp_id: campId, ...rest })
        } catch (err) {
          await cleanupPartialRow(newId)
          throw err
        }
      }
      await load()
      setModal(null)
    } catch (err) {
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? 'An activity with this name already exists — choose a different name.'
          : 'Failed to save activity — check your connection and try again'
      )
      throw err
    }
  }

  async function deleteActivity(id) {
    if (!window.confirm('Delete this activity?')) return
    try {
      const token = localStorage.getItem('shoresh-token')
      const result = await localClient.deleteEntity(token, 'activities', id)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
      await load()
    } catch (err) {
      setError(
        /admin role required/i.test(err?.message ?? '')
          ? "You don't have permission to do this."
          : 'Failed to delete activity — check your connection and try again'
      )
    }
  }

  // Ported to the same writeFields-based pattern as addActivity/confirmImport
  // rather than a special-cased raw insert.
  async function duplicateActivity(a) {
    // "Copy of X" is a deterministic, guessable collision target — a
    // director duplicating the same activity twice hits this every time,
    // so it needs the same pre-check + UNIQUE-aware error copy as
    // saveActivity's create path, not just a generic connection-error
    // fallback (Red Hat finding, Sub-plan C Task 5 round 1).
    let copyName = `Copy of ${a.name}`
    if (activities.some(x => String(x.name ?? '').trim().toLowerCase() === copyName.toLowerCase())) {
      setError(`An activity named "${copyName}" already exists — rename it before duplicating again.`)
      return
    }
    const newId = crypto.randomUUID()
    try {
      await writeFields(newId, {
        name: copyName,
        camp_id: campId,
        location: a.location,
        is_outdoor: a.is_outdoor,
        max_groups_per_slot: a.max_groups_per_slot,
        min_per_week: a.min_per_week,
        max_per_week: a.max_per_week,
        span_blocks: a.span_blocks,
        same_tier_only: a.same_tier_only,
        priority: a.priority,
        eligible_tier_ids: a.eligible_tier_ids,
        eligible_group_ids: a.eligible_group_ids,
        prefer_before_day: a.prefer_before_day,
        prefer_before_day_min: a.prefer_before_day_min,
        weather_alternative_id: a.weather_alternative_id,
        notes: a.notes,
      })
      await load()
    } catch (err) {
      await cleanupPartialRow(newId)
      setError(
        /UNIQUE/i.test(err?.message ?? '')
          ? `An activity named "${copyName}" already exists — rename it before duplicating again.`
          : 'Failed to duplicate activity — check your connection and try again'
      )
    }
  }

  async function deleteAll() {
    if (!window.confirm('Delete all activities? This cannot be undone.')) return
    const token = localStorage.getItem('shoresh-token')
    // Re-fetch immediately before building the id list rather than using the
    // closed-over `activities` state — if another device synced in new
    // activities between page-load and this click, the stale in-memory
    // snapshot would silently skip them with no indication anything was missed.
    const freshActivities = await localClient.list('activities')
    const ids = (freshActivities || []).filter(a => a.camp_id === campId).map(a => a.id)
    let succeeded = 0
    let failedDueToRole = false
    for (const id of ids) {
      try {
        const result = await localClient.deleteEntity(token, 'activities', id)
        if (result && (result.status === 'applied' || result.status === 'queued')) {
          succeeded++
        }
      } catch (err) {
        if (/admin role required/i.test(err?.message ?? '')) failedDueToRole = true
      }
    }
    await load()
    const failed = ids.length - succeeded
    if (failed > 0) {
      setError(
        failedDueToRole
          ? 'Only an admin can delete activities — no activities were deleted.'
          : `Deleted ${succeeded} of ${ids.length} activities — please try again for the rest.`
      )
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['name','location','is_outdoor','max_groups_per_slot','min_per_week','max_per_week','same_tier_only','priority','eligible_tiers','prefer_before_day','prefer_before_day_min','weather_alternative','notes'],
      ['Water Play','Pool Deck','TRUE',2,1,3,'FALSE','high','Yeladim,Tzofim','Friday',2,'',''],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Activities')
    XLSX.writeFile(wb, 'activities_template.xlsx')
  }

  function onFileChange(e) {
    const file = e.target.files[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const wb = XLSX.read(ev.target.result, { type: 'array' })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      const tierMap = Object.fromEntries(tiers.map(t => [t.name.toLowerCase(), t.id]))
      const actMap = Object.fromEntries(activities.map(a => [a.name.toLowerCase(), a.id]))
      const dowMap = Object.fromEntries(DOW.map((d, i) => [d.toLowerCase(), i]))

      const parsed = rows.map(r => {
        const name = String(r.name || '').trim()
        let warning = null
        if (!name) warning = 'Missing name'

        const eligTierRaw = String(r.eligible_tiers || '').trim().toLowerCase()
        const eligTierNames = eligTierRaw === 'all' || eligTierRaw === ''
          ? []
          : eligTierRaw.split(',').map(s => s.trim()).filter(Boolean)
        const eligible_tier_ids = eligTierNames.map(n => tierMap[n]).filter(Boolean)
        if (eligTierNames.length && eligible_tier_ids.length < eligTierNames.length) {
          const missing = eligTierNames.filter(n => !tierMap[n])
          warning = warning || `Unit(s) not found: ${missing.join(', ')}`
        }

        const weatherName = String(r.weather_alternative || '').trim()
        const weather_alternative_id = weatherName ? actMap[weatherName.toLowerCase()] || null : null
        if (weatherName && !weather_alternative_id) warning = warning || `Weather alt "${weatherName}" not found`

        const preferDayStr = String(r.prefer_before_day || '').trim()
        const prefer_before_day = preferDayStr ? (dowMap[preferDayStr.toLowerCase()] ?? null) : null

        return {
          name,
          location: String(r.location || '').trim() || null,
          is_outdoor: String(r.is_outdoor || '').toUpperCase() === 'TRUE',
          max_groups_per_slot: Number(r.max_groups_per_slot) || 1,
          min_per_week: Number(r.min_per_week) || 0,
          max_per_week: Number(r.max_per_week) || 5,
          same_tier_only: String(r.same_tier_only || '').toUpperCase() === 'TRUE',
          priority: ['high','low'].includes(String(r.priority).toLowerCase()) ? String(r.priority).toLowerCase() : 'low',
          eligible_tier_ids,
          eligible_group_ids: [],
          prefer_before_day,
          prefer_before_day_min: r.prefer_before_day_min !== '' ? Number(r.prefer_before_day_min) : null,
          weather_alternative_id,
          notes: String(r.notes || '').trim() || null,
          warning,
        }
      })
      setImportRows(parsed); setImportStep('preview')
    }
    reader.readAsArrayBuffer(file); e.target.value = ''
  }

  async function confirmImport() {
    setImporting(true)
    try {
      // Defense-in-depth: a stray malformed row here must not throw and
      // wedge the modal on "Importing…" forever.
      const existingNames = new Set(activities.map(a => String(a.name ?? '').toLowerCase()))
      let added = 0, skipped = 0
      for (const row of importRows) {
        if (!row.name || row.warning) { skipped++; continue }
        const lower = String(row.name).toLowerCase()
        if (existingNames.has(lower)) { skipped++; continue }
        const newId = crypto.randomUUID()
        try {
          // `name` first — same collision-fails-atomically reasoning as saveActivity.
          await writeFields(newId, {
            name: row.name,
            camp_id: campId,
            location: row.location,
            is_outdoor: row.is_outdoor,
            max_groups_per_slot: row.max_groups_per_slot,
            min_per_week: row.min_per_week,
            max_per_week: row.max_per_week,
            same_tier_only: row.same_tier_only,
            priority: row.priority,
            eligible_tier_ids: row.eligible_tier_ids,
            eligible_group_ids: row.eligible_group_ids,
            prefer_before_day: row.prefer_before_day,
            prefer_before_day_min: row.prefer_before_day_min,
            weather_alternative_id: row.weather_alternative_id,
            notes: row.notes,
          })
        } catch {
          await cleanupPartialRow(newId)
          skipped++
          continue
        }
        added++
        existingNames.add(lower)
      }
      setImportResult({ added, skipped })
      setImportStep('done')
    } catch {
      setError('Import failed — check your connection and try again')
      setImportStep(null); setImportRows([])
    } finally {
      setImporting(false); await load()
    }
  }

  const highPriority = activities.filter(a => a.priority === 'high')
  const lowPriority = activities.filter(a => a.priority === 'low')
  const readyRows = importRows.filter(r => r.name && !r.warning)
  const warnRows = importRows.filter(r => r.warning || !r.name)
  const actMap = Object.fromEntries(activities.map(a => [a.id, a.name]))

  return (
    <div style={{ maxWidth: 820 }}>
      {error && (
        <div style={S.errorBanner}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {activities.length} activit{activities.length !== 1 ? 'ies' : 'y'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={downloadTemplate} style={S.btnSecondary}>Download Template</button>
          <button onClick={() => fileRef.current.click()} style={S.btnSecondary}>Import from Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          <button
            onClick={deleteAll}
            disabled={role !== 'admin'}
            title={role !== 'admin' ? 'Admin only' : undefined}
            style={role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger}
          >Delete All</button>
          <button onClick={() => setModal({ activity: null })} style={S.btnPrimary}>+ Add Activity</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : activities.length === 0 ? (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px 24px', textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>No activities yet</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Add your first activity or import from Excel.</div>
        </div>
      ) : (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1.5px solid var(--border)', background: 'var(--surface-elevated)' }}>
                <th style={S.th}>Name</th>
                <th style={S.th}>Location</th>
                <th style={S.th}>Outdoor</th>
                <th style={S.th}>Co-schedule</th>
                <th style={S.th}>Min–Max/Wk</th>
                <th style={S.th}>Alt</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[{ label: 'High Priority', rows: highPriority }, { label: 'Low Priority', rows: lowPriority }].map(({ label, rows }) => {
                if (!rows.length) return null
                return (
                  <React.Fragment key={label}>
                    <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1px solid var(--border)' }}>
                      <td colSpan={7} style={{ padding: '6px 14px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--primary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</td>
                    </tr>
                    {rows.map(a => (
                      <tr key={a.id} style={{ borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <td style={{ ...S.td, fontWeight: 500 }}>{a.name}</td>
                        <td style={{ ...S.td, color: 'var(--text-secondary)', fontSize: 12 }}>{a.location || '—'}</td>
                        <td style={{ ...S.td, fontSize: 12 }}>{a.is_outdoor ? '🌤' : '—'}</td>
                        <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>
                          {a.max_groups_per_slot > 1 ? `Up to ${a.max_groups_per_slot}${a.same_tier_only ? ' (same unit)' : ''}` : '—'}
                        </td>
                        <td style={{ ...S.td, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{a.min_per_week}–{a.max_per_week}</td>
                        <td style={{ ...S.td, fontSize: 12, color: 'var(--text-secondary)' }}>{a.weather_alternative_id ? actMap[a.weather_alternative_id] || '?' : '—'}</td>
                        <td style={{ ...S.td, textAlign: 'right' }}>
                          <button onClick={() => setModal({ activity: a })} style={S.btnSecondary}>Edit</button>
                          <button onClick={() => duplicateActivity(a)} style={{ ...S.btnSecondary, marginLeft: 6 }}>Duplicate</button>
                          <button
                            onClick={() => deleteActivity(a.id)}
                            disabled={role !== 'admin'}
                            title={role !== 'admin' ? 'Admin only' : undefined}
                            style={role !== 'admin' ? { ...S.btnDanger, marginLeft: 6, ...S.buttonDisabled } : { ...S.btnDanger, marginLeft: 6 }}
                          >Delete</button>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <ActivityModal
          activity={modal.activity}
          tiers={tiers}
          groups={groups}
          activities={activities}
          onSave={saveActivity}
          onClose={() => setModal(null)}
        />
      )}

      {importStep && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 620, maxHeight: '80vh', overflow: 'auto' }}>
            {importStep === 'preview' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 4 }}>Import Preview</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>{readyRows.length} ready{warnRows.length > 0 && `, ${warnRows.length} with warnings (skipped)`}</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead><tr style={{ borderBottom: '1px solid var(--border)' }}><th style={S.th}>Name</th><th style={S.th}>Location</th><th style={S.th}>Priority</th><th style={S.th}>Status</th></tr></thead>
                  <tbody>
                    {importRows.map((r, i) => (
                      <tr key={i} style={{ background: r.warning ? '#FFF8E7' : '', borderBottom: '1px solid var(--border)' }}>
                        <td style={S.td}>{r.name || '—'}</td>
                        <td style={S.td}>{r.location || '—'}</td>
                        <td style={S.td}>{r.priority}</td>
                        <td style={{ ...S.td, color: r.warning ? '#F5A623' : 'var(--success)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.warning || '✓ Ready'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnSecondary}>Cancel</button>
                  <button onClick={confirmImport} disabled={importing || readyRows.length === 0} style={S.btnPrimary}>{importing ? 'Importing…' : `Import ${readyRows.length}`}</button>
                </div>
              </>
            )}
            {importStep === 'done' && (
              <>
                <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 17, marginBottom: 12 }}>Import Complete</div>
                <div style={{ fontSize: 14 }}><span style={{ color: 'var(--success)', fontWeight: 600 }}>{importResult.added} added</span>{importResult.skipped > 0 && <span style={{ color: 'var(--text-secondary)', marginLeft: 10 }}>{importResult.skipped} skipped</span>}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => { setImportStep(null); setImportRows([]) }} style={S.btnPrimary}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button onClick={() => onNavigate('anchors')} style={S.btnPrimary}>Next: Fixed Events →</button>
      </div>
    </div>
  )
}

const grid2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }
const grid3 = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }
const checkLabel = { fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }
