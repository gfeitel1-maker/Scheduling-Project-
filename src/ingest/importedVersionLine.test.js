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

  it('tells the director to restore it and confirm the proposed choices when the version holds elective cells', () => {
    const line = importedVersionLine({ created: true, versionName: 'Imported from campB.txt', electiveCellCount: 6 })
    expect(line.text).toBe(
      "Last year's schedule is saved as a version: Imported from campB.txt. Restore it to see the electives, then confirm the proposed choices in Electives before Generate will assign them."
    )
  })

  it('adds nothing about electives when the version holds none', () => {
    expect(importedVersionLine({ created: true, versionName: 'X', electiveCellCount: 0 }).text).not.toMatch(/Electives/)
  })
})
