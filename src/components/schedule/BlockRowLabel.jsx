import { blockLabelParts, timeRangeLines } from '../../utils/timeBlockLabel'

// A schedule grid row header's label: the block name, then its 12-hour range.
// A block named after its own times shows the range once (audit I3).
// The range always takes the same two lines, "9:00 AM –" then "10:00 AM", so every row header wraps
// alike whatever the range's length (owner, 2026-10-12).
export function RangeLines({ block }) {
  const lines = timeRangeLines(block)
  if (!lines) return null
  return <><span className="block-range-line">{lines[0]}</span>{' '}<span className="block-range-line">{lines[1]}</span></>
}

export default function BlockRowLabel({ block }) {
  const { name, time } = blockLabelParts(block)
  const nameIsRange = time === '' && name !== (block?.name ?? '') // time-guard: key
  return (
    <>
      <span className="block-name">{nameIsRange ? <RangeLines block={block} /> : name}</span>
      {time && <span className="block-time"><RangeLines block={block} /></span>}
    </>
  )
}
