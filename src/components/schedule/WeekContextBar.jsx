import WeekSwitcher from './WeekSwitcher'

export default function WeekContextBar({
  weekId,
  weeks,
  onSelectWeek,
  exclusionCount,
  totalCount,
  entityLabel,
}) {
  const currentWeek = weeks.find(w => w.id === weekId)
  const weekName = currentWeek?.name ?? 'this week'

  // Only say something when some are switched off for this week; when none are, the bar shows just
  // the week (owner 2026-10-13: the "all … run every week" line is removed).
  const summaryText = exclusionCount > 0
    ? `${exclusionCount} of ${totalCount} ${entityLabel} off in ${weekName}`
    : null

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      marginBottom: 16,
      background: 'color-mix(in srgb, var(--accent) 10%, var(--surface))',
      borderBottom: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
      borderRadius: '6px 6px 0 0',
      paddingLeft: 12,
      paddingRight: 16,
      paddingTop: 8,
      paddingBottom: 8,
    }}>
      <WeekSwitcher
        weeks={weeks}
        weekId={weekId}
        onSelect={onSelectWeek}
      />
      {summaryText && <span style={{
        fontSize: 12,
        color: exclusionCount > 0
          ? 'color-mix(in srgb, var(--accent) 70%, var(--text))'
          : 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
      }}>
        {summaryText}
      </span>}
    </div>
  )
}
