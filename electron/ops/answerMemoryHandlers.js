// IPC-facing handlers for import answer memory. Every one goes through the injected authorize
// (requireAuthorized in main.js) before it reads or writes anything; the camp is always the
// device's own (`SELECT ... FROM camps LIMIT 1`), and a camp_id or kind in a payload is never read.
import {
  matchImportAnswers, rememberImportAnswers, listLearned, changeAnswer, forgetAnswer, forgetPattern, keepAnswer,
} from './answerMemory.js'

const MAX_ITEMS = 5000
const isNonEmptyString = (s) => typeof s === 'string' && s.length > 0

export function createAnswerMemoryHandlers({ db, deviceId, authorize }) {
  const campId = () => {
    const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
    if (!camp) throw new Error('no camp on this device')
    return camp.id
  }
  const gate = (token, action) => {
    if (!isNonEmptyString(token)) throw new Error('token is required')
    return authorize(token, action)
  }
  const list = (value, name) => {
    if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error(`${name} must be an array of at most ${MAX_ITEMS}`)
    return value
  }
  const idArg = (value) => {
    if (!isNonEmptyString(value) || value.length > 256) throw new Error('memoryId is required')
    return value
  }

  return {
    matchImportAnswers({ token, decisions, others, suppressed, mode } = {}) {
      const session = gate(token, 'import_answers.read')
      const recalled = matchImportAnswers(db, {
        campId: campId(),
        decisions: list(decisions ?? [], 'decisions'),
        others: list(others ?? [], 'others'),
        suppressed: Array.isArray(suppressed) ? suppressed.filter((s) => typeof s === 'string') : [],
        mode: mode === 'replace' ? 'replace' : 'add',
      })
      for (const r of Object.values(recalled)) {
        if (r && r.answeredBy !== undefined) r.answeredByYou = r.answeredBy === session.userId
      }
      return recalled
    },
    rememberImportAnswers({ token, importId, entries } = {}) {
      const session = gate(token, 'import_answers.write')
      return rememberImportAnswers(db, {
        campId: campId(), authorUserId: session.userId, deviceId,
        importId: typeof importId === 'string' ? importId.slice(0, 64) : null,
        entries: list(entries, 'entries'),
      })
    },
    listLearned({ token } = {}) {
      const session = gate(token, 'import_answers.read')
      return { ...listLearned(db, { campId: campId(), viewerUserId: session.userId }), viewerUserId: session.userId }
    },
    changeImportAnswer({ token, memoryId, verdict } = {}) {
      const session = gate(token, 'import_answers.write')
      return changeAnswer(db, { campId: campId(), authorUserId: session.userId, deviceId, memoryId: idArg(memoryId), verdict })
    },
    forgetImportAnswer({ token, memoryId } = {}) {
      const session = gate(token, 'import_answers.write')
      return forgetAnswer(db, { campId: campId(), authorUserId: session.userId, deviceId, memoryId: idArg(memoryId) })
    },
    forgetImportPattern({ token, template, key } = {}) {
      const session = gate(token, 'import_answers.write')
      return forgetPattern(db, { campId: campId(), authorUserId: session.userId, deviceId, template, key })
    },
    keepImportAnswer({ token, memoryId } = {}) {
      const session = gate(token, 'import_answers.write')
      return keepAnswer(db, { campId: campId(), authorUserId: session.userId, deviceId, memoryId: idArg(memoryId) })
    },
  }
}
