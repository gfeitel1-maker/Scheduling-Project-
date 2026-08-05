import { describeWriteFailure } from '../../utils/writeErrorMessage'

// Week mutation orchestration: create/rename/archive/unarchive/duplicate/delete,
// over the T28 repository + localClient (duplicateWeek/deleteWeek are multi-entity
// cascading Host transactions, not field writes — see docs/adr/2026-08-04-
// repository-layer-policy.md, hence localClient is injected directly rather than
// wrapped in a repo pass-through).
export function useWeeks({ weeks, setWeeks, repo, localClient, campId, weekId, setPreferredWeekId, setActionError }) {
  async function createWeek(name) {
    const wid = crypto.randomUUID()
    const sortOrder = weeks.length > 0 ? Math.max(...weeks.map(w => w.sort_order ?? 0)) + 1 : 0
    setActionError(null)
    try {
      await repo.createWeek(wid, { campId, name, sortOrder })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That week could not be created.'))
      return
    }
    setWeeks(prev => [...prev, { id: wid, camp_id: campId, name, sort_order: sortOrder, is_archived: 0 }])
    setPreferredWeekId(wid)
  }

  async function renameWeek(id, name) {
    setActionError(null)
    try {
      await repo.writeWeekFields(id, { name })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That name could not be saved.'))
      return
    }
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, name } : w)))
  }

  async function archiveWeek(id) {
    setActionError(null)
    try {
      await repo.writeWeekFields(id, { is_archived: '1' })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That week could not be archived.'))
      return
    }
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, is_archived: 1 } : w)))
    if (weekId === id) {
      setPreferredWeekId(fallbackWeekId(weeks.filter(w => w.id !== id), { allowArchived: false }))
    }
  }

  async function unarchiveWeek(id) {
    setActionError(null)
    try {
      await repo.writeWeekFields(id, { is_archived: '0' })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That week could not be brought back.'))
      return
    }
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, is_archived: 0 } : w)))
  }

  async function duplicateWeek(sourceId) {
    setActionError(null)
    let result
    try {
      result = await localClient.duplicateWeek(sourceId, campId)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That week could not be duplicated.'))
      return
    }
    if (result?.ok) {
      const freshWeeks = await repo.loadWeeks()
      const camp = freshWeeks.filter(w => w.camp_id === campId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      setWeeks(camp)
    } else {
      setActionError(describeWriteFailure(result?.error ? new Error(result.error) : undefined, 'That week could not be duplicated.'))
    }
    return result
  }

  function confirmDeleteWeek(id) {
    setWeeks(prev => {
      const remaining = prev.filter(w => w.id !== id)
      if (weekId === id) {
        setPreferredWeekId(fallbackWeekId(remaining, { allowArchived: true }))
      }
      return remaining
    })
  }

  return { createWeek, renameWeek, archiveWeek, unarchiveWeek, duplicateWeek, confirmDeleteWeek }
}

// Archive (non-destructive, reversible) never falls back to an archived week —
// landing nowhere (null) is fine because the director can un-archive to get back.
// Delete (destructive, irreversible) prefers a non-archived week but falls back to
// remaining[0] even if archived, reaching null only when nothing remains — landing
// the director somewhere beats a blank screen after an action they can't undo.
// This divergence is intentional; do not normalize the two behaviours.
function fallbackWeekId(remaining, { allowArchived }) {
  const nonArchived = remaining.find(w => String(w.is_archived) !== '1')
  if (nonArchived) return nonArchived.id
  return allowArchived ? (remaining[0]?.id ?? null) : null
}
