// T250 A4 — permanently deleting an elective run: the loud confirmation for
// the quiet "Delete run" trigger on both DraftRunView and FinalRunView.
//
// NOT a case grafted onto DeleteRecordDialog.jsx: that component is keyed to
// previewDelete's generic entity-preview shape (LABEL map, slot_count/
// ref_count, deleteRecord, "goes to Trash" recovery copy) and a run does not
// fit it — the cascade is a dedicated primitive (electron/ops/
// deleteElectiveRun.js), there is no Trash/Versions recovery for it, and the
// cost callout below is the D10 honest-cost copy, not a generated one. It
// reuses that dialog's visual shape (overlay/panel/title/body/actions) and
// this app's own S.btnDanger/btnSecondary/errorBanner tokens rather than
// forking a second unrelated styling system.
import { useState } from 'react'
import { localClient } from '../../../localClient'
import { S, useEnterTransition } from '../../../styles/shared'
import { describeWriteFailure } from '../../../utils/writeErrorMessage'

// Verbatim, per the brief's D10 honest-cost copy, factually corrected
// against the code: a run delete replicates like any other change (a full
// op-log purge — not merely this device's copy — needs a coordinated
// tombstone rebuild, which is a different, far costlier operation this
// control does not perform).
export const DELETE_RUN_COST_COPY =
  'Deleting this run removes it and its camper placements from this device and from every device this camp syncs with. ' +
  'A device that is offline will catch up when it reconnects. It does not erase the run from this app’s own change history ' +
  '— doing that needs a coordinated rebuild that invalidates every device’s copy of this camp and forces each one to pair ' +
  'again — and nothing here can reach a copy already exported or taken off this computer.'

export default function DeleteRunDialog({ run, camperCount = 0, placementCount = 0, onCancel, onDeleted }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(null)
  const enterStyle = useEnterTransition('liftFade')

  async function confirm() {
    setWorking(true)
    setError(null)
    try {
      const out = await localClient.deleteElectiveRun({ runId: run.id })
      if (!out?.ok) {
        setError(out?.error ?? 'That run could not be deleted.')
        setWorking(false)
        return
      }
      onDeleted(out)
    } catch (err) {
      setError(describeWriteFailure(err, 'That run could not be deleted.'))
      setWorking(false)
    }
  }

  return (
    <div data-testid="delete-run-dialog" style={{ ...overlay, ...enterStyle }}>
      <div style={panel}>
        <div style={title}>Delete &quot;{run.name}&quot;?</div>
        <p style={body}>
          {camperCount} campers and {placementCount} placements will be removed.
        </p>
        <div style={costCallout}>{DELETE_RUN_COST_COPY}</div>

        {error && <div style={{ ...S.errorBanner, marginTop: 14, marginBottom: 0 }}>{error}</div>}

        <div style={actions}>
          <button className="press-97" onClick={onCancel} disabled={working} style={S.btnSecondary}>
            Cancel
          </button>
          <button className="press-97" onClick={confirm} disabled={working} style={S.btnDanger}>
            {working ? 'Deleting…' : 'Delete run'}
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: '24px 16px',
}

const panel = {
  background: 'var(--surface-elevated)',
  borderRadius: 12,
  padding: 28,
  width: 520,
  maxWidth: '100%',
}

const title = {
  fontFamily: 'var(--font-condensed)',
  fontWeight: 700,
  fontSize: 18,
  marginBottom: 14,
}

const body = { fontSize: 14, lineHeight: 1.55, margin: '0 0 14px' }

const costCallout = {
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--text)',
  background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
  border: '1px solid color-mix(in srgb, var(--danger) 25%, var(--border))',
  borderRadius: 8,
  padding: '10px 12px',
}

const actions = {
  display: 'flex',
  gap: 10,
  justifyContent: 'flex-end',
  marginTop: 22,
}
