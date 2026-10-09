// The inline failure flag (docs/work/specs/T350-slice5-binding-ui.md §6): one line of
// danger text with an icon, attached to the control that failed. No filled box — a
// filled strip across the screen is the banner the owner rejected.
import { useEnterTransition } from '../../styles/shared'
import { WarningTriangleIcon } from '../../components/icons'

export default function FailureLine({ message, onRetry, style }) {
  const enter = useEnterTransition('slideFade')
  return (
    <div role="alert" style={{ ...enter, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--danger)', margin: '0 0 14px', ...style }}>
      <WarningTriangleIcon size={16} />
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} style={styles.retry}>Try again</button>
      )}
    </div>
  )
}

const styles = {
  retry: {
    background: 'none', border: 'none', padding: 0, marginLeft: 4, cursor: 'pointer',
    color: 'var(--primary)', fontSize: 13, fontFamily: 'inherit', textDecoration: 'underline',
  },
}
