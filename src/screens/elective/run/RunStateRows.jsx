// T250 — the run-state area shared by the Draft and Final run screens
// (docs/work/specs/2026-09-25-t250-run-state-surface.md, "Layout").
//
// This is the run's OWN state shown inline on the run's own screen — not the
// schedule findings vocabulary (week-scoped, no run-level row, no per-row
// action slot; see the ADR's "Amendment (2026-09-24)") and not a banner.
//
// Every visual value here is reused, not invented: S.cautionBanner's exact
// colour formula and S.btnSecondary for the one action.
//
// NOTHING HERE ANIMATES, and that is the spec, not an omission. The spec's
// "Animation" section reserves motion for a transition INTO a new state
// during an active session and forbids an entrance animation on a screen that
// already has findings when it mounts. These two screens have no in-session
// transition: the run-state area is rendered from one load of getElectiveRun
// and no row is ever added to or removed from it while mounted. Round 1 wrapped
// the area in useEnterTransition('liftFade'), which fires on every mount and so
// animated exactly the case the spec excludes. A row that CAN arrive or leave
// mid-session is what re-earns motion here.
import { S } from '../../../styles/shared'

// S.cautionBanner as a ROW rather than a block: the bottom margin is dropped
// and a structural 1px divider separates stacked rows, so five conditions read
// as one list instead of five cards.
const rowBase = {
  background: S.cautionBanner.background,
  borderLeft: `1px solid ${'color-mix(in srgb, var(--accent) 45%, var(--border))'}`,
  borderRight: `1px solid ${'color-mix(in srgb, var(--accent) 45%, var(--border))'}`,
  color: S.cautionBanner.color,
  padding: S.cautionBanner.padding,
  fontSize: S.cautionBanner.fontSize,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 12,
  overflow: 'hidden',
}

export function RunStateRow({ testId, message, action, first, last }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        ...rowBase,
        borderTop: `1px solid ${first ? 'color-mix(in srgb, var(--accent) 45%, var(--border))' : 'var(--border)'}`,
        borderBottom: last ? '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))' : 'none',
        borderTopLeftRadius: first ? 6 : 0,
        borderTopRightRadius: first ? 6 : 0,
        borderBottomLeftRadius: last ? 6 : 0,
        borderBottomRightRadius: last ? 6 : 0,
      }}
    >
      <span>{message}</span>
      {action ?? null}
    </div>
  )
}

// Mounted only when it has something to say. A permanently-present "all clear"
// tile would read as a dashboard on a screen whose personality is quiet — the
// clean case renders nothing at all and occupies no vertical space.
export function RunStateArea({ children }) {
  const present = [children].flat().filter(Boolean)
  if (present.length === 0) return null
  return (
    <div data-testid="run-state-area" style={{ marginBottom: 16 }}>
      {present}
    </div>
  )
}

const identityStyles = {
  wrap: { marginBottom: 14 },
  name: { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, marginBottom: 2 },
  meta: { fontSize: 12, color: 'var(--text-secondary)' },
}

// The line that already says which run this is and whether it is Draft or
// Final — the same place the run-state area then sits directly under.
export function RunIdentity({ run, scheduleTemplates = [], scheduleWeeks = [], tiers = [] }) {
  const template = scheduleTemplates.find((t) => t.id === run.schedule_template_id)
  const week = scheduleWeeks.find((w) => w.id === run.schedule_week_id)
  const tier = tiers.find((t) => t.id === run.tier_id)
  const parts = [
    run.status === 'final' ? 'Final' : 'Draft',
    run.source_filename,
    template?.name,
    week?.name,
    tier?.name,
    run.finalized_at ? `finalized ${run.finalized_at.slice(0, 10)}` : null,
    run.finalized_by ? `by ${run.finalized_by}` : null,
  ].filter(Boolean)
  return (
    <div data-testid="run-identity" style={identityStyles.wrap}>
      <div style={identityStyles.name}>{run.name}</div>
      <div style={identityStyles.meta}>{parts.join(' · ')}</div>
    </div>
  )
}

// Standing rule: every write failure is surfaced, never swallowed.
export function RunError({ message }) {
  if (!message) return null
  return <div data-testid="run-view-error" role="alert" style={{ ...S.errorBanner }}>{message}</div>
}

export { S }
