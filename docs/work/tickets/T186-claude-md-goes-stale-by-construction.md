---
title: "CLAUDE.md goes stale by construction — it restates facts nothing checks"
document_type: ticket
status: completed
created: 2026-09-16
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/constitution/CONSTITUTION.md]
depends_on: "None. The salvageable prior art is on tag archive/grpc-doc-gate (branch deleted 2026-09-16), which already implements a doc-names-missing-file check in scripts/check-governance.js."
archive_when: "CLAUDE.md's Architecture section describes the Automerge document as the replicated source of truth and names no deleted file; a governance check fails the build when a descriptive doc names a path that does not exist; no unverifiable magnitude claim (test counts, file counts) remains in CLAUDE.md; and `npm run verify` is green"
---

# T186 — CLAUDE.md goes stale by construction

## The owner's framing, which is the real problem
> "the claude.md file is always stale. i have no idea what to do about it"

This ticket is **not** "rewrite CLAUDE.md." A rewrite fixes today's instance and guarantees the next
one. The defect is structural: CLAUDE.md **restates** facts that live in the code, and nothing breaks
when the code moves. Every rewrite resets the clock without changing the mechanism.

## Confirmed problem (verified against code at 8014932 — do not re-litigate)
`CLAUDE.md` is the first file every session and every agent reads. Its Architecture section currently
teaches the **retired** sync architecture:

- `CLAUDE.md:53` ("Local-first model") and `CLAUDE.md:61` ("Op-log sync") describe a WebSocket
  Host/Client pair replaying an op-log across devices. That layer was **deleted in Stage 6**
  (~14k lines). Three files it names by path do not exist: `electron/sync/syncServer.js`,
  `electron/sync/syncClient.js`, `electron/sync/discovery.js`.
- `grep -c "Automerge" CLAUDE.md` → **0**. The live engine is `electron/sync/automerge/`, and
  `docs/current/PLATFORM_STATE.md:110` correctly states the Automerge document "is now the source of
  truth replicated between devices — SQLite is a projection of it."
- `operations` survives only as a **local history ledger**, not as the sync mechanism. CLAUDE.md's
  "replayed across devices" is false.
- `discoverHosts` is listed in the `window.shoresh` IPC surface but is **not** in `electron/preload.js`.
- `CLAUDE.md:67` claims "~270 test files." Actual: **419** across the three directories it names
  (src 226, electron 179, test 14); 438 repo-wide including scripts/.

PLATFORM_STATE.md was updated at Stage 6 and CLAUDE.md was left behind — the same split that will
happen again at the next structural change unless the mechanism changes.

## Why the existing gates did not catch it
`scripts/check-governance.js` validates frontmatter shape, enum membership, index freshness and
status drift. It has **no check that a descriptive document's factual claims still resolve.** A doc
may name any path, existing or not. This is the "guard structurally incapable of returning the answer
it is trusted for" family.

## Required work

### 1. Land the doc-names-missing-file check (the leverage)
Prior art exists and was never merged — recover it:
`git show archive/grpc-doc-gate:scripts/check-governance.js` (see `doc-names-missing-file`, ~line 480,
and the exemption rationale at ~line 435).

It must fail the build when a **descriptive** doc names a repo path that does not exist. Its own
comment already records the necessary exemption: **ADRs, tickets, handoffs and archives legitimately
name deleted code** — they are historical records, and gating them would be wrong. Scope the check to
descriptive docs (CLAUDE.md, docs/current/**), not to the historical layer.

Review the recovered implementation against current main before landing it; it was written against an
older tree and its path-extraction heuristics need re-verification (a regex that under-matches would
make this gate vacuous, which is the exact failure mode being fixed).

### 2. Rewrite the Architecture section against the code
Describe what ships: the Automerge document as replicated source of truth, SQLite as projection,
`electron/sync/automerge/**`, libp2p join-by-code, the op log as local history only. Correct the IPC
surface list against `electron/preload.js` rather than from memory.

### 3. Remove unverifiable magnitude claims
"~270 test files" can only ever rot. Either derive it or delete it. **Prefer deleting** — a number
nobody needs is a maintenance liability. Apply the same test to every other count in the file.

### 4. Reduce the restated surface
Wherever CLAUDE.md duplicates PLATFORM_STATE.md or the code, replace the restatement with a pointer.
Nothing you do not write can go stale. Be conservative: CLAUDE.md's job is orientation, and deleting
genuinely load-bearing guidance to win a staleness metric is a regression. Prefer removing
**duplicated fact**, keep **judgment and constraint** (the styling exception, the ADR pointers, the
"docs are descriptive, code wins" rule).

## Non-goals
- Do not rewrite PLATFORM_STATE.md; the audit confirmed it is current and accurate (schema v65, the
  three anchorScope resolvers, ANCHOR_DUPLICATE, payload-addressed dismissal).
- Do not gate the historical doc layer (ADRs/tickets/handoffs/archive).
- Do not introduce an auto-generated CLAUDE.md. A generated orientation doc loses the judgment that
  makes it worth reading.

## Anti-vacuity requirement (standing rule)
The new check must be proven against a defect it was **not** designed for. Planting only
`syncServer.js` — the case it was written for — proves nothing. At minimum: a path inside a code
fence, a path with a line suffix (`file.js:42`), and a directory path.
