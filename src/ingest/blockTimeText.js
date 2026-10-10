import { startMinutesForOrdering } from './orderTimeBlocks.js'
import { timeRangeLabel, formatTime12 } from '../utils/timeBlockLabel.js'

const RANGE = /^\s*(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})\s*$/

const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

// A bare camp-day range ("02:25-03:15") as a director would say it
// ("2:25–3:15 PM"): AM/PM comes from the camp-day rule block ordering uses, the
// formatting from the shared timeRangeLabel. A label that is not a readable
// range ("Block 2", or one whose end does not follow its start) is returned as
// written rather than guessed at.
export function formatBlockTime12h(label) {
  const text = String(label ?? '')
  const m = text.match(RANGE)
  if (!m) return text
  const start = startMinutesForOrdering(`${m[1]}:${m[2]}`)
  const end = startMinutesForOrdering(`${m[3]}:${m[4]}`)
  if (start == null || end == null || end <= start) return text
  return timeRangeLabel({ start_time: hhmm(start), end_time: hhmm(end) })
}

// Just the start of a range, "3:20 PM", by the same camp-day rule.
export function formatBlockStart12h(label) {
  const text = String(label ?? '')
  const m = text.match(/^\s*(\d{1,2})[:.](\d{2})/)
  const start = m ? startMinutesForOrdering(`${m[1]}:${m[2]}`) : null
  return start == null ? text : formatTime12(hhmm(start))
}
