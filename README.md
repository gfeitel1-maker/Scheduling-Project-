# Shoresh

Shoresh is a scheduling app for summer camps. It builds and keeps the weekly
schedule: which group does which activity, where, and when. You stay in charge
of the decisions.

It runs on the camp's own computers. There is no account to create and no
company server holding your camp's data: the schedule lives on your devices and
syncs directly between them.

---

## For a camp director

### What it does

- **Set up your camp once.** Groups and age divisions, days, time blocks,
  activities, locations, fixed events (meals, flag, rest hour), recurring
  events, and special days such as trips.
- **Bring last year's schedule in.** Import the spreadsheet or text file you
  already use. Shoresh reads it and creates the camp from it. It asks only about
  what it can't tell on its own, and remembers your answers for next time. An
  import can be undone.
- **Two ways to build the week.**
  - **Manual Build**: you place every cell, the way a spreadsheet works.
  - **Generated Schedule**: the engine proposes a full week that respects your
    rules, and you adjust it by dragging and dropping.

  The two coexist, and switching between them never loses work.
- **See what needs attention.** Cells nothing can fill, activities a group
  doesn't get often enough, and a group booked in two places at once are all
  flagged where they happen.
- **Lock what must not move.** Generate again and your locked choices stay.
- **Versions.** Named snapshots of a week, and an automatic one before every
  regeneration. An imported schedule is saved as a version you can restore.
- **Electives.** Define elective periods and their choices, including choices
  that run across two periods. Import campers' ranked preferences from a sheet,
  then let Shoresh assign campers fairly.
- **Export.** Excel and JSON exports of the schedule. Shoresh also keeps a plain
  workbook of the camp's data in `Documents/Shoresh` that anyone can open.
- **Several devices, one camp.** Add a device by typing the camp code shown on
  the host computer under **Devices** → Add a device. Edits made on different devices merge.
  When two people change the same thing, Shoresh shows both versions and asks
  you to choose.
- **Your data stays protected.** The database on each device is encrypted by
  default, and each device has its own PIN-protected sign-in with admin and
  staff roles.

### Getting started

Download v1.0.1 from the [release page](https://github.com/gfeitel1-maker/Scheduling-Project-/releases/tag/v1.0.1):

- **macOS:** **Shoresh-1.0.1-macOS.zip**. Unzip it and drag **Shoresh** to Applications. It is an Intel build that also runs on Apple Silicon Macs (through Rosetta).
- **Windows:** **Shoresh Setup 1.0.1.exe**, a 64-bit installer that needs no admin rights.

You can also build either from this repository (next section).

The app is not code-signed, so the operating system asks you to confirm the
first time you open it:

- **macOS:** Control-click (right-click) Shoresh, choose **Open**, then **Open**
  again. If that is blocked, open **System Settings** → **Privacy & Security**
  and choose **Open Anyway**.
- **Windows:** when **Windows protected your PC** appears, choose **More info**,
  then **Run anyway**.

On first run, choose **Start a new camp** on the first device, or **Join with a
camp code** on any device after that. The first device can create the camp by
importing last year's schedule.

---

## Building it yourself

You need:

- **macOS**: Node.js, git, and Xcode Command Line Tools (for the native SQLite
  driver).
- **Windows**: build on Windows itself.

The repository pins a Node version in `.nvmrc`. **On an Intel Mac, use Node 22**:
the encrypting SQLite driver (`better-sqlite3-multiple-ciphers`, a required
dependency) does not compile under the pinned Node there.

```bash
npm ci
npm run electron:dev
```

`electron:dev` runs the real app against a separate development database, so
it cannot touch an installed copy's data. The sidebar shows a **DEV** badge
when the development database is loaded.

To produce the packaged app:

```bash
npm run electron:build
```

The output goes under `release/`. The build rebuilds the native module for
Electron first (`scripts/ensure-abi.js`). It then fails unless the packaged app
loads its encrypted database and boots (`scripts/verifyPackagedApp.js`).

On a Mac:
- `npm run install:mac` installs the built app into `/Applications`.
- `npm run deploy:local` rebuilds an installed copy in place. It keeps a backup
  and restores it automatically if the new build fails its checks.

Switching between running tests (Node) and running the app (Electron) needs
the native SQLite module rebuilt for the one you are about to use. The `npm`
scripts do this for you: `npm test` and `npm run electron:dev` each run
`scripts/ensure-abi.js` first, which rebuilds `better-sqlite3` (and, for the
app, the encrypting `better-sqlite3-multiple-ciphers` driver) only when the
binary does not match.

### Windows

`npm run electron:build` on a Windows machine produces a per-user NSIS
installer that needs no admin rights. Windows treats a new network as
**Public**, which silently blocks other devices from connecting to that
computer. On each Windows computer that should accept connections, either:

- set the network to **Private**, or
- add an inbound firewall rule for Shoresh (this one needs an admin).

---

## Forking it for your own camp

Shoresh is open source (Apache 2.0) and is meant to be forked: each camp runs
its own copy, and no central service owns your data.

What a camp runs:

- **The app, on its own devices.** Each device keeps the whole camp in a local
  database. Devices on the same network find each other automatically and sync
  over encrypted, mutually authenticated connections.
- **Optionally, a small rendezvous service, so devices can reconnect across
  networks** (office and home, say).
  - Packaged builds try a direct connection across the internet and use a tiny
    Cloudflare Worker only to introduce two devices. The Worker never sees or
    stores camp data; it holds short-lived, signed address records.
  - The source is in `workers/rendezvous/`, and the app's default address is in
    `electron/wanDefaults.js`.
  - A fork that wants its own deploys that Worker and points
    `DEFAULT_RENDEZVOUS_URL` at it. Setting `SHORESH_RENDEZVOUS_URL` to an empty
    value turns the rendezvous step off.
  - Adding a new device always happens on the local network, whichever option a
    camp picks.

There is no server to keep running for the schedule itself. See
[SECURITY.md](SECURITY.md) for what the network setup does and does not
protect.

To change the app for your camp, see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## How it works

- **Data:** each device holds the camp in an
  [Automerge](https://automerge.org) document, a structure designed to merge
  edits made on different devices. A local SQLite database mirrors it for fast
  reading. Edits to different fields merge on their own; two edits to the same
  field are kept as a conflict for a person to resolve.
- **Sync:** runs over [libp2p](https://libp2p.io) with Noise encryption.
- **Engine:** the schedule engine is a pure, deterministic function. The same
  inputs always produce the same week.

Current architecture, screens and database tables:
[docs/current/PLATFORM_STATE.md](docs/current/PLATFORM_STATE.md). The security
model: [SECURITY.md](SECURITY.md).

## Status

v1.0.1 is released (see **Getting started**). There are no further updates planned for v1; each camp forks and maintains its own copy. Open work is tracked as tickets under
[docs/work](docs/work/README.md), governed by
[docs/governance/GOVERNANCE_INDEX.md](docs/governance/GOVERNANCE_INDEX.md).

## Tech

React 19 · Vite · Electron · better-sqlite3-multiple-ciphers · Automerge · libp2p ·
@dnd-kit · Vitest

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The packaged
app's **Licenses** menu item lists every production dependency's version,
license identifier and full license text, generated by
`scripts/generate-licenses.js`.

## How it was built

Built by a camp director working with Claude (Anthropic) in Claude Code: design, implementation, testing, and review across the v1 build.
