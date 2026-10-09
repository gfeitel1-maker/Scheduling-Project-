---
title: "Shoresh director guide"
document_type: guide
authority: descriptive
status: active
date: 2026-10-09
created: 2026-10-09
archive_when: never — refreshed when the screens it describes change
---

# Shoresh director guide

How to run your camp's schedule in Shoresh, step by step. Bold words are exactly what you'll see on screen.

---

## 1. Getting started

### First launch

1. Open Shoresh. You'll see **Set up this device**.
2. Pick one card:
   - **Start a new camp** — this is the first computer for your camp.
   - **Join with a camp code** — your camp already exists on another computer. Go to [Adding a device](#9-adding-a-device).

[shot: mode-select/first-launch]

### Start a new camp

1. Type your **Camp name**.
2. Type **Your name**.
3. **Create a PIN** — 6 or more digits. Staff you add later can use a shorter one.
4. Click **Create camp**. (It stays grey until all three are filled in.)
5. You're in. No separate sign-in needed this time.

[shot: camp-bootstrap/filled]

### Signing in later

1. Type your **Name**.
2. Type your **PIN**.
3. Click **Sign in**.

- Wrong PIN: you'll see a message saying it doesn't match. Try again.
- Too many tries: **Just a moment** appears with a countdown. Wait; it unlocks by itself.
- There is no "forgot PIN" button.

[shot: login/locked-out]

---

## 2. Import last year

### Start the import

1. On a brand-new camp you'll see **Seed your camp.** Click **Import last year**.
   - Camp already has data? Open the **Settings** gear and choose **Re-import last year**.
2. Drag your file onto **Drop schedule here**, or click **Choose a file**.
   - Works with .xlsx, .xls, .csv and .txt. You can pick several files at once.
   - Scanned images won't work.

[shot: import/drop-zone]

### Check what was found

1. Read **Found in the file. Nothing added yet.** Nothing has changed in your camp yet.
2. For each group, pick its age division from the dropdown (or **+ New age division…**).
3. Under **Longer Blocks**, choose **Every week** or **Just this once**.
4. Under **Similar names**, choose **Same — call it "…"**, **Keep both**, or **Not sure — ask me later**.
5. If your camp already has setup, choose:
   - **Keep them** — add the import alongside.
   - **Replace them** — clears your setup in every Program, and clears **Manual Build** and **Generated Schedule**.
6. Click **Review N records** (or **Replace with N records**).

[shot: import/preview]

### Answer the review questions

1. You'll see **Reconciling** your file name and a bar: **X of Y questions answered**.
2. Click a tile (**Needs attention**, **Changed**, …) to see its questions.
3. Answer what you can. **Unanswered is OK** — they're kept for later.
4. Click the button at the bottom:
   - **Use this setup** — everything is decided.
   - **Apply N decisions** — some answered, the rest kept for later.
   - **Add to camp** — first import, nothing answered yet.
5. Changed your mind? Click **Undo this import** within 5 minutes.
6. Click **Continue**.

[shot: reconcile/questions]

### Come back to open questions later

1. Click the attention item on the home screen. It opens **Open items**.
2. For each item, click **Open in … →** to fix it, or **Mark handled** to clear it from the list.

---

## 3. Set up by hand

Choose **Start by hand** on **Seed your camp.**, or use the sidebar. Every table has a blank row at the bottom: fill it in, then click **+ Add** (or press Enter). Each screen has a **Next** button at the bottom right.

### Age Divisions

1. Click **Age Divisions** in the sidebar.
2. Type a name (e.g. Yeladim).
3. Click **+ Add**.
4. Click **Groups →**.

### Groups

1. Type a group name (e.g. Bunk 1).
2. Pick its age division (optional).
3. Pick **All Day**, **Morning Only** or **Afternoon Only**.
4. Click **+ Add**.
5. Click **Days →**.

### Days

1. Type a label (e.g. Monday).
2. Pick the day of the week.
3. Click **+ Add**.
4. Click **Time Blocks →**.

### Time Blocks

1. Type a name (e.g. Block 1).
2. Set the start and end time. (Shoresh doesn't check that end comes after start — double-check.)
3. Pick **Morning**, **Afternoon** or **Evening**.
4. Click **+ Add**.
5. Click **Activities →**.

[shot: time-blocks/table]

### Activities

1. Click **+ Add Activity**.
2. Fill in **Name** and, if you like, **Location (optional)**.
3. Set **Min per week**, **Max per week** and **Blocks per session**.
4. Pick **Scheduling Priority**: High or Low.
5. Tick the age divisions it's for — or leave all unticked for everyone.
6. Click **Add Activity**.

Quick way: type a name in the **Add Activity** box at the bottom and click **+ Add**.

[shot: activities/add-form]

---

## 4. The Generated schedule

### Generate

1. Click **Generated Schedule** in the sidebar.
2. Click **Generate a schedule**. (Admins only.)
3. Wait for **Generating…** to finish. The week fills in.

[shot: generated/first-week]

### Unfillable cells

A cell that says **Unfillable** couldn't be filled. Hover it to see why:

- **Nothing eligible**
- **Weekly max reached**
- **Already on today**
- **Place full**
- **No room for full length**
- **Activity at capacity**
- **… in use by …** — another event has the place.

Click **Review all** to see everything in **Still to place**. Click **Accept** to hide a flag you're fine with.

[shot: generated/unfillable-hover]

### Drag to adjust

1. Switch to **Group View** or **Daily View**. (No dragging in **Activity View**.)
2. Drag an activity from the left panel onto a cell — or drag one cell onto another.
3. Dropping on a filled cell **replaces** it. It never swaps.
4. Made a mistake? Click Undo.

### Rebuild

1. Click **Rebuild**.
2. Click **Rebuild it**. Your edits are replaced, but the old week is saved to Versions first.

---

## 5. Manual Build

### Start a blank week

1. Click **Manual Build** in the sidebar.
2. Click **Start a blank week**. (Admins only.)
3. Your fixed events are placed for you. Everything else says **Open**.

Your Generated schedule is untouched. Switch between the two any time from the sidebar — nothing is lost.

### Place activities

1. Switch to **Group View** or **Daily View**.
2. Find an activity in the **Activities** panel (use **Filter…** to search).
3. Drag it onto an **Open** cell.
4. Watch the count next to each activity. When it turns red, that activity has hit its weekly max.

[shot: manual-build/dragging]

### The overlap mark

A small coloured dot in a cell means **Check this cell** — too many groups for one place or activity.

1. Hover the dot to read why.
2. Move one of the groups. The dot disappears by itself.

It's a warning, not a block. The **Overlapping** count at the top shows how many are left.

[shot: manual-build/overlap-dot]

---

## 6. Electives

### Make an elective set

1. Click **Electives** in the sidebar.
2. Type a name in the blank row (e.g. Afternoon Chugim). Press Enter.

### Add offerings

1. Click **Open** on the set.
2. Click **Import** to load offerings from a spreadsheet, or use **Add Offering** to pick activities one by one.
3. Set **Capacity** and **Minimum** if you need them.

[shot: elective-set/offerings]

### Put it on the week

1. In Generated Schedule or Manual Build, click a cell and start typing the set's name.
2. Pick it from the list — it has a small **Elective** tag.
3. The cell shows the set name and count, e.g. "Chugim (4)".

Shortcut: type `Chugim: Archery, Drama` and press Enter to make a new set and place it in one go.

---

## 7. Special days

> TODO(T350): date/day binding is changing — update after T350 lands

### Create a special day

1. Click **Special Events** in the sidebar.
2. Type a name (e.g. Color War).
3. Change the dropdown from **Event** to **Special Day**.
4. Click **+ Add**.

### Seed it from your time blocks

1. Shoresh asks **Start from your time blocks?**
2. Click **Copy time blocks** to start with your regular blocks — or **Empty** to start blank.

This is a one-time copy. Later changes to your time blocks won't follow.

### Fill it in

1. Click **Special Schedules** in the sidebar, then click your day.
2. **Double-click** a cell. (A single click won't open it.)
3. Type an activity and press Enter.
4. Need a new block? Click **+ Add Block**.
5. Click **Print** when you're done.

[shot: special-day/grid]

---

## 8. Backups

1. At the bottom of the sidebar, click **Backup now**.
2. Wait for **Backup saved**.
3. Click **Show in Finder** to see the file.

Backups go to `~/Library/Application Support/shoresh/backups/` on your Mac. Shoresh keeps the newest 10. Each backup includes the camp document as well as the database.

If you see **Backup saved — camp document not included**, the database was backed up but the camp document could not be copied. Click **Backup now** again; if the message keeps appearing, do not rely on that backup alone.

There is no restore button in the app yet. Restoring needs support from us (T352 is open for it). Your best protection is a second computer joined to the camp — it keeps a full copy all the time.

---

## 9. Adding a device

Both computers must be on the **same Wi-Fi**. VPN and phone hotspots won't work.

**On the computer the camp was set up on** (for now, it has to be this one):

1. Open the **Settings** gear → **LAN & Devices**.
2. Click **Add a device**.
3. Note the camp code shown. It's the same every time.

[shot: device-manager/code-showing]

**On the new computer:**

4. Choose **Join with a camp code**.
5. Type the code. Click **Continue**.

**Back on the first computer:**

6. The new computer appears under **Pending Pairing Requests**. Click **Approve**.

**On the new computer:**

7. Sign in with the same **Name** and **PIN** you use on the first one.
8. Wait for **Getting your camp…**, then click **Continue**.

If it says **No camp answered that code**, check the code, check **Add a device** is still open, and check both are on the same Wi-Fi.

---

## 10. Export to Excel

1. Open **Generated Schedule** or **Manual Build**.
2. Click **Export to Excel**.
3. If both schedules are started, **Export which?** asks you to pick one. (It asks every time.)
4. The file downloads with one sheet per day and an **All Groups** sheet.

Before the season ends, export your final schedule to keep a copy (steps above). Then continue to [End of season](#11-end-of-season-clear-elective-choices).

---

## 11. End of season: clear elective choices

1. Click **Electives** in the sidebar.
2. At the bottom right, pick **The whole season** (or **This week**).
3. Click **Clear season's elective choices**. (Admins only.)
4. Read the warning. This can't be undone, and it clears every device.
5. Click **Clear Season**.

This clears campers' choices and assignments only. Your elective sets and offerings stay.

To update camper details instead, re-import a preference sheet: open the **Settings** gear and choose **Re-import last year**. It updates the campers it matches and does **not** remove anyone.
