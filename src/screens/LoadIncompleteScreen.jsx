import AuthWatermark from '../components/AuthWatermark'
import { S, useEnterTransition } from '../styles/shared'
import { CampFileFailurePanel } from './OpenSavedCampScreen'

// A camp whose load from a camp file stopped partway never reaches a director as if it were whole: this is the only
// screen it gets, and the only way forward is Start over.
export default function LoadIncompleteScreen({ onStartOver }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div style={{ ...S.authPage, position: 'relative', overflow: 'hidden' }}>
      <AuthWatermark />
      <div style={{ ...S.authCard, position: 'relative', ...enter }}>
        <div style={S.authTitle}>This camp didn't finish opening</div>
        <CampFileFailurePanel reason="load_incomplete" canTryAnother={false} onStartOver={onStartOver} />
      </div>
    </div>
  )
}
