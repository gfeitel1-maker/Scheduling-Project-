---
title: "Auth / sync / desktop threat assessment"
document_type: reference
authority: descriptive
status: active
date: 2026-09-14
program: security-hardening
---

# Auth / sync / desktop threat assessment — 2026-09-14

First pass of the Tier-3 deep assessment (`docs/work/security/2026-09-14-security-program.md`),
run by the human + Claude rather than the yet-to-be-dispatched `security-assessment` agent. Scope:
the network peer-auth surface, CRDT-merge trust, and the Electron desktop surface. Assessed against
commit `449033f`.

**This is descriptive.** Findings are evidence-based and confirmed where marked; open questions are
labelled as such and are NOT findings. Where this disagrees with the code, the code is right.

## Boundary verdict

**Trusted-LAN boundary: HOLDS today; AT RISK on the roadmap.**

- *Today (confirmed):* `electron/sync/automerge/transport.js` uses `@libp2p/tcp` with
  `DEFAULT_LISTEN = ['/ip4/127.0.0.1/tcp/0']` (loopback) and `@libp2p/mdns` LAN discovery. No
  circuit relay, DHT, WebRTC/WebSockets/WebTransport, bootstrap list, or NAT traversal is present
  in `package.json` or imported in `transport.js`. The retired custom WebSocket server is deleted.
  So the "trusted private LAN" assumption is currently true in code.
- *Roadmap (at risk):* the parked "shared-document sync + Syncthing relay" work and the
  "productionize automerge/libp2p sync" track move toward internet reachability. libp2p makes that
  a small config change. The Tier-4 gate (`docs/adr/2026-09-14-internet-transport-security-gate.md`
  + `transportBoundary.guard.test.js`) now turns the build red if that lands without a recorded
  re-assessment. **This assessment's single most important outcome is that the boundary change can
  no longer happen silently.**

## Confirmed findings

### F1 — PROCESS — the agent-generator drift was not gated, and shipped undetected (MEDIUM)
The `security` agent profile is *generated* from `docs/governance/agent-bindings/security.md` +
org fragments (`scripts/generateAgentProfiles.js`). An earlier change (PR #383) hand-edited the
*generated* `.claude/agents/security.md` directly, so it diverged from its binding — and `npm run
agents:check` is **not** part of `npm run verify`, so the drift shipped unnoticed. Confirmed:
`agents:check` reported `DIFFERS security.md` on a clean tree before this work.
- *Impact:* agent instructions can silently diverge from their source of truth; a regenerate would
  (and did, mid-this-work) revert hand-edits.
- *Fixed here:* the additions were re-homed into the binding and the profile regenerated (now
  `match`).
- *Residual / recommendation:* `agents:check` depends on `~/.claude/organization` being present, so
  it cannot join `verify` without breaking portable clones/CI that lack the org package. Options:
  (a) make `agents:check` a soft step that skips-with-warning when the org dir is absent and fails
  when present; (b) a pre-commit hook. Left as a recommendation, not silently forced into `verify`.

## Open questions (need investigation before they are findings or dismissed)

### Q1 — CRDT-merge trust: blast radius of a compromised paired device (HIGH leverage)
Merges do not route through `authorize()` — role enforcement is device-side under CRDT sync
(`SECURITY.md`, accepted). A paired device whose credentials/secret are compromised can author ops
that merge onto every peer. *What to settle:* enumerate exactly what such ops can change (can a
`staff`-paired device emit ops a `staff` role could not via IPC? can it resurrect accounts or alter
`devices`/`users`?) and whether projection guards (`applyProjection`'s `camp_id` guard,
`RESTORE_DECISIONS`) bound it. This is the highest-leverage open question because it is the trust
assumption that most changes character once peers are not all on a trusted LAN.

### Q2 — Frame-size × connection memory ceiling (MEDIUM)
`MAX_FRAME_BYTES = 32 MiB` (`wireProtocol.js`) × `MAX_CONNECTIONS = 200` (`transport.js`) bounds a
single hostile peer per-frame, but the product is a large transient memory envelope if many peers
each send a max frame concurrently. *What to settle:* is the effective bound acceptable on a camp
laptop, and does Stage 5's incremental sync (the comment says it will shrink a frame to a delta)
let `MAX_FRAME_BYTES` drop sharply? On a trusted LAN this is low-risk; it rises with peer count and
would rise sharply with internet exposure (ties to the Tier-4 re-assessment).

### Q3 — Noise channel vs. membership (LOW, likely already covered)
`mutualAuth.js` + `authGate.js` require a valid `authenticate` frame carrying a verified session
token before admission; the token is the membership proof, and Noise provides the channel. This
appears correct. *What to settle:* confirm there is no path where a completed Noise handshake alone
(without a verified `camp` token) reaches `onDocReceived` — i.e. that protocol-gating + the auth
gate are the only doors. The `wireProtocol.js` comments assert this; verify by tracing every
`node.handle(...)` registration.

### Q4 — Rate-limit state growth (LOW, acknowledged in code)
`authGate.js` intentionally never clears rate-limit bookkeeping on disconnect, bounded (per its own
comment) by how many distinct peer/device ids a peer can cheaply mint. *What to settle:* whether
that bound is comfortable over a long-running Host session, or wants a periodic sweep.

## Electron desktop surface (evidence-based)

- **Good (confirmed):** `contextIsolation: true`; the renderer loads a local `dist/index.html` (or
  the dev server), not remote content; preload exposes a fixed `window.shoresh.*` surface via
  `contextBridge`.
- **Hardening gaps (open items, not exploits today):**
  - `nodeIntegration` and `sandbox` are **not set explicitly** — they rely on modern-Electron
    secure defaults (`nodeIntegration:false`, `sandbox:true`). Recommend setting both explicitly so
    a future Electron default change or a copy-paste of the `webPreferences` block can't silently
    weaken them.
  - **No explicit Content-Security-Policy** on the renderer. Defense-in-depth against any XSS that
    slips past React's escaping; low cost to add for a local-content app.
  - **No `setWindowOpenHandler` / `will-navigate` guard.** A link or `window.open` in the renderer
    can navigate/open arbitrarily. Low risk with contextIsolation + local content, but a cheap
    hardening.
  - **No auto-update mechanism today** (`electron-updater`/`autoUpdater` absent; distribution is a
    per-user NSIS installer + macOS build). So there is no unsigned-update RCE vector *now* — but
    **auto-update is a hard prerequisite gate for any internet transition**: it must ship signed and
    integrity-checked, and that belongs in the Tier-4 re-assessment, not bolted on later.

## Recommended next assessment targets

1. Settle **Q1** (CRDT-merge blast radius) — highest leverage; likely its own written analysis.
2. A dedicated **Electron desktop hardening** pass (the four gaps above), landed as one small PR.
3. Re-run this assessment (via the `security-assessment` agent) the moment the Tier-4 gate is
   proposed for sign-off.
