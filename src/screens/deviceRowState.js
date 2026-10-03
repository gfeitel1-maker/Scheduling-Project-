// T332 fold-in (Red Hat HIGH, Art. V — never show the director a tidy lie), moved out of
// DeviceManagerScreen.jsx (Verifier FAIL — react-refresh/only-export-components: a component
// file may only export components) into this plain module. A pure function of one device row +
// the viewer's own role, so the mapping from `effectiveState` (the real camp_authority_log
// replay, computed server-side in electron/main.js's listDevices — never recomputed here) to
// badge/affordance is unit-testable without rendering. `effectiveState` is `undefined` for an
// ordinary (never admin/founder) device — that row keeps the ORIGINAL revoked_at-only logic
// unchanged, exactly as before this fold-in.
//
// Amendment (canManage relaxation, Code Reviewer HIGH): the backend gate for revoke/confirm-
// removal is `authorize()`'s role check alone (devices.revoke is admin-only, mode-agnostic since
// T332's base change) — there is no device-mode restriction left to mirror here. `canVote` is
// therefore gated on `role` only, not on the caller's deviceMode; a client-mode admin gets the
// identical affordance a host-mode admin does. The target device itself (`isSelf`) and an admin
// who has already voted never get the affordance, regardless of mode.
export function deriveDeviceRowState(device, { role }) {
  const removalPending = device.effectiveState === 'removal_pending'
  const isRevoked = device.effectiveState === 'removed' || (device.effectiveState === undefined && !!device.revoked_at)
  const isAuthorized = !!device.authorized_at && !isRevoked && !removalPending
  const canVote = device.effectiveState !== undefined && role === 'admin' && !device.isSelf && !device.hasVoted && !isRevoked
  const detailText = !removalPending
    ? null
    : Number.isFinite(device.votesNeeded) && Number.isFinite(device.votesCast)
      ? `Needs ${device.votesNeeded - device.votesCast} more director${device.votesNeeded - device.votesCast === 1 ? '' : 's'} to confirm`
      : 'Removal pending — waiting on other directors'
  return { removalPending, isRevoked, isAuthorized, canVote, detailText }
}
