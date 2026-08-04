// Week mutation orchestration: create/rename/archive/unarchive/duplicate/delete,
// over the T28 repository + localClient (duplicateWeek/deleteWeek are multi-entity
// cascading Host transactions, not field writes — see docs/adr/2026-08-04-
// repository-layer-policy.md, hence localClient is injected directly rather than
// wrapped in a repo pass-through).
//
// None of the six handlers below catches a write failure — the optimistic update
// already lands even if repo.createWeek/writeWeekFields subsequently rejects.
// Filed as a separate ticket; out of scope for this pure code-motion refactor.
export function useWeeks({ weeks, setWeeks, repo, localClient, campId, weekId, setPreferredWeekId }) {
  async function createWeek(name) {
    const wid = crypto.randomUUID()
    const sortOrder = weeks.length > 0 ? Math.max(...weeks.map(w => w.sort_order ?? 0)) + 1 : 0
    await repo.createWeek(wid, { campId, name, sortOrder })
    setWeeks(prev => [...prev, { id: wid, camp_id: campId, name, sort_order: sortOrder, is_archived: 0 }])
    setPreferredWeekId(wid)
  }

  async function renameWeek(id, name) {
    await repo.writeWeekFields(id, { name })
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, name } : w)))
  }

  async function archiveWeek(id) {
    await repo.writeWeekFields(id, { is_archived: '1' })
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, is_archived: 1 } : w)))
    if (weekId === id) {
      setPreferredWeekId(fallbackWeekId(weeks.filter(w => w.id !== id), { allowArchived: false }))
    }
  }

  async function unarchiveWeek(id) {
    await repo.writeWeekFields(id, { is_archived: '0' })
    setWeeks(prev => prev.map(w => (w.id === id ? { ...w, is_archived: 0 } : w)))
  }

  async function duplicateWeek(sourceId) {
    const result = await localClient.duplicateWeek(sourceId, campId)
    if (result?.ok) {
      const freshWeeks = await repo.loadWeeks()
      const camp = freshWeeks.filter(w => w.camp_id === campId).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      setWeeks(camp)
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
