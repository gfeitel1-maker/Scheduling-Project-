import { localClient } from '../localClient'
import { S } from '../styles/shared'

const REJOIN = 'set this device up again and join your camp from another paired device'

const COPY = {
  db_unreadable: {
    title: "This device can't open its camp data",
    body: "Shoresh couldn't unlock the camp file stored on this computer, so it stopped before changing anything. Your camp isn't lost — every other device paired to this camp has a full copy. To recover, set this device up again and join your camp from one of those devices.",
  },
  db_key_file_missing: {
    title: "This device's camp key is missing",
    body: `The key this device uses to lock its camp data can't be found, so Shoresh stopped rather than make a new one that would shut you out of your data. If you moved or restored files on this computer, put them back and open Shoresh again. Otherwise, ${REJOIN}.`,
  },
  db_key_guard_unreadable: {
    title: "Shoresh can't read its own files",
    body: "Shoresh isn't allowed to read some of its files on this computer, so it stopped before changing anything. This is usually a file-permissions problem. Ask whoever looks after this computer to check it, then open Shoresh again.",
  },
  keychain_unavailable: {
    title: "This computer's secure storage isn't available",
    body: "Shoresh keeps camp data locked using this computer's secure storage, and it couldn't reach it, so it stopped before changing anything. Restart the computer, sign in to your usual account, and open Shoresh again.",
  },
}

const INTERRUPTED_TITLE = "An update to this camp's file was interrupted"

export default function BootRecoveryScreen({ failure }) {
  const { code, backupPath } = failure
  let title
  let body
  let after = null
  if (code === 'db_migration_interrupted') {
    title = INTERRUPTED_TITLE
    if (backupPath) {
      body = "Shoresh was securing this camp's file when it was stopped part-way, and it couldn't finish putting things back on its own. Your original copy is safe and was not changed. It's kept here:"
      after = 'Keep this file. You can also recover by setting this device up again and joining your camp from another paired device.'
    } else {
      body = "Shoresh was securing this camp's file when it was stopped part-way, and no saved copy was found on this computer. Nothing has been changed. To recover, set this device up again and join your camp from another device paired to this camp."
    }
  } else {
    ({ title, body } = COPY[code])
  }

  return (
    <div style={S.authPage}>
      <div style={S.authCard}>
        <div style={S.authLogoBlock}>
          <div style={S.authLogo}>Shoresh</div>
        </div>
        <div style={S.authTitle}>{title}</div>
        <div style={styles.body}>{body}</div>
        {backupPath && <div style={styles.path}>{backupPath}</div>}
        {after && <div style={styles.body}>{after}</div>}
        <div style={styles.footer}>Details were saved for whoever helps you with Shoresh.</div>
        <button style={S.authBtnPrimary} onClick={() => localClient.quitApp()}>
          Quit Shoresh
        </button>
      </div>
    </div>
  )
}

const styles = {
  body: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 },
  path: {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    color: 'var(--text)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '8px 10px',
    marginBottom: 16,
    wordBreak: 'break-all',
    userSelect: 'text',
  },
  footer: { fontSize: 12, color: 'var(--text-secondary)', marginBottom: 20 },
}
