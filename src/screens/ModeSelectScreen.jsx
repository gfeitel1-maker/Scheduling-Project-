import { S, useEnterTransition } from '../styles/shared'
import AuthWatermark from '../components/AuthWatermark'
import { StarIcon, SyncIcon, ChevronIcon } from '../components/icons'

export default function ModeSelectScreen({ onChooseHost, onChooseJoin }) {
  const enterStyle = useEnterTransition('liftFade')
  return (
    <div style={{ ...S.authPage, position: 'relative', overflow: 'hidden' }}>
      <AuthWatermark />
      <div style={{ ...S.authCard, position: 'relative', zIndex: 1, ...enterStyle }}>
        <div style={S.authLogoBlock}>
          <div style={S.authLogo}>Shoresh</div>
        </div>

        <div style={S.authTitle}>Set up this device</div>

        <button
          style={S.authChoiceCard}
          onClick={onChooseHost}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={S.authChoiceIcon}><StarIcon /></div>
          <div style={{ flex: 1 }}>
            <div style={S.authChoiceTitle}>Start a new camp</div>
            <div style={S.authChoiceDesc}>
              Add other devices later with a camp code.
            </div>
          </div>
          <div style={S.authChoiceChevron}><ChevronIcon size={14} style={{ transform: 'rotate(-90deg)' }} /></div>
        </button>

        <button
          style={S.authChoiceCard}
          onClick={onChooseJoin}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,0.06)' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none' }}
        >
          <div style={S.authChoiceIcon}><SyncIcon /></div>
          <div style={{ flex: 1 }}>
            <div style={S.authChoiceTitle}>Join with a camp code</div>
            <div style={S.authChoiceDesc}>
              This device gets its own full copy.
            </div>
          </div>
          <div style={S.authChoiceChevron}><ChevronIcon size={14} style={{ transform: 'rotate(-90deg)' }} /></div>
        </button>
      </div>
    </div>
  )
}
