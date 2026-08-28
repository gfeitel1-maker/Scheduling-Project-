---
title: "ADR: Stage-Aware Navigation + Landing Routing/State-Machine (WS1)"
document_type: adr
status: proposed
authority: normative
implementation_state: proposed
date: 2026-08-28
deciders: [product-owner]
task_class: architecture
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_specs: [docs/work/specs/2026-08-28-lifecycle-ia-program.md]
related_adrs: [docs/adr/2026-08-22-roots-as-hub-setup-ia.md, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md, docs/adr/2026-07-24-centralized-authorization-layer.md, docs/adr/2026-07-28-explicit-userdata-directory.md]
refines: [docs/work/specs/2026-08-28-lifecycle-ia-program.md]
supersedes: []
affects: [src/App.jsx, src/hooks/useDeviceMode.js, src/components/layout/Sidebar.jsx, src/components/layout/navSections.js, src/components/layout/sidebarState.js, electron/main.js, electron/auth/permissions.js]
---

# ADR: Stage-Aware Navigation + Landing Routing/State-Machine (WS1)

## Context

WS1's Designer spec (`WS1-ia-spec.md`) is approved for the nav reorganization
(five stages: fixed Roots row + Germination/Sprouts/Plants collapsible
sections) and specifies the landing behavior in product terms: an empty camp
lands on a new "Seed your camp" screen, a camp with data always lands on
Roots, for whoever is looking — host or joined staff — with no role
distinction. The Designer's spec flags one item explicitly for Architect
sign-off before Maker builds it:

> `brandNew` must be available (readiness already loaded) at the `useState`
> initializer, not computed after mount... Confirm with Architect whether
> readiness is synchronously available at that point today... if not, this is
> the one place WS1 touches state-machine timing, not just labels, and needs
> Architect sign-off.

This ADR resolves that question (it is not — see Decision 1), and resolves a
second question the spec surfaces but defers: the product requirement that
seeding must work for joined staff, not just the Host, collides with an
existing IPC-layer gate that is host-only for a data-integrity reason, not a
cosmetic permission reason (see Decision 2).

### Current state, verified against code

**Landing today (`src/App.jsx`):** `AppShell`'s `screen` state initializes
unconditionally to `'roots'` (`useState('roots')`, line 106). There is no
empty-camp landing screen today; `roots` renders `ReconciliationScreen` in
all cases, and that screen computes its own `brandNew` internally.

**`brandNew` today is not available at mount, anywhere above `Reconciliation
Screen`.** It is computed at `ReconciliationScreen.jsx:469` from
`inspectReadiness`, which is `getReadiness(...)` run over collections that
`fetchReadiness()` (`ReconciliationScreen.jsx:54-64`) fetches via `await
localClient.list(...)` calls issued **inside `ReconciliationScreen`'s own
effect**, after that screen mounts. `App.jsx` and `useDeviceMode.js` never
touch readiness at all today. The Designer's spec's proposed reuse ("the same
boolean `rootsBanner.jsx` already computes... reused as the initial-screen
predicate instead of recomputed") is not actually reusable at the `AppShell`
mount point without moving where that computation happens — there is nothing
to "reuse" synchronously; it doesn't exist yet at that point in the tree.

**There is already a pre-paint gate to hang this off, though.**
`App.jsx:327`: `if (device.phase === 'loading') return null` — the app
already blocks first paint on `useDeviceMode`'s `init()` effect (which awaits
`refreshCamp()` and `verifySession()`) before rendering anything past a blank
screen. This is the existing seam WS1 should extend, not a new one.

**Import/seed gating today (`electron/main.js:281-410`):** two distinct
gates, independently enforced, both currently host/admin-restricted:

1. **Role gate.** `ingestCommit`/`ingestReconcile` both call
   `requireAuthorized(db, { token, action: 'groups.import' })`.
   `'groups.import'` is deliberately absent from `PERMISSIONS.staff` in
   `electron/auth/permissions.js` — default-deny makes it admin-only. Comment
   at `main.js:283-286`: "creating a camp's whole structure in one action is
   a different kind of authority" than the per-record staff write access
   setup screens already grant.
