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
          <div style={S.authLogoSub}>Camp activity scheduling</div>
        </div>

        <div style={S.authEyebrow}>First launch on this computer</div>
        <div style={S.authTitle}>How is this device being used?</div>
        <div style={S.authSubtitle}>
          Every device running Shoresh holds an equal copy of the camp, so the camp survives any
          one computer or person leaving. Choose how this device gets its copy.
        </div>

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
              Set up a brand-new camp on this device. Add other devices to it afterwards with a
              camp code.
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
            <div style={S.authChoiceTitle}>Join a camp with a camp code</div>
            <div style={S.authChoiceDesc}>
              Enter the camp code from a device that already has the camp, and this device gets its
              own full copy.
            </div>
          </div>
          <div style={S.authChoiceChevron}><ChevronIcon size={14} style={{ transform: 'rotate(-90deg)' }} /></div>
        </button>
      </div>
    </div>
  )
}
