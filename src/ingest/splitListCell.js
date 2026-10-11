// D3 of docs/adr/2026-10-11-import-electives-keep-their-shape.md. Pure.
const STRICT_DELIMITERS = [/\s*,\s*/, /\s*;\s*/, /\s+\/\s+/]
const WEEKDAY = /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\.?$/i

const letterCount = (p) => (p.match(/\p{L}/gu) ?? []).length
const digitCount = (p) => (p.match(/\d/g) ?? []).length

export function strictSplit(text) {
  const cell = String(text ?? '').trim()
  if (cell.includes(':')) return null
  for (const delimiter of STRICT_DELIMITERS) {
    const parts = cell.split(delimiter).map((p) => p.trim())
    if (parts.length < 3) continue
    if (parts.some((p) => !p || /[,;/]/.test(p) || /&/.test(p) || /\sand\s/i.test(` ${p} `) || p.split(/\s+/).length > 4
      || letterCount(p) < 2 || digitCount(p) > letterCount(p) || WEEKDAY.test(p))) return null
    const seen = new Set()
    const unique = parts.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase()))
    return unique.length >= 3 ? unique : null
  }
  return null
}

export const looseSplit = (text) => String(text ?? '').split(/\s*[,;/]\s*/).map((p) => p.trim()).filter(Boolean)

export const usablePartCount = (parts) => parts.filter((p) => letterCount(p) >= 2).length

export const looksListLike = (text) => usablePartCount(looseSplit(text)) >= 2
