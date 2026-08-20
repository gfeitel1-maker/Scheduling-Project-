---
title: T93-no-early-host-gate-on-import-ui
document_type: ticket
status: completed
created: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, SECURITY.md]
archive_when: the import surface gates client-mode directors early (before they invest in a full flow), or the host-only import constraint is removed
---

# T93 — No early host-gate on the import UI (client directors fail only at commit)

**Raised:** 2026-08-19, ingest flow audit (`docs/work/specs/2026-08-19-ingest-flow-audit.md` §4 G5).
Not a security hole — the enforcement is correct — a **UX dead-end**.

## Symptom

Import is host-only, but the constraint is enforced **only at the IPC layer**
(`electron/main.js:288-294` throws `"Import can only be run on the main computer."` when
`mode === 'client'`). The import UI (`src/screens/ImportScreen.jsx`) has **no host/client-mode
check**. So a Client-mode director can:

1. Open Import (it's in the sidebar, ungated — `Sidebar.jsx` only gates `adminItems`).
2. Upload + parse a file.
3. Edit the entire proposal (units, activity rules, keep/replace).
4. Stage the reconciliation ledger and resolve every decision.
5. **Only then** hit "Use this setup" and get the error via `mapCommitError`
   (`ReconciliationScreen.jsx:221`).

A whole flow's worth of work, discarded at the final step, with no earlier signal.

## Definition of done

- A Client-mode director sees an early, clear signal that import runs on the main (Host) computer —
  before investing in upload/parse/reconcile. Options (decide during work):
  - Gate/annotate the sidebar "Import last year" item for non-host devices, and/or
  - Show a host-only explainer at the top of ImportScreen when `mode === 'client'`, with the
    upload disabled.
- The IPC-layer enforcement stays exactly as-is (defense in depth — the UI gate is guidance, not the
  security boundary).
- A test pins that a client-mode render shows the early host-only guidance and does not present a
  live upload/commit path.

## Notes

- The device mode is available in the renderer via the device/session state
  (`src/hooks/useDeviceMode.js`); confirm the exact host/client signal reachable from ImportScreen.
- Keep the copy honest and non-blaming ("Import runs on the main computer" — the same framing
  `mapCommitError` already uses).

## Resolution (2026-08-20, SHIPPED — Code Reviewer merge-ready, full gate green)

`ImportScreen` now renders an early host-only explainer ("Import runs on the main computer …") and
presents no upload/parse path when `deviceMode === 'client'` (reusing the prop T86 threads via
App.jsx `screenProps`). IPC enforcement untouched (defense in depth). Test-first: client-mode render
shows guidance + asserts no `input[type=file]`; host/undefined unaffected. Full `npm run verify` green
(214 files, 25/25). Hooks-ordering verified safe (early return after all hooks). Pending owner sign-off.

**Optional follow-up not done (DoD said "and/or"):** the sidebar / RootsBanner "Import last year"
control still reads as clickable for a Client director — the host-only signal appears only after they
open Import. Annotating that entry for non-host devices would complete the picture; left for owner call.
