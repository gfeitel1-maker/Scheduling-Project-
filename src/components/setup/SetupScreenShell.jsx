import { S } from '../../styles/shared'

const eyebrow = { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }

export default function SetupScreenShell({
  countLabel, role, actions = {}, fileInputRef, onFileChange,
  nextLabel, onNext, error, cohortPicker, children,
}) {
  const { onDownloadTemplate, onImport, onDeleteAll, deleteAllProminent = true } = actions
  const deleteStyle = role !== 'admin' ? { ...S.btnDanger, ...S.buttonDisabled } : S.btnDanger

  return (
    <div style={{ maxWidth: 680 }}>
      {error && <div style={S.errorBanner}>{error}</div>}
      {cohortPicker}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={eyebrow}>{countLabel}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {onDownloadTemplate && <button className="press-97" onClick={onDownloadTemplate} style={S.btnSecondary}>Download Template</button>}
          {onImport && <>
            <button className="press-97" onClick={onImport} style={S.btnSecondary}>Import from Excel</button>
            <input ref={fileInputRef} type="file" accept=".xlsx" style={{ display: 'none' }} onChange={onFileChange} />
          </>}
          {onDeleteAll && (
            <button onClick={onDeleteAll} disabled={role !== 'admin'}
              title={role !== 'admin' ? 'Admin only' : undefined}
              style={deleteAllProminent ? deleteStyle : { ...deleteStyle, opacity: 0.6 }}>Delete All</button>
          )}
        </div>
      </div>
      {children}
      <div style={{ marginTop: 28, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
        <button className="press-97" onClick={onNext} style={S.btnPrimary}>{nextLabel}</button>
      </div>
    </div>
  )
}
