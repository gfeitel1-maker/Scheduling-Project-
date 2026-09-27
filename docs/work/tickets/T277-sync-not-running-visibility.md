---
title: "A quiet always-present indicator when sync is not running"
document_type: ticket
status: completed
task_class: ui-ux-design
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T275-degraded-sync-retry-surface.md]
program: relay-sync
archive_when: "A quiet, always-present sync-status indicator low in the sidebar (near the DEV badge / footer) appears ONLY when sync is not running and is ABSENT when sync is healthy, activating it reaches T275's retry / devices surface, the copy reads as 'sync isn't running / try again' never 'device blocked', it is not a banner and adds no explainer, and a non-vacuous test proves it is present for a not-running state and absent for a healthy one"
---

# T277 — a quiet always-present "sync isn't running" indicator

## Owner ruling (buildable)

Owner accepted the recommended direction, verbatim: **"recommendation is fine with me."** T277 is now BUILDABLE, scoped to option (a) below. The decision history that led here is preserved under "Background."

**Build:** a quiet, always-present sync-status indicator low in the sidebar (near the DEV badge / footer area) that appears **only when sync is not running** and is **hidden when sync is healthy**.

## Constraints (owner-locked — the review MUST check the built surface against these)

- NOT a banner, NOT interruptive — a quiet persistent status affordance, using the existing flag vocabulary (`src/components/layout/sidebarState.js`), consistent with the standing no-banners / no-explainer rules.
- Driven by the SAME not-running state T268's `getSyncStatus` already exposes — the `host-not-syncing` state T275's retry keys on (and, where appropriate, `sync-blocked`; see the scope note). Shows ONLY for the stopped/not-running states — MUST NOT appear when sync is fine.
- Tie into T275's existing retry path where natural: activating the indicator should reach the retry affordance / devices surface, so noticing and recovering are one flow — but keep it quiet, not an alert.
- "when someone comes online, they sync" still governs the copy — it must read as "sync isn't running / try again," never "this device is blocked."

## Scope note (carry the T275 distinction)

- `host-not-syncing` → the node isn't running; retry genuinely attempts a start (T275). The indicator should offer/reach that retry.
- `sync-blocked` → a domain-state migration refusal; restarting the node does NOT fix it. The indicator may surface that sync isn't running, but MUST NOT offer a dead "retry" for this state (mirror T275's boundary — retry only where retrying helps). Designer to decide whether the footer indicator shows for `sync-blocked` at all or only for `host-not-syncing`.

## Success predicate

- A quiet indicator near the sidebar footer/DEV badge is PRESENT when `getSyncStatus` reports a not-running state and ABSENT when sync is healthy.
- Activating it reaches T275's retry (for `host-not-syncing`) / the devices surface.
- Copy reads as retryable/transient, never "blocked." No banner, no explainer, no new chrome beyond a quiet persistent indicator in the existing vocabulary.

## Does NOT count as done

- A banner, modal, toast, or interruptive alert.
- An indicator shown when sync is healthy.
- A dead "retry" on `sync-blocked`.
- Explainer/help copy, or copy that reads as "device blocked."

## Evidence required

- Non-vacuity: a test proving the indicator is PRESENT for a not-running state and ABSENT for a healthy one (fails if it always renders or never renders).
- Director's-eye check on prominence + copy (this ticket exists BECAUSE the gear-popup placement failed that check for T275).
- `node scripts/check-governance.js` clean.

## Background (decision history — how this became buildable)

Surfaced by T275's director's-eye test (UX 2/5): the `host-not-syncing` state and its retry lived only inside the Settings-gear popup (pre-existing since the Roots-as-Hub refactor, PR #141), so a director hitting a silent sync stall would not find it. Director's verbatim finding:

> "The copy is clear and makes sense once I see it. But I wouldn't find this on my own if sync broke. I'd think something was stuck and call for help, not dig through a Settings menu."

Framed to the owner as an owner decision (the owner wants a degraded-sync state noticed but forbids a banner). Options offered: (a) a presence near the sidebar footer / elevate the indicator out of the gear popup; (b) a presence at the top of the Devices screen; (c) accept gear-popup visibility. Owner accepted (a).

## Also noted (trivial, fold in while in this neighborhood)

- LOW pre-existing dead code: `src/components/layout/Sidebar.jsx:132` computes a `lan` sync label in the `renderItem` path for `item.key === 'devices'`, unreachable since the devices item is gear-menu-only (moved in PR #141). Safe to delete while building T277 in this same file.
