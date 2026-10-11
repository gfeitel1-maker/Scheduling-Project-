// The "Also bring N recurring events from <weekday>?" prompt shown after a time-block copy
// (grid editor and the create-time seed path) and when a special day is placed on a weekday.
// Flag-styled, no banner. Each offered event has a checkbox, all ticked; Bring passes the
// ticked keys, Skip dismisses.
import { useState } from 'react'

export default function RecurringOfferLine({ offer, onBring, onSkip, busy = false }) {
  const events = offer.events ?? []
  const [unticked, setUnticked] = useState(() => new Set())
  const keys = events.filter((e) => !unticked.has(e.key)).map((e) => e.key)
  const toggle = (key) => setUnticked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  return (
    <div style={styles.wrap}>
      <div style={styles.offer}>
        <span>{`Also bring ${offer.count} recurring event${offer.count === 1 ? '' : 's'} from ${offer.dayLabel}?`}</span>
        <button type="button" className="press-97" onClick={() => onBring(keys)} disabled={busy || (events.length > 0 && keys.length === 0)} style={styles.btn}>Bring</button>
        <button type="button" className="press-97" onClick={onSkip} style={styles.btn}>Skip</button>
      </div>
      {events.length > 0 && (
        <div style={styles.list}>
          {events.map((e) => (
            <label key={e.key} style={styles.item}>
              <input type="checkbox" checked={!unticked.has(e.key)} onChange={() => toggle(e.key)} />
              {e.name}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  wrap: { margin: '0 0 14px' },
  offer: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)' },
  list: { display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 },
  item: { display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' },
  btn: {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: 'var(--primary)', fontSize: 13, fontFamily: 'inherit', textDecoration: 'underline',
  },
}
