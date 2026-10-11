import { describe, it, expect } from 'vitest'
import { importedVersionLine } from './importedVersionLine'

describe('importedVersionLine', () => {
  it('names the saved version in one plain sentence', () => {
    expect(importedVersionLine({ created: true, versionName: 'Imported from campB.txt' })).toEqual({
      text: "Last year's schedule is saved as a version: Imported from campB.txt.",
      versionName: 'Imported from campB.txt',
    })
  })

  it('is null when no version was saved', () => {
    expect(importedVersionLine({ created: false, versionName: null })).toBeNull()
    expect(importedVersionLine({ created: false, unchanged: true })).toBeNull()
    expect(importedVersionLine(undefined)).toBeNull()
  })

  it('is null when a version was created but its name is unknown', () => {
    expect(importedVersionLine({ created: true })).toBeNull()
  })
})
