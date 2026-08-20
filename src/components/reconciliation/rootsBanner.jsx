// The Roots dashboard banner (plan T2) — sits at the top of Roots inspect
// mode carrying the "can I build a week?" readiness verdict plus the
// "bring data in" entry points. Presentational only: the verdict comes in
// as a pre-computed `readiness` array (getReadiness's output), and this
// component reuses describeReadiness for the sentence — it never re-derives
// the blocking core (that stays getSetupGaps' job, via getReadiness).
//
// Header copy is deliberately plain/functional here (PARKED — a separate
// follow-up owns the poetic header wording).

import { describeReadiness } from '../../engine/readiness.js'
import { S } from '../../styles/shared'

export default function RootsBanner({ readiness, brandNew, onNavigate, onDownloadWorksheet }) {
  const { blocking, attention } = describeReadiness(readiness)

  return (
    <div style={styles.banner}>
      <div style={styles.verdict}>
        <div style={styles.verdictLine}>{blocking}</div>
        {attention && <div style={styles.attentionLine}>{attention}</div>}
      </div>
      <div style={styles.actions}>
        <button
          className="press-97"
          onClick={() => onNavigate('import')}
          style={brandNew ? S.btnPrimary : S.btnSecondary}
        >
          Import last year
        </button>
        <button className="press-97" onClick={onDownloadWorksheet} style={S.btnSecondary}>
          Download worksheet
        </button>
        <button className="press-97" onClick={() => onNavigate('locations')} style={S.btnSecondary}>
          Facility map
        </button>
      </div>
    </div>
  )
}

const styles = {
  banner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
    padding: '14px 16px',
    marginBottom: 16,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  },
  verdict: {
    minWidth: 0,
  },
  verdictLine: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
  },
  attentionLine: {
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
    color: 'var(--accent)',
    marginTop: 2,
  },
  actions: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
}
