# §5/§6.3 device trust — remaining sub-tasks (2-4), resume pointer

Sub-task 1 (schema + revocation enforcement + Host-signed camp tokens) is
DONE, commit `a6f0d0b`, passed GOVERNOR review round 1 (Grader avg 4.8).
Design/ADR are the authoritative reference for all remaining sub-tasks —
read them in full before starting: `docs/adr/2026-07-25-device-trust-revocation.md`,
`docs/superpowers/specs/2026-07-25-device-trust-revocation-design.md`.

## Sub-task 2 — pairing-request/approval protocol + Host-side approval UI

Per the design doc's "Pairing protocol (sub-task 2)" section:
- New WS messages: `pairing_request` (Client→Host, unauthenticated,
  `{device_id, device_name}`), `pairing_approved`/`pairing_denied`
  (Host→Client, carries the freshly-minted `device_secret_identifier` on
  approve). Upserts `devices` row as `pairing_status='pending'`.
- New Host IPC surface (all admin-gated via the real `authorize()` layer,
  audit-logged): `listPendingPairingRequests`, `approveDevice`, `denyDevice`,
  `listDevices`, `revokeDevice`.
- **This is where the interim `shoresh:dev-authorize-device` IPC handler
  (electron/main.js) gets superseded** — either remove it or fold its logic
  into `approveDevice` (same admin-gate pattern, same DB writes). Don't leave
  both live long-term.
- **This is also where Red Hat's sub-task-1 deferred finding gets closed**:
  `revokeDevice` should proactively close any currently-open WS socket for
  the revoked device (iterate `wss.clients`, match `client.deviceId`, call
  `ws.close(4404, 'device_revoked')` — the close code already exists from
  sub-task 1, just needs to be triggered proactively at revoke-time, not
  only passively on the device's next reconnect attempt).
- Designer needs to run first (new Host-side approval screen: pending
  requests list, approve/deny buttons, device list with revoke action).
  Architect does NOT need to re-run — the protocol/schema decisions are
  already made in the sub-task-1 ADR; this is UI + wiring against an
  already-designed contract.

## Sub-task 3 — Client-side "waiting for approval" UX + bounded token renewal

- New `pairing-pending` phase in `src/hooks/useDeviceMode.js`'s state
  machine (see CLAUDE.md's phase list: error → loading → mode-select →
  bootstrap/join → login → session — pairing-pending slots in after a fresh
  Client sends `pairing_request` and before it can attempt login).
  Designer needed for this screen too (can likely run alongside sub-task 2's
  Designer pass rather than as a separate dispatch — same visual system).
- Token renewal: sub-task 1 gave `camp`/`local` tokens a 24h `exp` with no
  renewal path yet — a session currently just goes stale and requires a
  fresh login at 24h. Add a `renew_token` WS message (Client→Host, carries
  the current still-valid token) → Host re-checks device authorization/
  revocation status fresh (do NOT renew a token for a since-revoked or
  since-deauthorized device — this is the whole point of bounded lifetime)
  → issues a fresh `issueCampToken` if still authorized. Client-side:
  schedule a renewal attempt somewhat before `exp` (e.g. at 20h) so a
  connected device never actually hits the hard expiry during active use.

## Sub-task 4 — PIN-transmission hardening tied to the pairing gate

Per the design doc: `handleLogin` (currently untouched since sub-task 1 —
Tester's review flagged this explicitly as expected-deferred, not a
regression) must check `authorized_at`/`revoked_at`/`device_secret_identifier`
match BEFORE calling `attemptLogin` — before the PIN or the lockout counter
is touched at all. This closes "any device on the LAN can attempt PIN
guesses" without needing TLS, per §6.3's acceptance criteria. Depends on
sub-task 2 existing (a device needs a real `device_secret_identifier` from
an actual approval, not just the interim dev-authorize path) to be
meaningfully testable end-to-end, but the `handleLogin` code change itself
only depends on sub-task 1's schema (already in place) — could technically
be built and unit-tested (with a manually-authorized test device) before
sub-task 2 lands, if a future session wants to parallelize.

## Process notes for whoever picks this up

- Full parallel Tester+Security+RedHat+CodeReviewer review + Verifier gate
  for each sub-task, same as sub-task 1 — this pattern held up well (caught
  two real MEDIUM findings, both closed same-round).
- Sub-task 1 briefly had budget for GOVERNOR to fix small/mechanical
  post-review findings directly (stale comment, missing jti-in-audit-metadata,
  WS close-code diagnosability, a test's flaky tamper-generator) rather than
  spending a full second Maker round — same judgment-call pattern this
  project has used repeatedly; keep applying it for comparably-scoped
  findings in sub-tasks 2-4.
- `npm run test` was 500/500 clean at the sub-task 1 commit (`a6f0d0b`).
