import { startMinutesForOrdering } from './orderTimeBlocks.js'

const RANGE = /^\s*(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*$/

function clock(minutes) {
  const h24 = Math.floor(minutes / 60) % 24
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return { text: `${h}:${String(minutes % 60).padStart(2, '0')}`, meridiem: h24 >= 12 ? 'PM' : 'AM' }
}

// A bare camp-day range ("02:25-03:15") as a director would say it
// ("2:25–3:15 PM"), resolving AM/PM by the same camp-day rule block ordering
// uses. A label that is not a range ("Block 2") is returned as written.
export function formatBlockTime12h(label) {
  const text = String(label ?? '')
  const m = text.match(RANGE)
  if (!m) return text
  const start = startMinutesForOrdering(`${m[1]}:${m[2]}`)
  let end = startMinutesForOrdering(`${m[3]}:${m[4]}`)
  if (start == null || end == null) return text
  if (end <= start && end + 720 < 1440) end += 720
  const a = clock(start)
  const b = clock(end)
  return a.meridiem === b.meridiem
    ? `${a.text}–${b.text} ${b.meridiem}`
    : `${a.text} ${a.meridiem}–${b.text} ${b.meridiem}`
}
