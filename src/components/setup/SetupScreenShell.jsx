import { S } from '../../styles/shared'
import { nextSetupScreen } from '../layout/navSections'
import WeekContextBar from '../schedule/WeekContextBar'

// One width for every setup screen (design inventory 2026-10-08, D1; consistency audit 2026-10-12,
// C10). 820 fits Activities' eight columns, so no screen widens itself and Fixed Events is not crowded.
export const SETUP_MAX_WIDTH = 820

// The frame every germination (setup) screen renders inside.
//
// Download Template / Import from Excel / Delete All used to occupy the top
// right, level with the record count — filled buttons, with Delete All in loud
// btnDanger. That put a file menu and a red button above the list on every
// setup screen, which read as the primary thing to do there. They are
// occasional bulk operations. The screen's primary action is the list itself,
// and then Next.
//
// So they moved into the footer, quiet (S.btnUtility), on the opposite side
// from Next. Delete All keeps a separator before it — it is the one action in
// the group that destroys data, and it should not sit flush against Import.
// It is NOT hidden behind an overflow menu: a director who needs it needs to
// see that it exists.
//
// The footer's forward link is the next setup screen in sidebar order (navSections), from `screenKey`;
// the last one leads to the schedule. Screens no longer name their own next, so the chain cannot skip
// a screen or diverge from the sidebar (consistency audit C2/C4).
//
// `week`: on a week-scoped screen (its records can be turned off for one week), the props for the one
// week bar. The shell renders it, first, so it has the same place, size and wording on every screen
// that has one. A screen whose data is not per-week passes nothing and shows no bar.
export default function SetupScreenShell({
  screenKey, onNavigate, week,
  countLabel, role, actions = {}, fileInputRef, onFileChange,
  error, cohortPicker, children,
}) {
  const next = screenKey ? nextSetupScreen(screenKey) : null
  const nextLabel = next ? `${next.label} →` : 'Schedule →'
  const onNext = screenKey && onNavigate ? () => onNavigate(next ? next.key : 'schedule') : null
  const { onDownloadTemplate, onImport, onDeleteAll, deleteAllDisabled = false } = actions
  const deleteBlocked = deleteAllDisabled || role !== 'admin'
  const deleteStyle = deleteBlocked
    ? { ...S.btnUtility, color: 'var(--text-secondary)', ...S.buttonDisabled }
    : { ...S.btnUtility, color: 'var(--danger)' }

  const hasUtilities = Boolean(onDownloadTemplate || onImport || onDeleteAll)

  return (
    <div style={{ maxWidth: SETUP_MAX_WIDTH }}>
      {week && week.weeks.length > 0 && <WeekContextBar {...week} />}
      {error && <div style={S.errorBanner}>{error}</div>}
      {cohortPicker}
      <div style={{ marginBottom: 20 }}>
        <div style={S.sectionCount}>{countLabel}</div>
      </div>
      {children}
      {(hasUtilities || onNext) && <div style={{
        marginTop: 28,
        paddingTop: 20,
        borderTop: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {onDownloadTemplate && <button className="press-97" onClick={onDownloadTemplate} style={S.btnUtility}>Download Template</button>}
          {onImport && <>
            <button className="press-97" onClick={onImport} style={S.btnUtility}>Import from Excel</button>
            <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          </>}
          {onDeleteAll && (
            <>
              <span aria-hidden="true" style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 8px' }} />
              <button onClick={onDeleteAll} disabled={deleteBlocked}
                title={role !== 'admin' ? 'Admin only' : undefined}
                style={deleteStyle}>Delete All</button>
            </>
          )}
        </div>
        {onNext && <button className="press-97" onClick={onNext} style={{ ...S.btnPrimary, marginLeft: hasUtilities ? 0 : 'auto' }}>{nextLabel}</button>}
      </div>}
    </div>
  )
}
