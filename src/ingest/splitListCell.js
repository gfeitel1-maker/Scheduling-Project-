// D3 of docs/adr/2026-10-11-import-electives-keep-their-shape.md. Pure.
const STRICT_DELIMITERS = [/\s*,\s*/, /\s*;\s*/, /\s+\/\s+/]

export function strictSplit(text) {
  const cell = String(text ?? '').trim()
  for (const delimiter of STRICT_DELIMITERS) {
    const parts = cell.split(delimiter).map((p) => p.trim())
    if (parts.length < 3) continue
    if (parts.some((p) => !p || /&/.test(p) || /\sand\s/i.test(` ${p} `) || p.split(/\s+/).length > 4)) return null
    return parts
  }
  return null
}

export const looksListLike = (text) => /[,;/]/.test(String(text ?? ''))

export const looseSplit = (text) => String(text ?? '').split(/\s*[,;/]\s*/).map((p) => p.trim()).filter(Boolean)
