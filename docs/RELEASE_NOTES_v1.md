---
title: "Shoresh v1 release notes"
document_type: guide
authority: descriptive
status: active
created: 2026-10-13
archive_when: never — these are the notes for the v1 release
---

# Shoresh v1

Shoresh is a scheduling app for summer camps. It builds and keeps the weekly schedule (which group does which
activity, where, and when) and leaves the decisions to you. It runs on your camp's own computers: there is no
account to create and no company server holding your camp's data.

**Download:** _[download link — added at release]_

This page is for two readers: a camp director deciding whether to use Shoresh, and a camp's own developer who
forks it. The step-by-step guide is [the director guide](guide/DIRECTOR_GUIDE.md).

---

## What v1 does

**Set up your camp.** Age divisions, groups, days, time blocks, activities, locations, fixed events (meals, flag,
rest hour), recurring events, and special days such as trips. Each setup screen adds a row in place, and you can
download a worksheet, edit it in Excel and import it back.

**Bring last year's schedule in.** Import the spreadsheet or text file you already use, and Shoresh builds the camp
from it: groups, days, blocks, activities, events, and how often each activity ran. It asks only what it cannot tell
on its own, remembers your answers for next time, and saves the imported week as a version you can open. An import
can be undone. A trip or a whole day that only some groups have is recognised as an event for those groups, not an
ordinary activity.

**Two ways to build the week, side by side.**
- **Generated Schedule:** Shoresh proposes a full week that follows your rules (how often each activity runs,
  which groups can do it, how many groups a place holds at once, activities that take two blocks), and you adjust
  it by dragging. Lock what must not move, and it stays put when you generate again. When the file you imported
  shows that the week fits, Generate fills it again.
- **Manual Build:** you place every cell yourself, the way a spreadsheet works.

Switching between them never loses work. Problems are flagged where they happen: a cell nothing can fill, an
activity a group doesn't get often enough, a group booked in two places at once. Every regeneration saves a version
first, and you can name and restore versions yourself.

**Special days and a rainy day.** Build a special day (a trip day, a games day) with its own blocks and place it
on a week and day. **Rainy day…** switches one day's outdoor activities to their rain plans, after saving a
version, as a single step you can undo.

**Electives.** Define elective sets and their choices, including a choice that runs across two periods. Import
campers' ranked preferences from a sheet and let Shoresh assign campers fairly. At the end of the season you can
clear elective choices.

**Excel.** Export either schedule to Excel, one sheet per day plus an All Groups sheet.

**Backups and Save whole camp.**
- **Backup now** saves a copy of the camp on this computer (the newest 10 are kept), and **Restore from backup…**
  brings one back.
- **Save whole camp** writes one file of the whole camp (setup, both schedules with their versions, special days,
  and what Shoresh has learned from your imports). **Open a saved camp** on any computer's start screen opens that
  file as a new camp with its own sign-in. This is how you move a camp to a new computer or recover from a lost one.

**Several devices, one camp.** Add a computer by typing the camp code shown on the host computer under
**Devices → Add a device**. After that, every computer syncs directly with the others, on the same network or
across networks, and keeps syncing whether or not the host computer is on. Edits made on different computers
merge; when two people change the same thing, Shoresh shows both and asks you to choose. Remove a lost or stolen
device from **Devices** and the rest of the camp stops syncing with it.

**Sign-in and encryption.** Each person signs in with their own PIN, as an admin or as staff. Each computer's copy
of the camp is encrypted on disk by default, with a key held by that computer's operating system.

---

## Installing and first run

See the [README](../README.md) for installing or building Shoresh. On first run, choose **Start a new camp** on
the first computer (you can create the camp by importing last year's schedule), **Join with a camp code** on each
computer after that, or **Open a saved camp** to start from a file made with Save whole camp.

On Windows, the project's **Release proof** build (run when a release tag is pushed) produces the unsigned
installer, **Shoresh Setup <version>.exe**. On a Mac, build the app from source (see the README); the same build
checks the Mac app but does not publish it.

The app is not code-signed, so confirm the first time you open it:
- **macOS:** Control-click (right-click) Shoresh, choose **Open**, then **Open** again. If that is blocked, open
  **System Settings** → **Privacy & Security** and choose **Open Anyway**.
- **Windows:** at **Windows protected your PC**, choose **More info**, then **Run anyway**.

---

## Known limitations

- **Backups restore on the same computer only.** A backup is locked with that computer's own key. To protect
  against losing the laptop, pair a second device (every paired computer holds a full copy of the camp) or use
  **Save whole camp** and keep the file somewhere private. If a computer's key is lost (its keychain reset, or the
  computer lost) and no other device has the camp, the encrypted data on it cannot be recovered.
- **The Save whole camp file is not protected.** It is deliberately not encrypted, so it opens on another computer.
  Anyone with the file can read the camp's setup and schedules. Keep it somewhere private. It does **not** include
  sign-ins, PINs, devices, camper lists or elective choices: after opening it, import the camper list again and
  re-run elective assignment.
- **Save whole camp has limits.** A file opens only into a brand-new, empty camp, never merged into one that already
  has data. A very large camp with many saved versions can be refused as too large to save as one file (the largest
  camp the app can schedule fits with room to spare). A failed open offers **Start over** and never leaves a
  half-loaded camp.
- **Encryption protects a computer that is off or stolen, not one in use.** Someone already signed in to the
  computer's own user account, or software running as that user, can read the camp. On a shared computer, give each
  person their own operating-system account.
- **A removed admin who keeps their keys can cause a nuisance.** A computer that has not yet heard that an admin
  was removed can be made to sign itself out by that admin. Signing back in recovers it, and every such action
  stays visible in the camp's history. This was accepted for v1 because a camp's devices are a small,
  in-person group.
- **Some networks cannot connect across the internet.** Shoresh uses no relay. Two computers that are both behind
  very restrictive routers (symmetric NAT, or carrier-grade NAT on both ends, as on some mobile and apartment
  networks) cannot reach each other from different networks; they sync when they are on the same network. Adding a
  new device always happens on the same network.
- **When computers are out of touch, they catch up later.** A computer that was off when something changed (a
  removal, an edit) acts on what it knew until it reconnects and hears about it.

---

## No updates after v1

Shoresh v1 is the release. There is no update service and no central version to keep up with: each camp runs its
own copy, and a camp that wants changes forks the project (Apache License 2.0) and makes them. See
[CONTRIBUTING](../CONTRIBUTING.md) for working on the code and [SECURITY](../SECURITY.md) for exactly what the
network setup and encryption do and do not protect.

---

Built by a camp director working with Claude (Anthropic) in Claude Code: design, implementation, testing, and review across the v1 build.
