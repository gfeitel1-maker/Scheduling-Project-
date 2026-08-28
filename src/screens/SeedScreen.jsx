import { S } from '../styles/shared'
import sproutArt from '../assets/brand/icons/decorative-sprout.png'

// The first-run landing for a camp with no setup data yet (docs/adr/2026-08-28-
// stage-aware-nav-landing.md Decision 1, docs/work/specs/2026-08-28-lifecycle-
// ia-program.md §3/§4). "Seed your camp" is the initiating act, pulled out on
// its own — not one of the five lifecycle stages. Once the camp has any setup
// data, campHasSetupData() is true and this screen is never the landing again
// (it recedes to "Re-import last year" in the Settings gear — see
// navSections.js's ADMIN_MENU_ITEMS). No explainer copy: the two actions and
// the mark speak for themselves.
export default function SeedScreen({ onNavigate }) {
  return (
    <div style={S.authPage}>
      <div style={styles.card}>
        <img src={sproutArt} alt="" style={styles.mark} />
        <div style={styles.heading}>Seed your camp.</div>
        <div style={styles.actions}>
          <button
            type="button"
            style={S.authBtnPrimary}
            onClick={() => onNavigate('import')}
          >
            Import last year
          </button>
          <button
            type="button"
            style={styles.secondaryBtn}
            onClick={() => onNavigate('tiers')}
          >
            Start by hand
          </button>
        </div>
      </div>
    </div>
  )
}

const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    maxWidth: 380,
    width: '100%',
  },
  mark: {
    width: 96,
    height: 96,
    objectFit: 'contain',
    marginBottom: 20,
  },
  heading: {
    fontFamily: 'var(--font-brand-display)',
    fontSize: 32,
    color: 'var(--text)',
    marginBottom: 32,
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    width: '100%',
  },
  secondaryBtn: {
    display: 'block',
    width: '100%',
    padding: '11px 0',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
}
