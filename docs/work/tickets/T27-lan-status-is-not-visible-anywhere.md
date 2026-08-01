---
title: T27-lan-status-is-not-visible-anywhere
document_type: ticket
status: completed
created: 2026-08-01
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: resolved
---

# T27 — Nothing in the app says whether this device is the Host, a Client, or alone

**Risk:** Medium. The whole product is a LAN app, and its most basic state is invisible.
**Found:** 2026-08-01, building the sidebar's System section.

---

## What happens

The sidebar's System section was specified with a LAN row showing `host` as its meta
([handoff spec](../specs/2026-07-31-sidebar-and-setup-readiness-handoff.md) §3). It was built
without that status, because **the renderer cannot ask.**

`electron/preload.js` exposes `chooseMode` and `discoverHosts` — both *actions*. Neither answers
"what am I right now". There is no `getMode`, no `getSyncStatus`, nothing on
`window.shoresh.*` that reports whether this device is serving as Host, connected as a Client,
or running alone with no peers.

## Why it matters

Every confusing thing about a LAN app reduces to this question, and a director has no way to
ask it:

- *"Why can't the other iPad see the schedule I just made?"* — because this device is a Client
  that has not reached the Host, or because the Host laptop is closed.
- *"Why is Trash showing records waiting for the main computer?"* — the Trash screen already
  says "Waiting on the main computer", which presumes the director knows which computer that is.
- Deleting a used record saves a version and warns about recovery, which is materially different
  advice depending on whether this device can currently reach anyone.

The app already reasons about this internally — `syncClient` knows if it is connected,
`syncServer` knows if it is listening, `discovery` knows what it found. None of it surfaces.

## Where to look

- `electron/preload.js` — the `contextBridge` surface. Adding a read is small; the question is
  what shape it takes.
- `electron/main.js` — holds the chosen mode and the live client/server handles.
- `electron/sync/syncClient.js` — `waitUntilConnected` and the socket state already exist.
- `electron/sync/discovery.js` — what mDNS has found.

## Design notes, not decisions

- **A status, not an action.** This must not become a second way to change mode; `chooseMode`
  already does that, and a status read that can reconfigure the device is a bigger change than
  it looks.
- **It has to update.** A value read once at mount will be wrong within minutes — a laptop
  closes, wifi drops. Whatever is added should push (like `onOpApplied`) or be cheap to poll.
- **Say it in camp language.** Not "host", "client", "socket", "mDNS". A director's version of
  this is closer to *"This computer is the main one"* / *"Connected to the main computer"* /
  *"Working on its own — changes will sync when it finds the main computer."*
- The sidebar row is one consumer, and probably not the only one. The Trash screen's "waiting"
  list and the conflict copy both currently assume knowledge the director does not have.

## Resolution — 2026-08-01

`syncClient` gained `isConnected()` and `onConnectionChange()`; `main.js` gained `getSyncStatus()`
returning one of four states, exposed as `shoresh:get-sync-status` plus a
`shoresh:sync-status-changed` push. The sidebar's **LAN & Devices** row shows it.

Two decisions worth recording:

**Read-only, enforced by shape.** `getSyncStatus` takes no arguments and returns a snapshot. It
cannot start a server, join a host, or change the mode — `chooseMode` remains the only way to do
that. A status call that could reconfigure the device would be a far larger change than it looks.

**`standalone` and `client-disconnected` are different states, deliberately.** A device that never
joined anything is working correctly; a client that has lost the Host is not. Collapsing them
into "not connected" would hide the only case worth acting on. The copy differs accordingly —
*"This computer is not sharing with any other yet"* versus *"Cannot reach the main computer right
now. Your changes are saved here and will reach it when it is back."*

The second half of that sentence is the point: the failure a director fears is losing work, and
they are not losing it.

**One thing my own test caught.** The first draft of the host copy read *"Others sync to it"* —
"sync" is exactly the developer vocabulary the test forbids. Reworded to *"The others follow what
is on it."*

## Completion evidence

1. The renderer can read all four states without triggering a mode change — **met**: the handler
   takes no arguments and returns a snapshot.
2. The value updates when the state changes — **met**: `onConnectionChange` fires on the socket's
   open and close, pushed to the renderer as `shoresh:sync-status-changed`.
3. The sidebar's LAN & Devices row shows it in a director's words — **met**: `main` / `linked` /
   `alone` / `on its own`, with a fuller sentence on hover. A test asserts no developer
   vocabulary reaches either.
4. A test covers the disconnected case specifically — **met**, and it asserts the thing that
   matters: that disconnected is distinguishable from standalone, and that its copy says the work
   is safe.

Not done, and out of scope: the Trash screen still says "Waiting on the main computer" without
saying which computer that is, and the conflict copy makes the same assumption. Both are now
answerable — the status is available to any screen that wants it.
