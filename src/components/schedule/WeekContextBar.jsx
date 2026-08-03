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

  const summaryText = exclusionCount === 0
    ? 'Same as every other week'
    : `${exclusionCount} of ${totalCount} ${entityLabel} customized for ${weekName}`

  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 10,
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
      <span style={{
        fontSize: 12,
        color: exclusionCount > 0
          ? 'color-mix(in srgb, var(--accent) 70%, var(--text))'
          : 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)',
      }}>
        {summaryText}
      </span>
    </div>
  )
}
