# Ticket: Syncthing-embed prototype (throwaway Electron shell)

**Status:** kicked off 2026-08-19. Isolated, disposable, on branch
`claude/shoresh-future-architecture-364e03`. **Does not touch the real app** (`electron/`,
`src/`) — lives entirely under `experiments/future-arch/syncthing-embed/`.

## Why
The investigation proved (field-tested) that embedded, tuned Syncthing gives live sync across
networks on locked-down machines with no cloud Shoresh runs (see `SYNCTHING_SPIKE.md`, ADR
evidence #8). Two unknowns are answered *in a node script*; the last engineering risk is whether
the same **invisible embed works inside a real Electron app** — bundling a native binary, managing
its process from the main process, and driving it via its API — which a standalone `.cjs` can't
fully derisk. This ticket builds the smallest Electron thing that proves it.

## Observable success predicate
A self-contained Electron app under `experiments/future-arch/syncthing-embed/` that, when run on
two machines pointed at each other:
1. **On launch, starts a bundled Syncthing process invisibly** — no Syncthing window, tray, or
   browser UI ever appears; only the prototype's own minimal window.
2. **Surfaces device id + connection/sync status in its OWN UI**, read from Syncthing's REST API.
3. **Keeps a shared folder in sync** between the two instances (create a file in one → appears in
   the other), with the watcher delay tuned low.
4. **Shuts Syncthing down cleanly** when the app quits (no orphaned process).
5. **Stretch:** wire the `.shoresh` package (reuse `project.cjs`) so an *edit in app A* becomes an
   op file, syncs, and *converges in app B* — end-to-end operation flow over embedded Syncthing.

## Non-goals (explicitly out of scope)
- Touching the real `electron/` or `src/` — this is a separate mini-app.
- The transport-seam rewire of real syncClient/syncServer (S1.4/S1.5) — separate program, full loop.
- Production packaging, code-signing, notarization, auto-update, multi-platform CI.
- Polished auto-pairing — manual device-id exchange (or a pasted id) is fine for the prototype.
- Battery/background-sync optimization.

## Slices (each small, reviewable; stop-and-check between)
- **P1 — Invisible in-Electron control.** ✅ BUILT (2026-08-19, verified: 4/4 JS `node --check`,
  isolation clean, headless + clean-shutdown logic present). Electron shell bundles the Syncthing
  binary, spawns it headless, waits for its REST API, shows device id + status in the app window;
  clean shutdown on quit. Reuses the proven `syncthing-spike.cjs` logic. **Needs live verification
  on two machines** (does the window launch, no Syncthing UI, REST succeeds against a real binary).
- **P2 — Folder share via the app.** ✅ BUILT. The app configures the shared folder + peer device
  over the REST API (watcher delay tuned to 1s). Live-verify: two instances connect + sync a file.
- **P3 — Operation flow.** ✅ BUILT (2026-08-19, verified: all JS `node --check`, `project.cjs`
  reused not forked, isolation clean). Edit in app A → immutable op via `project.cjs` into the
  `.shoresh` package inside the Syncthing folder → replicates → app B applies on its 2s poll →
  both UIs show a matching state hash. **Needs live verification on two machines** (better-sqlite3
  electron-rebuild succeeds; two instances actually converge; hashes match). The prototype
  (P1+P2+P3) is now complete and disposable.
- **P4 (later) — Auto-pairing** through a simple id-exchange, standing in for Shoresh's identity flow.

## Isolation & disposability
Self-contained npm project under `experiments/future-arch/syncthing-embed/` (own package.json,
own Electron dep). Deletable without affecting anything. The Syncthing binary is NOT committed —
a setup note tells the user where to drop it (or a script fetches it locally).

## Governance note
This is prototype/experiment work under the accepted parent ADR
(`docs/adr/2026-08-17-shared-project-multi-transport-sync.md`). Productionizing (embedding into the
real app) is a **separate** future program that must run the full Architect→Maker→Verifier→review
loop and its own tickets — not this throwaway.
