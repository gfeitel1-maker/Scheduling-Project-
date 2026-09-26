---
title: "Surface the safe-degraded 'sync needs retry' state to the director"
document_type: ticket
status: open
task_class: ui-ux-design
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets: [docs/work/tickets/T274-join-by-code-sync-start.md, docs/work/tickets/T276-extract-sync-starter-for-executed-tests.md]
program: relay-sync
archive_when: "A device in the safe-degraded post-join/post-bootstrap state (join/bootstrap reported ok, but the persistent sync node did not start this cycle) shows the director a retry affordance through the EXISTING sidebar sync-indicator flag vocabulary, the copy has been checked against the owner constraint below, and the state clears once sync actually starts"
---

# T275 — surface "sync needs retry" without reading as "blocked"

## Problem

T274's stop-failure gate (and T273's bootstrap path) deliberately choose
safe-degraded over a double peer-identity: on a rare `stop()` failure the join /
bootstrap still reports ok, but the persistent Automerge sync node is not started
this cycle. The detection mechanism exists — T268's `getSyncStatus` reads
`host-not-syncing` — but **nothing prompts the director to act.** A director sees a
green join/bootstrap screen and an invisible dead sync node until they happen to look
at the sidebar.

## OWNER CONSTRAINTS — verbatim, check the built copy against these (do not paraphrase away)

- **No banners.** Banners are "SaaS nonsense" (standing owner rule). State that needs
  surfacing goes in the EXISTING per-slot / sidebar flag vocabulary (the sidebar sync
  indicator, `sidebarState.js`), NOT chrome.
- **No explainer copy.** (Standing owner rule — no help text / no explainers.)
- **Owner ruling, verbatim: "when someone comes online, they sync."** A *retry
  affordance* is fine. Anything that reads to a director as "this device is blocked
  from syncing" is the exact thing the owner rejected in T222 (update-on-open) wearing
  different clothes. The review loop MUST check the built copy and interaction against
  this sentence: it must read as "tap to retry / sync will resume," never as a
  blocked/held state.

## Scope

- A retry affordance for the safe-degraded state, surfaced through the existing
  sidebar sync-indicator flag vocabulary (`sidebarState.js` labels), ranked
  appropriately against the existing signals.
- Wire the retry to re-invoke the sync starter (the affordance actually retries;
  it is not a dead label).
- The state clears once sync actually starts.

## Depends on

- **T276 first.** The starter is dead code under Vitest today; T276 makes the
  starter (and this retry path) executed under test so T275's retry can be proven
  by behaviour, not source shape. Sequence: T274 → T276 → **T275**.

## Does NOT count as done

- A banner, a modal, or explainer/help copy.
- Copy that reads as "device blocked / held out of sync."
- A label that looks like a retry but doesn't actually re-invoke the starter.
