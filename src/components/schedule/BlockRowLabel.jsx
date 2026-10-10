import { blockLabelParts } from '../../utils/timeBlockLabel'

// A schedule grid row header's label: the block name, then its 12-hour range.
// A block named after its own times shows the range once (audit I3).
export default function BlockRowLabel({ block }) {
  const { name, time } = blockLabelParts(block)
  return (
    <>
      <span className="block-name">{name}</span>
      {time && <span className="block-time">{time}</span>}
    </>
  )
}
