---
title: "Comments and UI copy that still name the op-log as the authority"
document_type: ticket
status: completed
created: 2026-09-13
task_class: documentation-governance
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: no comment or user-facing string in the tree describes the op-log, or any single computer, as the source of truth for camp state
---

# T149 — Comments and UI copy that still name the op-log as the authority

From the external architecture review of 2026-09-13 (item 12): in an
agent-heavy codebase a stale technical statement is not documentation debt, it
is a defect, because agents consume it as evidence. Four were found and fixed.

- `electron/sync/automerge/liveDoc.js` — *"the op-log remains the authoritative
  record regardless of what the Automerge doc file holds"* and *"this stage's
  doc is a test/transition scaffold — not yet load-bearing for any real camp."*
  Both were true in Stage 5 and are now exactly backwards. Replaced with an
  honest account of what the debounce window actually costs under the current
  authority model, including why a crash inside it is survivable (startup
  performs no `projectAll`) rather than pretending it is harmless.
- `electron/sync/automerge/liveDoc.js` (×2) — *"The op-log remains the source of
  truth regardless."*
- `electron/main.js` — *"built by the op-log (the authoritative record
  regardless of this flag)."*
- `src/screens/ModeSelectScreen.jsx` — **user-facing**: *"This computer becomes
  the source of truth."* Under a replicated document no computer is. Reworded to
  describe what actually happens: this computer starts the camp, and every
  device keeps its own full copy.

`docs/current/WHERE_DATA_LIVES.md` and `PLATFORM_STATE.md` were checked and are
accurate — including `PLATFORM_STATE.md`'s own correct flag on the dormant
`projection_failures` safety net, which T148 confirms.
