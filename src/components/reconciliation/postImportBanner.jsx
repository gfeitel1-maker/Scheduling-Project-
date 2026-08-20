// The post-import banner (Roots-as-dashboard plan, Task 4) — a finished
// import routes the director to Roots carrying its commit outcome, and this
// banner is the payoff moment plus the surviving grace-window undo. It
// replaces the old ImportScreen-local ImportReceipt.
//
// Owner decision: ONE focused banner post-import. This banner is the whole
// post-import story — the readiness verdict is folded in here as a secondary
// line (same text RootsBanner shows, via describeReadiness), and the parent
// suppresses the standalone RootsBanner while an import continuation is live.
// So this component owns the import summary, the folded-in verdict, the
// migrated fixed-event / replace caveats, the undo affordance, and the single
// "Go to Schedule" next step.
//
// Presentational: the grace-window state is owned by useGraceWindowUndo in the
// parent (ReconciliationScreen), threaded in as `graceWindow`. The verdict is
// NOT re-derived here — `readiness` is the parent's already-computed
// getReadiness(...) output (the single source); this only formats it.

import { S, useEnterTransition } from '../../styles/shared'
import { describeReadiness } from '../../engine/readiness.js'

const sumCounts = (counts) => Object.values(counts ?? {}).reduce((n, c) => n + c, 0)

export default function PostImportBanner({ outcome, readiness = [], censusReadFailed = false, graceWindow, onNavigate }) {
  const enterStyle = useEnterTransition('liftFade')
  const fixedEvents = outcome.fixedEvents ?? {}
  // Degrade exactly as RootsBanner does on a failed read: no verdict line
  // rather than a false "ready". Also omit when there is no readiness to
  // describe (e.g. an empty array from a skipped/failed census read).
  const verdict = !censusReadFailed && readiness.length > 0
    ? describeReadiness(readiness).blocking
    : null
  return (
    <div style={{ ...styles.banner, ...enterStyle }}>
      <strong>
        Imported {outcome.total} {outcome.total === 1 ? 'record' : 'records'}
        {fixedEvents.created > 0 && `, including ${fixedEvents.created} fixed ${fixedEvents.created === 1 ? 'event' : 'events'}`}
        {' '}— here’s your camp.
      </strong>
      {verdict && <div style={styles.verdictLine}>{verdict}</div>}
      <div style={{ marginTop: verdict ? 6 : 0 }}>
        They are ordinary records now — edit or delete any of them from the setup screens, and
        anything you delete can be brought back from Trash.
      </div>
      {fixedEvents.skipped?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {fixedEvents.skipped.length} fixed {fixedEvents.skipped.length === 1 ? 'event' : 'events'} couldn’t
          be created because their time block or groups weren’t imported — you can add {fixedEvents.skipped.length === 1 ? 'it' : 'them'} on the Fixed Events screen.
        </div>
      )}
      {fixedEvents.partial?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          Some fixed events were added for fewer days or groups than proposed, because you didn’t import all of them:{' '}
          {fixedEvents.partial.map((p) => `${p.name} (${p.reason})`).join('; ')}. Adjust {fixedEvents.partial.length === 1 ? 'it' : 'them'} on the Fixed Events screen.
        </div>
      )}
      {fixedEvents.moved?.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {fixedEvents.moved.length} fixed {fixedEvents.moved.length === 1 ? 'event has' : 'events have'} moved since this file was last imported, so {fixedEvents.moved.length === 1 ? 'it was' : 'they were'} left as-is instead of creating a duplicate:{' '}
          {fixedEvents.moved.map((m) => `${m.name} (${m.reason})`).join('; ')}.
        </div>
      )}
      {/* What a Replace destroyed, stated rather than implied. */}
      {outcome.replaced && (
        <div style={{ marginTop: 8 }}>
          {sumCounts(outcome.replaced.entities)} old setup {sumCounts(outcome.replaced.entities) === 1 ? 'record was' : 'records were'} cleared first,
          along with {sumCounts(outcome.replaced.dependents)} schedule {sumCounts(outcome.replaced.dependents) === 1 ? 'row' : 'rows'} that used {sumCounts(outcome.replaced.entities) === 1 ? 'it' : 'them'}.
        </div>
      )}
      {/* Grace-window undo (U1). Only rendered while the window is genuinely
          live; the copy says "for the next few minutes", never "always". */}
      {graceWindow.isLive && (
        <div style={{ marginTop: 10 }}>
          {graceWindow.createdEntityIds.length > 0 && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
              {graceWindow.createdEntityIds.length} new {graceWindow.createdEntityIds.length === 1 ? 'record was' : 'records were'} also added — undoing will try to remove {graceWindow.createdEntityIds.length === 1 ? 'it' : 'them'} too.
            </div>
          )}
          <button className="press-97" onClick={() => graceWindow.undo()} disabled={graceWindow.isPending} style={S.btnSecondary}>
            Undo this import
          </button>
          <span style={{ marginLeft: 8, color: 'var(--text-secondary)' }}>for the next few minutes</span>
        </div>
      )}
      {graceWindow.status === 'used' && (
        <div style={{ marginTop: 10, color: 'var(--text-secondary)' }}>
          Undo complete.
          {graceWindow.deleted.length > 0 && (
            <div style={{ marginTop: 4 }}>
              Removed {graceWindow.deleted.length} newly created {graceWindow.deleted.length === 1 ? 'record' : 'records'}.
            </div>
          )}
          {graceWindow.skipped.length > 0 && (
            <div style={{ marginTop: 4 }}>
              Kept {graceWindow.skipped.length} {graceWindow.skipped.length === 1 ? 'field' : 'fields'} changed since import.
            </div>
          )}
          {graceWindow.kept.length > 0 && (
            <div style={{ marginTop: 4 }}>
              Kept {graceWindow.kept.length} new {graceWindow.kept.length === 1 ? 'record' : 'records'}:{' '}
              {graceWindow.kept.map((k) =>
                `${k.name ?? 'record'} (${k.reason === 'edited_since_import' ? 'edited since import' : `still referenced by ${k.referencedByCount} other ${k.referencedByCount === 1 ? 'record' : 'records'}`})`
              ).join('; ')}.
            </div>
          )}
        </div>
      )}
      {graceWindow.undoError && (
        <div style={{ marginTop: 10, ...S.errorBanner }}>{graceWindow.undoError}</div>
      )}
      <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
        {/* Disabled while an undo is in flight (same guard the Undo button
            uses): leaving mid-undo would strand a failed undo's error on an
            unmounted screen — the hook guards that too, but the honest fix is
            to not let the director leave via this button until it resolves. */}
        <button
          className="press-97"
          onClick={() => onNavigate('schedule')}
          disabled={graceWindow.isPending}
          style={graceWindow.isPending ? { ...S.btnPrimary, ...S.buttonDisabled } : S.btnPrimary}
        >Go to Schedule</button>
      </div>
    </div>
  )
}

const styles = {
  banner: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderLeft: '3px solid var(--success)', borderRadius: 8, padding: '12px 14px',
    marginBottom: 16, fontSize: 13, lineHeight: 1.6,
  },
  // The folded-in readiness verdict — the same sentence RootsBanner leads with
  // (its verdictLine), reused here so the one post-import banner carries it.
  verdictLine: {
    marginTop: 4,
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
  },
}