2. **Device gate, commit path only.** `ingestCommit` (`main.js:297-303`)
   additionally throws if `mode === 'client'` — this is **not** a role check,
   it is a data-integrity check: `commitIngest` appends ops straight to the
   local SQLite of whichever device runs it, bypassing `syncClient.write`
   entirely (comment at `main.js:288-296`). Run on a Client, that write is
   invisible to the Host and every other peer, silently forking the camp.
   `ingestReconcile` (the dry-run path) explicitly does **not** carry this
   guard (`main.js:361-364`) — a dry run writes nothing anywhere, so there is
   no fork risk to gate.

**Setup-screen writes are already staff-reachable, unconditionally.**
`ENTITIES` in `permissions.js` grants `staffReadWrite` (read+write) on
`tiers`, `groups`, `days_of_operation`, `time_blocks`, etc. — every table the
"Start by hand" path touches. Only `delete`/`bulk_replace` on those tables
stay admin-only via default-deny. So half of the Seed screen's two actions
already works for joined staff today, on any device, with zero permission
change.

## Decision 1 — landing predicate: compute a lightweight camp-data-state
flag inside the existing `useDeviceMode` init gate, not inside `AppShell`

**Do not reuse `brandNew`/`ReconciliationScreen`'s readiness engine call as
the landing predicate.** Introduce a separate, smaller predicate purpose-built
for routing, computed once, before first paint, in the phase that already
exists for exactly this kind of pre-paint blocking work.

### Mechanism

