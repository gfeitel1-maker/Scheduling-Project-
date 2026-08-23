import { S, useEnterTransition } from '../styles/shared'
import forestCircle from '../assets/brand/forest-circle.png'

export default function PairingPendingScreen({ denied, onBack }) {
  const badgeEnter = useEnterTransition('liftFade')
  return (
    <div style={S.authPage}>
      <div style={S.authCard}>
        <div style={S.authLogoBlock}>
          {!denied && (
            <img
              src={forestCircle}
              alt=""
              style={{ width: 56, height: 56, display: 'block', margin: '0 auto 10px', ...badgeEnter }}
            />
          )}
          <div style={S.authLogo}>Shoresh</div>
        </div>
        {denied ? (
          <>
            <div style={S.authTitle}>Pairing Denied</div>
            <div style={S.authSubtitle}>
              Your pairing request was denied by the admin. Please contact your camp administrator for assistance.
            </div>
          </>
        ) : (
          <>
            <div style={S.authTitle}>Waiting for Approval</div>
            <div style={styles.spinner} />
            <div style={S.authSubtitle}>
              Waiting for the director to approve this device…
            </div>
            <div style={styles.hint}>
              Ask your camp director to approve this device in the Device Manager.
            </div>
          </>
        )}
        <button style={{ ...S.authBtnPrimary, marginTop: 20 }} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}

const styles = {
  spinner: {
    width: 36,
    height: 36,
    border: '3px solid var(--border)',
    borderTop: '3px solid var(--primary)',
    borderRadius: '50%',
    margin: '16px auto 8px',
    animation: 'spin 1s linear infinite',
  },
  hint: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginTop: 8,
    textAlign: 'center',
  },
}
