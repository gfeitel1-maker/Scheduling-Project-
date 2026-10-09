import { useState } from 'react'
import { localClient } from '../../localClient'

const ERROR_TEXT = {
  project_switch_in_progress: 'Another project change is in progress. Try again in a moment.',
  no_backup_selected: 'No backup was selected. Choose the file again.',
  file_not_found: 'That file could not be found.',
  invalid_path: 'That is not a backup file.',
  invalid_file: 'That file is not a Shoresh backup.',
  schema_too_new: 'That backup was made by a newer version of Shoresh.',
}

function failureText(result) {
  if (result.error === 'backup_failed') {
    return `A copy of your current data could not be saved first, so nothing was restored. ${result.message || ''}`.trim()
  }
  if (result.error === 'restore_incomplete' && result.rolledBack) {
    return `Restore did not finish — ${result.message || 'the backup could not be opened'}. Nothing was changed.`
  }
  if (result.error === 'restore_incomplete') {
    return `Restore did not finish — ${result.message || 'the backup could not be opened'}. Restart Shoresh before doing anything else. A copy of your previous data is in the backups folder.`
  }
  if (result.error === 'restore_document_failed') {
    return `Restore failed — the camp document could not be restored (${result.message || 'unknown error'}). Your current data was not changed.`
  }
  if (result.error === 'restore_failed') {
    return `Restore failed — ${result.message || 'the backup could not be applied'}. Your current data was not changed.`
  }
  return ERROR_TEXT[result.error] || result.message || 'Restore failed.'
}

const formatDate = (iso) =>
  new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

const linkButton = {
  display: 'block', width: '100%', textAlign: 'left',
  padding: '4px 0', border: 'none', background: 'none',
  fontSize: 11, fontFamily: 'var(--font-mono)', cursor: 'pointer',
  color: 'var(--text-secondary)',
}

export default function RestoreControl() {
  const [backupDate, setBackupDate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)

  async function handlePick() {
    setMessage(null)
    setBusy(true)
    try {
      const result = await localClient.pickRestoreBackup()
      if (result?.canceled) return
      if (result?.error) setMessage({ ok: false, text: failureText(result) })
      else setBackupDate(result.backupDate)
    } catch (err) {
      setMessage({ ok: false, text: failureText({ error: 'restore_failed', message: err.message }) })
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm() {
    setBackupDate(null)
    setBusy(true)
    try {
      const result = await localClient.restoreProject()
      setMessage(result?.error
        ? { ok: false, text: failureText(result) }
        : { ok: true, text: 'Restored from backup.' })
    } catch (err) {
      setMessage({ ok: false, text: failureText({ error: 'restore_failed', message: err.message }) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={handlePick} disabled={busy || !!backupDate} style={linkButton}>
        Restore from backup…
      </button>
      {backupDate && (
        <div role="alertdialog" aria-label="Confirm restore" style={{ fontSize: 11, margin: '2px 0 6px', color: 'var(--text)' }}>
          <div>Replaces this camp's data with the backup from {formatDate(backupDate)}.</div>
          <div>Restores this computer's copy; changes other devices still hold will sync back. Anything erased since then may reappear until other devices sync.</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
            <button type="button" onClick={handleConfirm} style={{ ...linkButton, width: 'auto', color: 'var(--danger, #ef4444)' }}>Restore</button>
            <button type="button" onClick={() => setBackupDate(null)} style={{ ...linkButton, width: 'auto' }}>Cancel</button>
          </div>
        </div>
      )}
      {message && (
        <div role={message.ok ? 'status' : 'alert'} style={{
          fontSize: 11, margin: '2px 0 6px',
          color: message.ok ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)',
        }}>
          {message.text}
        </div>
      )}
    </div>
  )
}
