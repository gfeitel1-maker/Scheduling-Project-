import { S } from '../styles/shared'

export default function ModeSelectScreen({ onChooseHost, onChooseJoin }) {
  return (
    <div style={S.authPage}>
      <div style={S.authCard}>
        <div style={S.authLogoBlock}>
          <div style={S.authLogo}>Shoresh</div>
          <div style={S.authLogoSub}>Camp activity scheduling</div>
        </div>

        <div style={S.authEyebrow}>First launch on this computer</div>
        <div style={S.authTitle}>How is this device being used?</div>
        <div style={S.authSubtitle}>
          Shoresh needs one computer to hold the master schedule. Choose how this one participates —
          you can't change this later without reinstalling.
        </div>

        <button
          style={S.authChoiceCard}
          onClick={onChooseHost}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={S.authChoiceIcon}>★</div>
          <div style={{ flex: 1 }}>
            <div style={S.authChoiceTitle}>Host this camp's schedule</div>
            <div style={S.authChoiceDesc}>
              This computer becomes the source of truth. Other staff devices on your network will
              connect to it. Choose this on the camp office computer, or the one that stays on.
            </div>
          </div>
          <div style={S.authChoiceChevron}>›</div>
        </button>

        <button
          style={S.authChoiceCard}
          onClick={onChooseJoin}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={S.authChoiceIcon}>↻</div>
          <div style={{ flex: 1 }}>
            <div style={S.authChoiceTitle}>Join a camp already set up</div>
            <div style={S.authChoiceDesc}>
              Connect to a Shoresh Host already running on your network — for staff laptops,
              counselor stations, or anything besides the main office computer.
            </div>
          </div>
          <div style={S.authChoiceChevron}>›</div>
        </button>
      </div>
    </div>
  )
}
