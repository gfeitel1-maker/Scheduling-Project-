// A quiet, wordless empty state — outline icon + one line + optional action.
// Mirrors RootsHomeScreen's "Nothing needs you right now" empty state
// (styles.emptyState/emptyStateIcon) so every calm empty state in the app
// reads as the same visual language. No illustration, no emoji, no
// explainer copy (feedback_no_coming_soon_controls / doc-staleness-adjacent
// house rule: keep empty states quiet, not chatty).
import { S } from '../styles/shared'
import { CalendarIcon } from './icons'

export default function CalmEmptyState({ message, actionLabel, onAction }) {
  return (
    <div style={styles.wrap}>
      <CalendarIcon style={styles.icon} />
      <div>{message}</div>
      {actionLabel && onAction && (
        <button className="press-97" onClick={onAction} style={{ ...S.btnPrimary, marginTop: 'var(--space-2)' }}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

const styles = {
  wrap: {
    padding: 'var(--space-6) var(--space-1)',
    textAlign: 'center',
    fontSize: 13,
    color: 'var(--text-secondary)',
  },
  icon: {
    display: 'block',
    margin: '0 auto var(--space-2)',
  },
}
