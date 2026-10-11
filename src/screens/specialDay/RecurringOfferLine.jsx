// The one-line "Also bring N recurring events from <weekday>?" prompt shown after a
// time-block copy (grid editor and the create-time seed path). Flag-styled, no banner.
export default function RecurringOfferLine({ offer, onBring, onSkip }) {
  return (
    <div style={styles.offer}>
      <span>{`Also bring ${offer.count} recurring event${offer.count === 1 ? '' : 's'} from ${offer.dayLabel}?`}</span>
      <button type="button" className="press-97" onClick={onBring} style={styles.btn}>Bring</button>
      <button type="button" className="press-97" onClick={onSkip} style={styles.btn}>Skip</button>
    </div>
  )
}

const styles = {
  offer: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 14px' },
  btn: {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: 'var(--primary)', fontSize: 13, fontFamily: 'inherit', textDecoration: 'underline',
  },
}
