import { localClient } from '../../localClient'

async function writeField(entity, id, field, value) {
  const token = localStorage.getItem('shoresh-token')
  const result = await localClient.write(token, entity, id, field, value)
  if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
    throw new Error(`write failed for field "${field}"`)
  }
}

// The one copy path behind both "Start from your time blocks?" (right after a
// Special Day is created) and the Copy time blocks action on an empty special
// schedule. Sequential writes, not a transaction: on a failure the thrown error
// carries how many blocks landed so the caller can say so (seedFailureMessage).
export async function copyCampTimeBlocks({ campId, specialDayId }) {
  let seededCount = 0
  let totalCount = 0
  try {
    const campBlocks = await localClient.list('time_blocks')
    const scoped = (campBlocks || [])
      .filter((b) => b.camp_id === campId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    totalCount = scoped.length
    for (const b of scoped) {
      const newId = crypto.randomUUID()
      await writeField('special_day_time_blocks', newId, 'special_day_id', specialDayId)
      await writeField('special_day_time_blocks', newId, 'name', b.name)
      await writeField('special_day_time_blocks', newId, 'sort_order', b.sort_order ?? 0)
      if (b.start_time) await writeField('special_day_time_blocks', newId, 'start_time', b.start_time)
      if (b.end_time) await writeField('special_day_time_blocks', newId, 'end_time', b.end_time)
      seededCount += 1
    }
  } catch (err) {
    err.seededCount = seededCount
    err.totalCount = totalCount
    throw err
  }
}
