function parts(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
  if (!m) return null
  const h = parseInt(m[1], 10)
  return { raw: `${m[1].padStart(2, '0')}${m[2]}`, h12: h % 12 === 0 ? 12 : h % 12, mm: m[2], suffix: h >= 12 ? 'PM' : 'AM' }
}

const digitsOnly = (v) => String(v ?? '').replace(/\D/g, '')

// A time block named after its own times ("03:20-03:40") is shown once, as a
// range with AM/PM; a real name keeps the name and gets the range after it.
export function timeRangeLabel(block) {
  const s = parts(block?.start_time)
  const e = parts(block?.end_time)
  if (!s || !e) return ''
  const sTxt = `${s.h12}:${s.mm}`
  const eTxt = `${e.h12}:${e.mm}`
  return s.suffix === e.suffix ? `${sTxt}–${eTxt} ${e.suffix}` : `${sTxt} ${s.suffix}–${eTxt} ${e.suffix}`
}

export function timeBlockLabel(block) {
  const name = block?.name ?? ''
  const range = timeRangeLabel(block)
  if (!range) return name
  const s = parts(block.start_time)
  const e = parts(block.end_time)
  const nameDigits = digitsOnly(name)
  const restates = nameDigits === `${s.raw}${e.raw}` || nameDigits === `${s.h12}${s.mm}${e.h12}${e.mm}`
  return restates ? range : `${name} (${range})`
}
