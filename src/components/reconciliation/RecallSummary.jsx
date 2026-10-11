import { LinkButton } from '../learned/parts.jsx'

// The one line above the review cards (spec 4.3): what the camp remembered, and what Shoresh applied
// on its own with a way to take that back for this import. Plain text, no fill, no border: a line, not a banner.
export default function RecallSummary({ rememberedCount, open, onToggle, autoCount, undoneNote, undoing, onUndo, firstEver }) {
  if (rememberedCount === 0 && autoCount === 0 && !undoneNote) return null
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, color: 'var(--text)' }}>
        {rememberedCount > 0 && (
          <LinkButton aria-expanded={open} onClick={onToggle}>
            {rememberedCount === 1 ? '1 answer remembered - review' : `${rememberedCount} answers remembered - review`}
          </LinkButton>
        )}
        {undoneNote ? (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>Auto-applied: 0 - these questions are back for you to answer</span>
        ) : autoCount > 0 && (
          <span data-testid="auto-applied-line" style={{ fontVariantNumeric: 'tabular-nums' }}>
            <span>Auto-applied:</span> <span>{autoCount}</span> -{' '}
            <LinkButton busy={undoing} busyLabel="Undoing..." minWidth={120} onClick={onUndo} title="Undoing only affects this import. Shoresh keeps the pattern.">
              Undo for this import
            </LinkButton>
          </span>
        )}
      </div>
      {firstEver && autoCount > 0 && !undoneNote && (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Undoing only affects this import. Shoresh keeps the pattern.</div>
      )}
    </div>
  )
}
