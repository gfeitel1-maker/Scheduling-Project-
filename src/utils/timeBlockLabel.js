// The ONE formatter for a time block's label wherever it is shown with its
// times (schedule grid row headers, Fixed Events, the Excel export). 12-hour
// clock, AM/PM on both ends, spaced en dash: "9:00 AM – 9:45 AM".
//
// Audit I3 — an imported camp's blocks are named after their own printed
// times, in whatever shape the file used ("12:55-01:35", "03:20-03:40",
// "3:20pm-3:40pm"). Such a name is shown ONCE, as the formatted range from the
// stored start/end times. This is display-only on purpose: the stored name is
// the key re-import reconciles blocks by (electron/ops/ingest.js seedNameMaps,
// src/ingest/fixedEvents.js knownBlockNames), so rewriting it would orphan
// every existing camp's blocks on the next import of the same file.

function parts(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''))
  if (!m) return null
  const h = parseInt(m[1], 10)
  return { h12: h % 12 === 0 ? 12 : h % 12, mm: m[2], suffix: h >= 12 ? 'PM' : 'AM' }
}

// One clock time, "13:35" or "13:35:00" -> "1:35 PM". '' when not a time.
export function formatTime12(t) {
  const p = parts(t)
  return p ? `${p.h12}:${p.mm} ${p.suffix}` : ''
}

export function timeRangeLabel(block) {
  const s = parts(block?.start_time)
  const e = parts(block?.end_time)
  if (!s || !e) return ''
  // Both ends always carry AM/PM (owner, 2026-10-12), so every block's time reads and wraps the same
  // way: "9:00 AM – 10:00 AM". A narrow header breaks it at the spaced dash, never mid-time.
  return `${s.h12}:${s.mm} ${s.suffix} – ${e.h12}:${e.mm} ${e.suffix}`
}

// The range as the two lines a narrow row header shows: ["9:00 AM –", "10:00 AM"], or null.
export function timeRangeLines(block) {
  const range = timeRangeLabel(block)
  if (!range) return null
  const at = range.indexOf(' – ')
  return [range.slice(0, at + 2), range.slice(at + 3)]
}

// One end of a range: "9", "09:15", "9.15", "3:20pm", "3:20 P.M.".
const END = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*([ap]\.?\s*m\.?)?`
const RANGE = new RegExp(String.raw`^\s*${END}\s*(?:-|–|—|to)\s*${END}\s*$`, 'i')

// True when a block's whole name is a time range and nothing else. A bare
// "9-10" is not enough (it reads as a count or a grade band); at least one
// end must carry minutes or an AM/PM marker.
export function isTimeRangeName(name) {
  const m = RANGE.exec(String(name ?? ''))
  if (!m) return false
  const [, , m1, ap1, , m2, ap2] = m
  return Boolean(m1 || m2 || ap1 || ap2)
}

// Row-header form: a name line and a time line. The time line is empty when
// the name is the time range (it would only repeat it) or there are no times.
export function blockLabelParts(block) {
  const name = block?.name ?? ''
  const range = timeRangeLabel(block)
  if (!range) return { name, time: '' }
  return isTimeRangeName(name) ? { name: range, time: '' } : { name, time: range }
}

// Single-line form: "Period 1 (9:00 AM – 9:45 AM)", or just "12:55 PM – 1:35 PM".
export function timeBlockLabel(block) {
  const { name, time } = blockLabelParts(block)
  return time ? `${name} (${time})` : name
}
