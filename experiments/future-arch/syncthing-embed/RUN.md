# Running the syncthing-embed prototype

**Disposable.** Lives entirely under `experiments/future-arch/syncthing-embed/`, its own npm
project. Deleting this folder removes it completely — nothing outside it is touched.

## 1. Install deps

```bash
cd experiments/future-arch/syncthing-embed
npm install
```

`project.cjs` (the op-flow engine reused for P3) needs `better-sqlite3`, a native module. It is
built against your local Node ABI by `npm install`, but Electron runs a **different** Node ABI —
rebuild it for Electron before `npm start`, every time you `npm install`:

```bash
npx electron-rebuild -f -w better-sqlite3
```

(Same dance the main Shoresh app documents in its root `CLAUDE.md` for the same reason. If you
skip this step, `npm start` will crash on the native module load.)

## 2. Get the Syncthing binary (not committed)

Download the single self-contained executable for your platform from
https://syncthing.net/downloads/ (or `brew install syncthing` on Mac, which puts one on PATH).

Either:
- drop it at `experiments/future-arch/syncthing-embed/bin/syncthing` (or `bin\syncthing.exe` on
  Windows), or
- set the `SYNCTHING_BIN` env var to wherever it lives, e.g.:
  ```bash
  export SYNCTHING_BIN=/usr/local/bin/syncthing
  ```

If neither is present the app's window will show an error instead of silently hanging.

## 3. Run it on machine A

```bash
npm start
```

The window shows "My device ID" — click it to copy.

## 4. Run it on machine B

Same steps (`npm install`, binary, `npm start`) on the second machine. Copy **its** device ID too.

## 5. Exchange device IDs

- On machine A's window: paste **B's** device ID into "Add peer device ID", click **Add peer**.
- On machine B's window: paste **A's** device ID into the same field, click **Add peer**.

(Manual pairing is fine for this prototype — see the ticket's non-goals; auto-pairing is P4,
out of scope here.)

## 6. What success looks like

- Neither machine ever shows a Syncthing window, tray icon, or browser tab — only this
  prototype's own small window.
- Within a short wait (discovery + relay handshake), each window's status flips to
  **"Connected via Relay"** (or **Direct** if you're on the same LAN).
- Folder sync shows a percentage climbing toward 100%.
- Drop a test file into the shared folder on machine A:
  - `~/Library/Application Support/syncthing-embed-prototype/shoresh-sync/` (mac)
  - `%APPDATA%/syncthing-embed-prototype/shoresh-sync/` (Windows)
  - `~/.config/syncthing-embed-prototype/shoresh-sync/` (Linux)

  It should appear in the same folder on machine B within a few seconds (the watcher delay is
  tuned to 1s, per the spike's finding — default Syncthing's 10s batch is far slower).
- Quit the app on both machines (Cmd/Ctrl-Q or close the window). Check `ps`/Activity Monitor —
  no orphaned `syncthing` process should remain.

## 7. Operation flow (P3): converge an edit across machines

Once both machines are connected (step 6) and folder sync is at/near 100%:

1. On machine A, in the "Operation flow" section: leave the entity id as `archery`, choose
   `location`, type `Field 1`, click **Apply edit**.
2. Machine A's own entities table updates immediately (local-first) and the state hash changes.
3. Within a few seconds — Syncthing's watcher (tuned to 1s) picks up the new op file under
   `.../shoresh-sync/test-project.shoresh/journal/`, syncs it to machine B, and machine B's
   background poll (every 2s) notices it and applies it — machine B's entities table updates to
   show `archery | | Field 1` and its state hash updates to match machine A's.
4. **Convergence = the two "State hash" values are byte-identical.** That is the proof: the edit
   became an immutable op file, flowed through embedded Syncthing, and both independent SQLite
   engines reached the same state.
5. Now edit on machine B (e.g. entity `archery`, field `name`, value `Morning Archery`) and watch
   machine A converge the same way, in the other direction.

The `.shoresh` package (`test-project.shoresh/`, containing `project.json` + the `journal/` of
immutable op files) lives *inside* the Syncthing-shared folder, so Syncthing is simply replicating
files — it has no idea it's carrying operations. `project.cjs` (unmodified, reused as-is) is the
only thing that understands the op-flow semantics on either end.

## Scope note

This prototype proves **P1 (invisible in-Electron control)**, **P2 (folder share via the app)**,
and **P3 (operation flow over the embedded transport)**, per the ticket. It does not wire up
automatic peer discovery (P4) — that's a separate, out-of-scope slice. It does not touch the real
Shoresh app (`electron/`, `src/`) in any way.
