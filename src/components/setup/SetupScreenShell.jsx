import { S } from '../../styles/shared'

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
export default function SetupScreenShell({
  countLabel, role, actions = {}, fileInputRef, onFileChange,
  nextLabel, onNext, error, cohortPicker, children, maxWidth = 680,
}) {
  const { onDownloadTemplate, onImport, onDeleteAll, deleteAllDisabled = false } = actions
  const deleteBlocked = deleteAllDisabled || role !== 'admin'
  const deleteStyle = deleteBlocked
    ? { ...S.btnUtility, color: 'var(--text-secondary)', ...S.buttonDisabled }
    : { ...S.btnUtility, color: 'var(--warning)' }

  const hasUtilities = Boolean(onDownloadTemplate || onImport || onDeleteAll)

  return (
    <div style={{ maxWidth }}>
      {error && <div style={S.errorBanner}>{error}</div>}
      {cohortPicker}
      <div style={{ marginBottom: 20 }}>
        <div style={S.sectionCount}>{countLabel}</div>
      </div>
      {children}
      <div style={{
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
        <button className="press-97" onClick={onNext} style={{ ...S.btnPrimary, marginLeft: hasUtilities ? 0 : 'auto' }}>{nextLabel}</button>
      </div>
    </div>
  )
}
