---
title: T249-encryption-gate-entry-point
document_type: ticket
status: open
created: 2026-09-23
archive_when: the D8 at-rest-encryption disclosure renders persistently at the elective feature's entry screen whenever encryption is disabled, and a test pins that it cannot be silently dropped by a later refactor
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T249 — D8 encryption gate as a visible in-app statement

Implements ADR 2026-09-23 decision (e). T199 names this a **release precondition**, not a nice-to-
have: "Shipping the flow without that statement fails this ticket [T199]." This ticket is the
smallest independent slice that satisfies it, so it does not have to wait on the rest of the
decomposition.

## Scope

- `electron/main.js`: `getSecurityStatusHandler()` reading the same resolution `docStore.js` already
  uses for `SHORESH_AT_REST_ENCRYPTION` — call that function, do not re-parse the env var. No
  `authorize()` call (public config, not camp/camper data).
- `electron/preload.js`: `getSecurityStatus: () => ipcRenderer.invoke('shoresh:get-security-status')`.
- `src/screens/elective/assignment/AssignmentPanel.jsx`: persistent, non-dismissible disclosure row
  in the "No run" (empty) state, per the ADR's copy. Not a banner (repo convention). Follow
  DESIGN_STANDARD §5/§8 for its loading/async state (the security-status read is itself an async
  IPC call — show a neutral/loading treatment before the result resolves, never silently absent).
- Component test: disclosure text present when mocked `atRestEncryptionEnabled: false`; a second
  assertion confirms it survives a state transition (e.g., navigating into "Import preview" and
  back), so it cannot regress via a one-time-render bug.

## Non-goals

Changing `SHORESH_AT_REST_ENCRYPTION`'s default or wiring encryption itself — that is the separate,
already-tracked at-rest-encryption activation program (T175/T179 per SECURITY.md), not this ticket.

## Test seam

`src/screens/**` component test (Vitest + Testing Library, no integration harness required — this
touches neither sync, auth, nor schema; it is a read of existing config and a render).

## Dependencies

None functionally — can be developed and merged in parallel with every other ticket in this
decomposition, including T243. **Shares `electron/main.js`/`electron/preload.js` with T244, T245,
T248** for its `getSecurityStatus` handler — this is an ordinary git merge-conflict risk between
four tickets touching the same two files, not a logic dependency on any of them; append the new
handler to the existing elective/security block in both files rather than reordering, per T244's
convention note, whichever of the four merges last.
