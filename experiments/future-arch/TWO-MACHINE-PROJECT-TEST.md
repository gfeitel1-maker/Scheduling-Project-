# Running the `.shoresh` project experiment across two computers

Goal: prove that two computers, sharing only a folder, can each edit the same project
independently and **converge** — and that either can **rebuild its database from the package
alone**. For this test, a slow/bursty folder (OneDrive/Dropbox) is fine: this is *asynchronous*
convergence, not a live-feel test. You just `sync` until both computers show the same STATE HASH.

You need: **Node.js** on both computers, a **shared folder** that syncs between them, and the two
files `project.cjs` + `project-cli.cjs`.

---

## One-time setup (do on BOTH computers)

1. Make a working folder that is **NOT** in the shared folder (e.g. on the Desktop), call it
   `shoresh-test`. Put `project.cjs` and `project-cli.cjs` into it.
2. In a terminal in that folder, install the one dependency (the SQLite engine):
   ```bash
   npm init -y
   npm install better-sqlite3
   ```
   (`better-sqlite3` ships prebuilt binaries, so this normally just works with no compiler.)
3. Note the path to your shared folder. You'll point `--pkg` at a `test-project.shoresh`
   **inside** it. Examples:
   - Mac:     `~/Library/CloudStorage/OneDrive-JCCNV/shoresh-share/test-project.shoresh`
   - Windows: `C:\Users\You\OneDrive-JCCNV\shoresh-share\test-project.shoresh`

> Two rules that matter: the **package** (`test-project.shoresh`) goes **in the shared folder**;
> your **local database** stays **out** of it (the CLI keeps it in your `shoresh-test` folder by
> default). Never put the `.sqlite` in the shared folder.

---

## The test (Computer 1 = "A", Computer 2 = "B")

Set a shell variable so the commands are short (use YOUR shared path):
```bash
# Mac/Linux
PKG="$HOME/Library/CloudStorage/OneDrive-JCCNV/shoresh-share/test-project.shoresh"
# Windows PowerShell
$PKG = "C:\Users\You\OneDrive-JCCNV\shoresh-share\test-project.shoresh"
```

**1. Computer A creates the project** (run once, on A only):
```bash
node project-cli.cjs init --pkg "$PKG" --name "Camp Achva" --season "Summer 2027"
```
Wait until the shared folder shows `test-project.shoresh` on **Computer B** before continuing.

**2. Computer A makes a change:**
```bash
node project-cli.cjs edit --pkg "$PKG" --entity archery --field location --value "Field 1"
```
Note the STATE HASH it prints.

**3. Computer B picks it up** (wait for the folder to propagate — seconds to minutes on OneDrive):
```bash
node project-cli.cjs sync --pkg "$PKG"
```
B should now show `archery location=Field 1` and **the same STATE HASH as A**. That's convergence.

**4. Computer B makes its own change:**
```bash
node project-cli.cjs edit --pkg "$PKG" --entity pottery --field location --value "Kiln"
```

**5. Computer A picks it up:**
```bash
node project-cli.cjs sync --pkg "$PKG"
```
Both computers now show the same STATE HASH again.

**Optional — hands-free:** instead of running `sync` by hand, run
`node project-cli.cjs watch --pkg "$PKG"` on each computer; it re-syncs every few seconds and
prints whenever the state changes.

---

## The reconstruction proof (the important one)

On **either** computer, throw away the database and rebuild it from the package alone:
```bash
node project-cli.cjs rebuild --pkg "$PKG" --out ./rebuilt.sqlite
```
It replays the shared journal into a brand-new SQLite and prints a STATE HASH. **That hash must
exactly match** the STATE HASH the other computer shows after `sync`. If it does, you've proven the
database is fully rebuildable from the portable package — the whole point.

To make the "delete" real: on Computer B, delete its local `*.sqlite` file entirely, then run
`sync` again (it recreates the database from the package) — same STATE HASH. The database was
genuinely disposable.

---

## What to look for / report back

- **Convergence:** after both sides `sync`, do the two STATE HASHES match? (Yes = converged.)
- **Propagation feel:** roughly how long after an `edit` on one computer does `sync` on the other
  see it? (Seconds? Minutes? This is the async number — remember OneDrive is bursty and its
  "synced ✓" can lie, so just re-run `sync` until it appears.)
- **Reconstruction:** does `rebuild` on one computer produce the same STATE HASH as the other's
  synced state? (This is the headline result.)
- **Conflict handling (optional):** with the folder briefly disconnected on both, have A and B each
  `edit` the *same* entity+field to *different* values, reconnect, `sync` both. They should
  converge to one value AND each show a "recorded conflict" line.

Paste me the STATE HASHes from each side and the rough propagation time, and I'll confirm what it
shows.