1. Add one query to `useDeviceMode`'s `init()` effect (`src/hooks/
   useDeviceMode.js:76-139`), issued in the same `try` block as `refreshCamp()`
   and gated the same way: `const hasSetupData = await
   localClient.campHasSetupData()`. This runs once per app open (or retry),
   inside the window `device.phase === 'loading'` already covers — no new
   flash, no new phase.
2. `campHasSetupData` is a **new, narrow IPC call** (`electron/main.js`, a
   sibling to `getCamp`), not a reuse of `getReadiness`'s five-collection
   fetch-and-evaluate. It runs a single `SELECT EXISTS(...)` (or a handful of
   `COUNT(*)`) across `REQUIRED_AREAS`' underlying tables
   (`tiers, groups, days_of_operation, time_blocks` — the same set
   `getSetupGaps` already treats as the blocking core in `src/engine/
   readiness.js`) and returns one boolean: `true` if every required table is
   empty. This is deliberately **not** `getReadiness`'s full engine
   evaluation (which also folds in `signals`/attention/in-progress state for
   the Roots banner's per-row marks) — the landing decision only ever needs
   the single "is this camp truly untouched" bit, and computing it as a cheap
   SQL existence check avoids paying for five `list()` round-trips and an
   engine pass just to route.
3. `useDeviceMode` exposes this as `device.campIsEmpty` (boolean, defined
   only once `phase !== 'loading'`).
4. `App.jsx`'s `AppShell` receives `campIsEmpty` as a prop (alongside
   `campId`/`role`/`mode`) and its `screen` state initializes as
   `useState(() => campIsEmpty ? 'seed' : 'roots')` — this **is** the
   synchronous read the Designer's spec wanted; it's just synchronous
   relative to `AppShell`'s mount, which now happens only after the value is
   already resolved, rather than synchronous relative to some in-tree
   computation.
5. `ReconciliationScreen`'s own `brandNew` (used for the "Import last year"
   vs. "Re-import last year" button on the Roots banner itself) is
   **unchanged** — it keeps computing its own full readiness engine pass for
   its own per-row marks, because it needs kind/state per area, not one
   bit. WS1 does not touch `rootsBanner.jsx` or `ReconciliationScreen`'s
   readiness fetch.

### Why this over the alternatives considered

The Phase-1 divergence surfaced three real shapes for this: (a) render
nothing until the predicate resolves (push the fetch earlier, keep the
existing blank-screen gate), (b) let each screen self-select via independent
local sensing (no shared predicate at all), (c) make the predicate a
decaying/pushed value rather than a query. (a) is the smallest, most
reversible change and reuses a gate that already exists and already has this
exact job (blocking paint on device/session init) — no new architectural
concept. (b) (ant-colony: SeedScreen and RootsScreen both mount hidden and
race their own readiness checks) was rejected as a trap: it reintroduces
exactly the race the regulator and inversion frames flagged (two components
independently reading async state can resolve in either order, reproducing
the flash this ADR exists to kill) for no benefit over a single owned
predicate. (c) (push/decay model) was rejected as solving a problem WS1
doesn't have — there's no multi-device consistency requirement on this
specific bit within a single device's session init; that's YAGNI for a
landing screen.

### Landing decision table

| Camp data state (via `campHasSetupData`) | Session established? | Lands on | Notes |
|---|---|---|---|
| No rows in any required table (`campIsEmpty = true`) | yes (`phase === 'session'`) | `seed` | Regardless of role or host/client mode — the spec's requirement, computed from data, not identity. |
| ≥1 row in any required table (`campIsEmpty = false`) | yes | `roots` | Same for every return visit, every user, every device. |
| — | `phase !== 'session'` (mode-select/bootstrap/join/pairing/login/error/loading) | *(unchanged — existing `useDeviceMode` phases, untouched by this ADR)* | WS1 does not touch pre-session phases. |
| A device navigates away from `seed` (e.g. "Start by hand" → `tiers`) then back to the app later, camp now has data | yes | `roots` | `campHasSetupData` is re-evaluated fresh on every app open (`initNonce` bump / mount), never cached across sessions — see Red Hat note on staleness below. |

## Decision 2 — permission change: loosen the role gate only; do not
loosen the device gate; the "Client seeds directly" case is out of WS1 scope

The spec's product requirement ("seeding must be available to joined staff
too, not host-only") is ambiguous between two different changes, and they
carry very different risk:

**(a) Role loosening — staff (not just admin) can trigger import, on
whichever device is already permitted to run it.** Add `'groups.import'` to
`PERMISSIONS.staff` in `electron/auth/permissions.js`. This is small,
contained, and reversible: `commitIngest`'s logic, the `mode === 'client'`
guard, and every other IPC gate are unchanged. A non-admin staff member
logged in **on the Host device** can now run the initial import. This alone
satisfies "not admin-only."

**(b) Device loosening — a staff member on a joined Client device can
trigger the import themselves, from their own machine.** This requires
removing or bypassing the `mode === 'client'` guard on `ingestCommit`
(`main.js:297-303`). That guard is not a permission nicety — it exists
because `commitIngest` writes directly to the calling device's own SQLite,
bypassing `syncClient.write`/the op-log entirely. Removing it does not grant
a permission; it reintroduces the exact data-fork bug T61's guard was added
to prevent (import runs on the Client's own DB, Host and every other peer
never see it, "success" banner lies). Achieving (b) safely requires a new
capability that does not exist today — a Client-initiated import request
relayed to and executed by the Host over the sync protocol, with the result
broadcast back — which is a **protocol change**, not a routing change, and
is out of scope for a nav/landing ADR.

**Decision: WS1 ships (a) only.** `groups.import` moves from admin-only to
staff-read-write. The `mode === 'client'` guard on `ingestCommit` stays
exactly as-is. Consequence for the landing screen: a joined-staff user on a
Client device who lands on `seed` and taps "Import last year" still hits
`ingestCommit`'s existing `'Import can only be run on the main computer.'`
error — **this is not a regression WS1 introduces; it is today's behavior,
unchanged.** "Start by hand" is unaffected either way (already staff- and
Client-reachable today via the existing per-record write grants).

This is a real, visible product gap the spec's "host or joined staff, no
distinction" framing does not fully close, and it needs an explicit answer
from Governor/owner (see Open Questions) rather than being silently
resolved by omission.

## Decision 3 — nav-structure changes

Adopt the Designer's spec verbatim for `navSections.js`/`Sidebar.jsx`/
`sidebarState.js`: promote Roots to a fixed, chevron-less top row; replace
the `setup`/`schedule` two-section model with `germination`/`sprouts`/
`plants` three collapsible sections using the existing `sectionRollup`/fold
mechanism; drop the `rootsOpen` persisted key; add `germination`/`sprouts`/
`plants` to the persisted `sections` map, default-open, matching current
behavior for `setup`/`schedule`. Fixed Events gets a new nav row/route key
(`fixedevents`), routed to a placeholder (`AnchorsScreen` filtered
all-camp-scope) until WS2 lands the real entity split — WS1 does not build
`FixedEventsScreen`. This is UI-only restructuring of existing rollup/chevron
code paths; no new interaction pattern, no schema touch. No ADR-level
tradeoff here beyond what's already recorded in
`docs/adr/2026-08-28-fixed-vs-recurring-events.md` (two rows, not one screen
with a mode switch) — WS1 just wires the nav entry.

## Files/modules affected

- `src/hooks/useDeviceMode.js` — add `campHasSetupData()` call inside
  `init()`; expose `campIsEmpty` on the returned object.
- `src/App.jsx` — `AppShell` receives `campIsEmpty` prop; `screen` initial
  `useState` becomes `campIsEmpty ? 'seed' : 'roots'`; add `seed: SeedScreen`
  to `SCREENS`; `App()` passes `campIsEmpty={device.campIsEmpty}` to
  `AppShell`.
- `electron/main.js` — new `campHasSetupData` handler (single existence
  query over required-area tables) + IPC registration
  (`shoresh:camp-has-setup-data` or similar, mirroring `getCamp`'s pattern).
- `electron/preload.js` — expose the new call on `window.shoresh`.
- `electron/auth/permissions.js` — add `'groups.import'` to
  `PERMISSIONS.staff`.
- `src/components/layout/navSections.js`, `Sidebar.jsx`, `sidebarState.js`
  — per Decision 3 / Designer's spec Implementation Notes 1–3, 7.
- New: `src/screens/SeedScreen.jsx` — per Designer's spec composition
  (two buttons, no internal state beyond the two `onNavigate` calls).
- `src/localClient.js` (or its mock counterpart used by browser-mock dev) —
  add `campHasSetupData` alongside existing methods, including the
  browser-mock's no-op/seeded-demo behavior.

## Reused vs. new

**Reused:** `useDeviceMode`'s existing `loading` phase and `init()` effect
(the pre-paint blocking gate); `REQUIRED_AREAS`'/`getSetupGaps`'s existing
notion of which tables constitute "the blocking core" (same set, cheaper
query, not the same function call); `Sidebar.jsx`'s existing
`sectionRollup`/chevron/fold-state mechanism; the existing staff
`ENTITIES`/`PERMISSIONS` default-deny pattern (one new entry, no new
mechanism); `ingestReconcile`'s existing precedent that a dry-run path can
carry a different (lighter) gate than the commit path.

**New:** `campHasSetupData` IPC call (new, small — a single existence query,
not a reuse of `getReadiness`); `SeedScreen` component; one `PERMISSIONS.staff`
grant; three renamed/regrouped nav sections (relabeling existing mechanics,
per Designer's spec).

**Explicitly not built:** any Client→Host import-request relay (Decision 2);
`FixedEventsScreen`'s real implementation (WS2's job); any change to
`ReconciliationScreen`'s own readiness computation or `rootsBanner.jsx`.

## ADR required: yes

This ADR is filed at `docs/adr/2026-08-28-stage-aware-navigation-and-landing-
routing.md` (this document). It meets the bar on two independent grounds:
(1) it changes an existing auth contract other code depends on
(`PERMISSIONS.staff` gains `groups.import` — `permissionsEntityParity.test.js`
and the default-deny posture other entities rely on for their own admin-only
exceptions are precedent other future changes will read), and (2) it makes a
non-obviously-reversible architectural choice about where a piece of
app-boot state lives (landing predicate computed in the device/session init
gate, not recomputed per-screen) that the next person touching either
`useDeviceMode` or `ReconciliationScreen` needs to understand was deliberate,
not accidental duplication.

## Open questions for Governor

**All resolved during owner review (2026-08-28):**

1. ~~Decision 2 scope confirmation.~~ **Decided: (a) — staff role can seed on
   the Host.** The owner confirmed "on the camp computer is enough." This ADR
   loosens only the role gate (`groups.import` → staff); the device gate
   (Client import bypassing the op-log) stays untouched. A staff member
   importing from their own Client device is **not required** — it is not
   built here and no future workstream is opened for it unless the owner
   revisits.
2. ~~`campHasSetupData` staleness across a multi-device session.~~ **Decided:
   accept for WS1.** A Client that was empty at launch may show `seed` until
   its next app open even if the Host imports moments later; this
   self-corrects on next launch or the moment the Client navigates and
   refetches — nothing is silently wrong. Live invalidation is not built now;
   logged as a future-ticket / Red Hat item.
3. ~~Special Events single-row vs. two-row-with-subheading.~~ **Decided: keep
   the two existing rows (Events / Special Days) under a quiet "Special
   Events" sub-heading**, matching the codebase's existing display-group
   pattern (the Designer's recommendation). No literal merge.
