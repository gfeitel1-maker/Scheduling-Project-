import { SCREEN_INTRO } from './screenIntroText'

// One line saying what a screen is for. Text lives in screenIntroText.js so
// this file only exports a component.
export default function ScreenIntro({ screen }) {
  const text = SCREEN_INTRO[screen]
  if (!text) return null
  return (
    <p style={{
      margin: '0 0 18px',
      fontSize: 13,
      lineHeight: 1.6,
      color: 'var(--text-secondary)',
      maxWidth: '62ch',
    }}>
      {text}
    </p>
  )
}
