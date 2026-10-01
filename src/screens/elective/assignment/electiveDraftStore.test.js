// Board item i-elective-attendance-residuals (a) -- unit coverage for the
// in-memory, camp+set-scoped draft store. See electiveDraftStore.js for what
// it is for and why it deliberately never stores result/findings.
import { describe, it, expect, afterEach } from 'vitest'
import { getDraft, saveDraft, clearDraft, __clearAllElectiveDrafts } from './electiveDraftStore.js'

afterEach(() => __clearAllElectiveDrafts())

describe('electiveDraftStore', () => {
  it('round-trips a saved draft for a camp+set key', () => {
    const draft = { rows: [['Name']], templateId: 'tpl-1' }
    saveDraft('camp-1', 'set-1', draft)
    expect(getDraft('camp-1', 'set-1')).toEqual(draft)
  })

  it('returns null when nothing has been saved for that key', () => {
    expect(getDraft('camp-1', 'set-1')).toBeNull()
  })

  it('keys by campId AND electiveSetId -- two sets in the same camp are isolated', () => {
    saveDraft('camp-1', 'set-1', { templateId: 'tpl-1' })
    saveDraft('camp-1', 'set-2', { templateId: 'tpl-2' })
    expect(getDraft('camp-1', 'set-1')).toEqual({ templateId: 'tpl-1' })
    expect(getDraft('camp-1', 'set-2')).toEqual({ templateId: 'tpl-2' })
  })

  it('two camps using the same set id are also isolated', () => {
    saveDraft('camp-1', 'set-1', { templateId: 'tpl-1' })
    saveDraft('camp-2', 'set-1', { templateId: 'tpl-2' })
    expect(getDraft('camp-1', 'set-1')).toEqual({ templateId: 'tpl-1' })
    expect(getDraft('camp-2', 'set-1')).toEqual({ templateId: 'tpl-2' })
  })

  it('clearDraft removes only the named key', () => {
    saveDraft('camp-1', 'set-1', { templateId: 'tpl-1' })
    saveDraft('camp-1', 'set-2', { templateId: 'tpl-2' })
    clearDraft('camp-1', 'set-1')
    expect(getDraft('camp-1', 'set-1')).toBeNull()
    expect(getDraft('camp-1', 'set-2')).toEqual({ templateId: 'tpl-2' })
  })

  it('__clearAllElectiveDrafts resets every key, for test isolation', () => {
    saveDraft('camp-1', 'set-1', { templateId: 'tpl-1' })
    saveDraft('camp-2', 'set-9', { templateId: 'tpl-2' })
    __clearAllElectiveDrafts()
    expect(getDraft('camp-1', 'set-1')).toBeNull()
    expect(getDraft('camp-2', 'set-9')).toBeNull()
  })
})
