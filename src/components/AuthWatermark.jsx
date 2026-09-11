import rootPattern from '../assets/brand/root-pattern-bg.jpg'

// The faint root texture behind the pre-session screens.
//
// It used to live inside ModeSelectScreen alone, so first launch went: a
// branded screen, then a plain grey one to name the camp, then the brand again
// on sign-in. Three consecutive screens in one flow, two of them branded and
// the one between them not — which reads less like restraint and more like a
// screen someone forgot.
//
// Shared rather than copied into each screen: the asset import and the opacity
// belong in one place, or the next screen to want it will pick a different
// number and the flow will drift again.
//
// It sits behind everything and is inert to the pointer, so a card above it is
// unaffected. `aria-hidden` because it carries no information — it is texture.
export default function AuthWatermark() {
  return <div style={styles.watermark} aria-hidden="true" />
}

const styles = {
  watermark: {
    position: 'absolute',
    inset: 0,
    backgroundImage: `url(${rootPattern})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    opacity: 0.06,
    pointerEvents: 'none',
    zIndex: 0,
  },
}
