# Export & Share a Schedule to a Professional-Network Archive

Date: 2026-09-16
Status: approved (owner), not yet implemented
Depends on: docs/superpowers/specs/2026-09-15-licensing-and-app-menu-design.md (the File menu this item lives in)

## Goal

A camp director can send a finished schedule to a shared Google Drive owned by a
professional network the director subscribes to, so the field retains scheduling
knowledge that otherwise leaves with each director who turns over.

## Success predicate

1. **File → Export & Share to Network Archive…** exists in the application menu.
2. Invoking it asks which route (Manual or Generated) and does **not** remember
   the answer.
3. It writes an `.xlsx` built by the **existing** `src/utils/exportWorkbook.js`,
   reveals the file in the OS file manager, and opens the archive URL in the
   default browser.
4. The message shown to the director states what actually happened — the file
   was written and the folder was opened — and never claims the schedule was
   shared.
5. Every failure (workbook build, file write, browser open) is surfaced, never
   swallowed.
6. The archive URL and network label exist in exactly **one** named constant.

## Non-goals

- **No Google Drive API, OAuth, client id/secret, or token storage.** See D1.
- **No automatic or background upload**, no folder watcher, no scheduled sync.
- **No de-identification layer.** See D4 — there is no person data to remove.
- **No settings UI** for the archive destination. See D5.
- **No new export path or sheet builder.** See D3.
- **No unsend, no delete-from-archive.** Out of scope and out of our control.

## Decisions

### D1 — The browser hand-off, not a filesystem write or an API

The app exports the file, reveals it, and opens the archive URL. The director
signs in and drops the file in themselves.

Two alternatives were designed and rejected:

**Write into a synced Drive folder** (the director picks
`~/Library/CloudStorage/GoogleDrive-<acct>/Shared drives/<name>/` once). Rejected
because it requires the Google Drive desktop client — and the owner's network is
mixed/unknown on that point, so it would silently exclude browser-only
directors. It also needs a stored per-device path (a whole storage-location
decision, see D6) and, worst, **Drive's virtual filesystem can accept a write
that never syncs** — so the app could only ever honestly claim "written to a
folder," not "reached the archive."

**Google Drive API + OAuth.** Rejected: Shoresh is going open source under
Apache-2.0, so an embedded OAuth client would be published with the source. It
also introduces the first network path into a deliberately local-first product,
with token refresh, retry, and offline-failure handling — substantial ongoing
surface for a feature whose job is "put a file somewhere."

The browser hand-off's confirmation is **the director watching the upload
complete**, which is stronger evidence than anything the app could synthesize.
Its cost is one drag-and-drop, a handful of times per summer.

### D2 — It belongs in the File menu

The licensing spec (D5 there) deliberately kept About and Licenses **out** of
File, reserving it for document actions. This is that document action.

### D3 — Reuse `exportWorkbook.js` unchanged

No new sheet builder. This is load-bearing rather than merely tidy: every user
string in an export must route through `aoaToSanitizedSheet`
(`src/utils/exportSanitize.js`), the formula-injection boundary from
`docs/adr/2026-08-08-export-formula-injection-sanitizer.md`. A second export path
is precisely how that boundary gets bypassed. This design has no second path.

The stakes are higher than for a local export: the file lands in a shared folder
where colleagues open it without thinking.

### D4 — There is no person data to strip

Verified against the schema rather than assumed. Shoresh has **no camper,
counselor, or staff records** — it schedules *groups* into *time blocks* at
*locations*. The only person-shaped rows are `users_new` (app login accounts,
`role IN ('admin','staff')`), which are authentication and never appear in an
export.

So "just the schedules, not the people" is a property of the data model, not a
filter to build. No scrubbing layer, no de-identification toggle.

### D5 — Camp attribution is existing behavior, not a new choice

The export already carries the camp's name. Attributed-vs-anonymous was
considered and found moot: in a subscriber network, provenance is much of the
value, and the current behavior already provides it. No toggle.

### D6 — Configuration lives in one named constant

The archive URL and the network's display name go in a single documented module
(e.g. `src/config/networkArchive.js`), identified as the thing a fork changes.

Rejected: a settings screen (unearned for v1) and scattering the URL through
call sites. A hardcoded destination is acceptable *because* it is in one obvious
place — an open-source fork points it elsewhere or removes the menu item.

