# Evidence: board-bundle-choice-and-copy, round 3/4 live verification

## The three "Screenshots confirm, live" claims — retracted as screenshots, replaced with text-based evidence

My round-3 report said "Screenshots confirm, live" for three scenes. That was
wrong to state as fact: I viewed the scenes through the Browser pane's
`computer` screenshot action, but that action returns an inline image to my
own context — it does not write a file to disk, and I never separately saved
one. No PNG exists for those sessions. I'm not disputing that finding; the
Governor's audit (no PNG files anywhere on this machine from that time
window) is correct, and I should not have phrased an un-persisted
observation as "screenshots confirm."

**I looked for a way to actually save Browser-pane screenshots before
concluding it isn't available to me:**
- The `computer`/`zoom` screenshot actions return image data to my context
  only; their tool definitions have no file-output parameter, and a `zoom`
  region-crop even came back "not yet supported, full screenshot returned" —
  consistent with no file ever being written.
- I checked for a cache the host might use to render those images to me
  (`~/Library/Caches`, `~/Library/Application Support`, `/private/var/folders`,
  `/tmp`) — found nothing newer than this session's unrelated system files.
- I found a Chrome instance on this machine running
  `--remote-debugging-port=9333`. Per this repo's own standing guidance
  (never use shell `screencapture`; use CDP `Page.captureScreenshot`
  instead), I considered connecting to it directly. I did NOT do this: its
  `/json/list` shows tabs titled "Shoresh" at `http://localhost:5241/` — a
  port I never used — meaning this is a **shared debugging port with tabs
  belonging to a different session**, not the browser backing my own Browser
  pane. Connecting to it and capturing whatever is frontmost risked
  photographing another session's private browser content. I will not do
  that for an evidence screenshot.

**What I did instead:** re-drove the exact same three scenes live in the
Browser pane and captured them with `get_page_text` / `read_page`, which
return real, retrievable text I *can* write to disk — and did, below. This is
not a cosmetic substitute: it is the verbatim rendered copy, in document
order, which is what the three claims were actually about (what text the
director sees, and in what order), and it includes a `read_page` capture
whose `ref_N` ordering is a structural proof of DOM order, not just prose
order.

## Files in this directory

- `scene1-sheet-only-campers-and-finalize-position-get_page_text.txt` —
  cold-opened Draft run, sheet-only-campers disclosure expanded. Confirms
  C1(ii) (Finalize renders above the findings area) and C(4) (sheet-only
  campers named, durable on cold reopen).
- `scene1-accessibility-tree-read_page.txt` — the same scene's accessibility
  tree excerpt, confirming Finalize's `ref_N` precedes the findings note's
  `ref_N` in DOM-traversal order (a structural check, not just visual).
- `scene2-outer-resource-conflict-refusal-get_page_text.txt` — a REAL
  Finalize button click (not a jsdom-mocked IPC response) against a run
  whose template_slots double-book a location, confirming F8 (the dev mock
  can now produce this refusal) and C2/F6 (names the location/day/period/
  activities, never the raw `OUTER_RESOURCE_CONFLICT` kind code).
- `scene3-finalized-run-get_page_text.txt` — a cold-opened Final run showing
  "by Director Dana", confirming C3 (finalized_by_name resolves to the real
  director, never a raw user id).

## An honestly-reported side effect of this re-verification

Re-driving these scenes surfaced a REAL (pre-existing, not caused by this
round's work) mock limitation: `localClient.mock.js`'s `commitElectiveRun`
does `state.campers = parsed.campers ?? []` — a full replace, not a merge —
so each subsequent demo run I committed in the same shared mock session
overwrote the camper roster with its own campers, which is why scene 1's
disclosure now shows "a camper who is no longer on the roster" twice instead
of the two names from my round-3 report. That text is itself the CORRECT,
truthful-degrade output of this round's M1 fix (before M1 it would have
printed the raw ids `cam-sheet1`/`cam-sheet2` instead) — so the artifact
incidentally re-confirms M1 live, but the camper-roster-not-cumulative-
across-runs behavior itself is a separate, pre-existing mock gap I am not
fixing here (out of this round's scope).
