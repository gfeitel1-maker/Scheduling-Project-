---
title: T249-encryption-gate-entry-point
document_type: ticket
status: completed
created: 2026-09-23
archive_when: the D8 at-rest-encryption disclosure renders persistently at the elective feature's entry screen whenever encryption is disabled, and a test pins that it cannot be silently dropped by a later refactor
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T249 — D8 encryption gate as a visible in-app statement

Implements ADR 2026-09-23 decision (e). T199 names this a **release precondition**, not a nice-to-
have: "Shipping the flow without that statement fails this ticket [T199]." This ticket is the
smallest independent slice that satisfies it, so it does not have to wait on the rest of the
decomposition.

## Scope

- `electron/main.js`: `getSecurityStatusHandler()` reading the same resolution `docStore.js` already
  uses for `SHORESH_AT_REST_ENCRYPTION` — call that function, do not re-parse the env var. No
  `authorize()` call (public config, not camp/camper data).
- `electron/preload.js`: `getSecurityStatus: () => ipcRenderer.invoke('shoresh:get-security-status')`.
- `src/screens/elective/assignment/AssignmentPanel.jsx`: persistent, non-dismissible disclosure row
  in the "No run" (empty) state, per the ADR's copy. Not a banner (repo convention). Follow
  DESIGN_STANDARD §5/§8 for its loading/async state (the security-status read is itself an async
  IPC call — show a neutral/loading treatment before the result resolves, never silently absent).
- Component test: disclosure text present when mocked `atRestEncryptionEnabled: false`; a second
  assertion confirms it survives a state transition (e.g., navigating into "Import preview" and
  back), so it cannot regress via a one-time-render bug.

## Non-goals

Changing `SHORESH_AT_REST_ENCRYPTION`'s default or wiring encryption itself — that is the separate,
already-tracked at-rest-encryption activation program (T175/T179 per SECURITY.md), not this ticket.

## Test seam

`src/screens/**` component test (Vitest + Testing Library, no integration harness required — this
touches neither sync, auth, nor schema; it is a read of existing config and a render).

## Dependencies

None functionally — can be developed and merged in parallel with every other ticket in this
decomposition, including T243. **Shares `electron/main.js`/`electron/preload.js` with T244, T245,
T248** for its `getSecurityStatus` handler — this is an ordinary git merge-conflict risk between
four tickets touching the same two files, not a logic dependency on any of them; append the new
handler to the existing elective/security block in both files rather than reordering, per T244's
convention note, whichever of the four merges last.

## Result (2026-09-24)

Built as specified. `archive_when` is met: the disclosure renders persistently at
`AssignmentPanel`'s entry state whenever at-rest encryption is not active, and a component suite
pins that it cannot be dropped by a later refactor.

**What shipped**

- `electron/main.js` — `getSecurityStatusHandler()` returning `{ atRestEncryptionEnabled }` from
  `isAtRestEncryptionEnabled()` (`electron/db/atRestEncryption.js`), the same resolution the
  document and SQLite ciphers use. No `authorize()`, per the ADR's contract table.
- `electron/preload.js` / `src/localClient.js` / `src/localClient.mock.js` — the channel, its
  wrapper, and its mock (required by `electron/ipcSurfaceParity.test.js`; the mock reports `false`
  because browser-dev genuinely has no encryption, which is an accurate answer rather than a stub).
- `src/screens/elective/assignment/AssignmentPanel.jsx` — `EncryptionDisclosure`, rendered outside
  every phase branch so it is present in the entry state **and** in mapping / preview / committed,
  using `S.cautionBanner` (DESIGN_STANDARD §4). No banner chrome, no dismiss control.

**Deviates from decision (e)'s literal prose in one place, deliberately, and the owner ruled to keep
it (2026-09-24).** (e) says the row goes in the "No run" (empty) state. It renders in **every phase**
of the panel instead. Code Reviewer flagged this as an unauthorized expansion of an accepted ADR,
which was the right thing to raise; the owner decided against it on the substance: the moment a
director would paste real camper names is the **import flow**, not an empty screen, and *a
disclosure that disappears exactly when the risk appears is worse than no disclosure*. Recorded here
as a deliberate choice with a reason, not as drift, so a later reader does not "fix" it back.

**The three properties the tests pin**, each a way this could rot back into a promise:

1. It renders whenever encryption is not active — in the entry state, in the "not on a schedule
   yet" state, and after `import → mapping → solve → preview → committed → back to entry`.
2. It cannot be dismissed: the row contains zero controls, asserted structurally.
3. **It fails closed.** A status read that throws, or resolves to anything other than a literal
   `true`, reads as *not encrypted*. Only an affirmative `atRestEncryptionEnabled === true` clears
   it. The read failure is surfaced through `describeWriteFailure`, not swallowed.

Non-vacuity was checked by planting both defects: deleting the render dropped 6 of 11 tests, and
relaxing the gate to `!== false` (fail-open) dropped the malformed-payload test. Neither was
caught by inspection alone.

**Not done here, and correctly so:** nothing changes `SHORESH_AT_REST_ENCRYPTION`'s default or
wires encryption (T175/T179, owner-held). The gate keys off whether encryption is *active*, so the
warning stops on its own the day that flag flips — no follow-up edit to this screen is needed.

**One thing Red Hat changed about that, and it matters.** The first cut rendered *nothing* when the
flag read true. That would have been an over-claim: `atRestEncryptionEnabled` is one device's flag,
and it is not the sentence "this camper's name is encrypted on disk". Two gaps outlive the flip —
bytes written *before* it was enabled (the migration is T175/T179's job, still open and explicitly
unverified in `atRestEncryption.js`'s own header), and a **peer** syncing this camp with the flag
off, whose copy of the same document is plaintext on its disk. The ADR permits "a neutral
confirmation" in the `true` branch, so the row now stays and names both gaps instead of implying
they are closed. Silence would have been the more dangerous UI.

## Statement vs. block — SETTLED by the owner, 2026-09-24. Do not re-escalate.

The question was real and was escalated rather than decided here: Q4's option said real camper data
"stays blocked at a tested, visible UI gate" and the accepted recommendation called it "a real,
tested, visible control, not a promise" — while decision (e) implements a *statement*. The app
does not mechanically refuse a preference-sheet import when encryption is off.

**The owner ruled the disclosure is correct. Keep it as built. No blocking guard clause, and no
ticket for one.** His reasoning, recorded because it closes the question rather than merely
answering it:

> A blocking gate would have to answer **"is this a real camper name?"**, and no signal exists that
> answers it. The app cannot distinguish a fabricated fixture from a real roster. So enforcement
> would have to refuse **every** import while encryption is off — which destroys the
> build-now-against-fixtures decision made in the same breath, leaving T244, T246, T247 and T250
> with no way to be exercised at all.

A heuristic marker (a "this is test data" flag the director sets) was considered and **rejected**: a
flag a director can set is a flag a director can set wrongly, or forget.

So the disclosure is **not a weaker substitute for a block**. Given what the app can actually know,
it is the honest control — and the thing that makes it a control rather than a promise is that it
is unconditional, undismissable, present in every phase, and fails closed, all of which are pinned
by test.

Visual evidence (fabricated fixtures only): `docs/work/evidence/T249/`.
