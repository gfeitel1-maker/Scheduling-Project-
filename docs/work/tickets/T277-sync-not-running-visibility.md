---
title: "OWNER DECISION: how prominently should a 'sync isn't running' state be shown?"
document_type: ticket
status: parked
task_class: ui-ux-design
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
related_tickets: [docs/work/tickets/T275-degraded-sync-retry-surface.md]
program: relay-sync
archive_when: "The owner has decided how (and how prominently) a 'sync isn't running' state should surface to a director without a banner, that decision is recorded here, and — if it authorizes build work — a follow-up implementation ticket is opened; until the owner decides, this stays blocked and NOT built"
---

# T277 — OWNER DECISION, not authorized to build

**Status: parked on an owner decision. Do NOT implement anything from this ticket until the owner rules. This is a decision record, not a work item.**

## The finding (T275 director's-eye test, verbatim)

T275 added a `try again` retry affordance to the `host-not-syncing` sync state. The copy and interaction passed review (Security 5, Code Reviewer ready, and the director's-eye copy check confirmed it reads as retryable, not blocked). But the director's-eye test scored UX 2/5 for one reason — **discoverability**:

> "The copy is clear and makes sense once I see it. But I wouldn't find this on my own if sync broke. I'd think something was stuck and call for help, not dig through a Settings menu. Hide the retry somewhere important — either in a banner or at the top of the Devices screen itself, not buried in a popup."

The `host-not-syncing` (and `sync-blocked`) sync state, and now the retry, live only inside the **Settings-gear popup** (the devices row moved there in the Roots-as-Hub refactor, PR #141, well before T275). A director hitting a silent sync stall must open Settings to discover that sharing isn't running.

This is **pre-existing** (T268's not-running label was already gear-menu-only; T275 added retry to where the label already was) and was correctly out of T275's scope. But it is a real gap in the underlying goal — that a director *notices* a degraded-sync state and acts — which is why it is surfaced here for the owner rather than silently accepted.

## The constraint (why this is genuinely the owner's call, not an engineering default)

- **No banners.** The owner's standing rule ("banners are SaaS nonsense") forbids the Tester's first suggestion. State that needs surfacing goes in the existing per-slot / flag vocabulary, not chrome.
- **No explainer copy.**
- **"when someone comes online, they sync."** Whatever the surface, it must read as retryable/transient, never as "this device is blocked."

The tension: the owner wants a degraded-sync state *noticed*, but also forbids the usual attention-grabbing mechanism (a banner). Resolving that tension — how much prominence, in what vocabulary — is an information-architecture judgment that is the owner's, and bigger than T275.

## Candidate directions (options for the owner — NOT a recommendation, do not pick or build)

1. **A presence at the top of the Devices screen** — surface the not-running state (and retry) where a director goes when they suspect a sharing problem, rather than only in the gear popup.
2. **Elevate the sync indicator out of the gear popup** — give the sync/devices status a persistent, always-visible slot in the sidebar rail (as it had before PR #141), so a degraded state is visible without opening Settings.
3. **Leave it in the gear popup** (accept the current discoverability level) — valid if the owner judges that a director will learn to check Settings, or that the rarity of the state makes gear-popup visibility acceptable.
4. Something else in the existing flag vocabulary the owner prefers.

## Also noted (trivial, fold in if this neighborhood is touched)

- LOW pre-existing dead code: `src/components/layout/Sidebar.jsx:132` computes a `lan` sync label in the `renderItem` path for `item.key === 'devices'`, which is unreachable since the devices item is gear-menu-only. Safe to delete when this area is next edited; not worth its own change.
