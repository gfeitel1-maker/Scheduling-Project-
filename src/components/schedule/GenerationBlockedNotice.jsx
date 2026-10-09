import { S } from '../../styles/shared'
import { everyDayReplaced } from '../../engine/effectiveDays'

// T350 (ADR 2026-10-09 D11.1): why Generate / Start blank week will not run
// this week. Inline and derived from state rather than a banner, so it clears
// as soon as the condition does. useGeneration refuses under the same state.
export default function GenerationBlockedNotice({ days, replacedDayIds, specialDaysReadFailed }) {
  if (specialDaysReadFailed) {
    return (
      <p role="status" style={failedStyle}>
        Couldn't read this week's special days, so nothing can be generated until they load. Nothing changed.
      </p>
    )
  }
  if (everyDayReplaced(days, replacedDayIds)) {
    return (
      <p role="status" style={S.cautionBanner}>
        Every day this week is a special day, so there is nothing to generate.
      </p>
    )
  }
  return null
}

const failedStyle = {
  ...S.cautionBanner,
  background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
  border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--border))',
  color: 'color-mix(in srgb, var(--danger) 75%, var(--text))',
}
