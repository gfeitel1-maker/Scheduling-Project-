// The pure mapping half of reconnecting 'shoresh:auth-rejected' after the Stage 6 cutover deleted
// its only sender (the WS syncClient.js). Pulled out of main.js's onAuthRejected handler so the
// reason->code mapping is unit-testable without a real libp2p node — mirrors evaluateAuthenticate's
// own code choices (electron/auth/connectionAuth.js) exactly, since `reply` on the wire carries
// only `{ type: 'auth_failed', reason }` (electron/sync/automerge/authGate.js's auth_failed frame),
// never a numeric code — confirmed by reading authGate.js and mutualAuth.js directly rather than
// assumed. `code` is not on the wire, so it is derived here from `reason` instead.
//
// DRIFT IS THE RISK HERE, and it is the same defect class this whole change exists to close: this
// table and connectionAuth.js's own `code` choices are two files that must agree, with nothing
// structural forcing them to. If connectionAuth.js gains a reason or changes a code and this table
// does not follow, the `?? 4401` fallback below silently renders a serious refusal as the benign
// "your session ended" notice — a wrong message, not a missing one, which is worse. The parity is
// therefore asserted against connectionAuth.js's real source in authRejectedSender.test.js rather
// than left to a reviewer noticing. Export the table so that test can read it.
export const REASON_TO_CODE = {
  invalid_token: 4401,
  local_token_not_valid_for_network: 4402,
  device_not_found: 4403,
  device_not_authorized: 4403,
  device_revoked: 4404,
  peer_identity_mismatch: 4405,
}

/** Pure: a rejected-authenticate `reply` (`{ type: 'auth_failed', reason }`) -> the numeric code preload/useDeviceMode expect. */
export function codeForAuthRejectedReason(reason) {
  return REASON_TO_CODE[reason] ?? 4401
}
