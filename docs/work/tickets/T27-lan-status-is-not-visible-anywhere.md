---
title: T27-lan-status-is-not-visible-anywhere
document_type: ticket
status: open
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

## Completion evidence

1. The renderer can read whether this device is Host, Client-connected, Client-disconnected, or
   standalone, without triggering a mode change.
2. The value updates when the state changes, rather than only at mount.
3. The sidebar's LAN & Devices row shows it, in a director's words.
4. A test covers the disconnected case specifically — it is the state that matters most and the
   one least likely to be exercised by hand.