Note this also means **no per-device stored path exists**, so the
device-local-vs-Automerge storage question raised by the rejected folder design
does not arise. Nothing about this feature is replicated.

### D7 — Route asked every time, never remembered

`CLAUDE.md` standing rule: neither the Manual nor the Generated route is
canonical, and where exactly one is required — it names **export** specifically
— the director chooses at that moment and the choice is not remembered. The
share flow obeys this; it may not default to, or learn, a route.

Electives and special days ride along with the chosen route.

### D8 — The action is the consent

Nothing leaves the camp without a human invoking a menu item that says what it
does. There is no opt-in checkbox to store, because there is no background
behavior to consent to.

Corollary that must shape the copy: **there is no un-send.** Once a file is in
the shared Drive it is in colleagues' hands. The flow states the destination
before doing anything.

## Components

### C1 — `src/config/networkArchive.js`

```
export const NETWORK_ARCHIVE = {
  label: '<network display name>',   // menu item text
  url: '<shared Drive folder URL>',  // opened in the default browser
}
```

Owner supplies both values. The module carries a comment stating that a fork
changes or removes this.

### C2 — Archive filename (pure function)

A shared folder accumulating hundreds of files from dozens of camps is only
useful if scannable:

```
<Camp Name> — <season year> — <Manual|Generated> — <YYYY-MM-DD>.xlsx
```

Pure, unit-testable, and the one piece of real design judgment here. Must
sanitize path-hostile characters (`/`, `:`, NUL) out of the camp name — a camp
name is user input and this value becomes a filesystem path.

### C3 — Route prompt

Reuses whatever route-selection affordance the existing export flow uses, so a
director meets one consistent question. Cancelling writes nothing.

### C4 — Main-process handler

New IPC handler + `contextBridge` entry (`electron/preload.js`,
`electron/main.js`), sequencing:

1. Build the workbook via the existing export path.
2. Write it to a stable, obvious location (Downloads, or the OS default).
3. `shell.showItemInFolder(path)` — reveal it under the director's cursor.
4. `shell.openExternal(NETWORK_ARCHIVE.url)` — open the archive.
5. Return a structured result describing what happened.

Authorization: routed through `authorize()` per the standing rule for handlers,
even though this is read-only with respect to camp data.

### C5 — Menu wiring

Adds the item to the **File** menu built in `electron/menu.js` (licensing spec
C4). The pure `buildMenuTemplate` gains an `onShareToArchive` callback, so the
item's presence and placement stay testable without Electron.

### C6 — Result copy

States only what was verified: the file's location, and that the archive folder
was opened. It must **not** say "shared," "uploaded," or "sent." Wording per the
project's standing rule against claiming an unverified outcome.

## Failure handling

Every step surfaces through `describeWriteFailure`, per the standing rule that
no mutation may fail silently:

| Failure | Behavior |
|---|---|
| Workbook build throws | Report it; write nothing; do not open the browser |
| File write fails (permissions, disk full) | Report the real error; do not open the browser |
| `openExternal` fails (no browser, bad URL) | Report it, and still report where the file is — the file is the recoverable half |
| Director cancels the route prompt | No-op, no error, no file |

**Ordering is load-bearing:** the browser opens only after the file exists.
Opening an upload page with nothing to upload is a worse outcome than a plain
error.

## Testing

| Target | Assertion |
|---|---|
| filename builder | expected shape for Manual and Generated; camp names containing `/`, `:`, and NUL are sanitized |
| `buildMenuTemplate` | the File item is present and correctly placed; standard roles still intact |
| handler | calls the existing export path — **not** a hand-built sheet (guards the sanitizer boundary) |
| handler | browser is **not** opened when the file write fails (the negative case that matters) |
| handler | each failure mode returns a described error, never a silent success |
| route | no persisted route preference is written or read (D7) |

Full `npm run verify` before done. Other sessions are active in this repo —
run the whole gate at top level and not under heavy load.

## Open risks

- **Owner must supply** the network label and Drive folder URL (C1). The feature
  cannot be finished without them, though it can be built and tested with a
  placeholder.
- **A Drive folder URL can change** if the network reorganizes. One constant
  keeps that a one-line fix, but nothing detects it — a stale URL opens a
  "no access" page. Accepted; detection is not worth building.
- **Non-subscribers** who open the URL get Google's access-denied page. Correct
  behavior, but the copy should not promise the folder will open successfully.
