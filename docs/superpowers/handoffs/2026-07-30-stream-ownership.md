# Stream ownership — who owns which files right now

**Written 2026-07-30. This is a perishable snapshot, not a standard.** It records
which concurrent work-streams own which paths *this week*, so a second session
does not rewrite a file another session is inside. Verify before trusting it
(§5); where it disagrees with the repo, the repo is right and this file is stale.

Read this before editing any file listed in §2, and before writing a spec whose
migration list names one.

---

## 1. Why this exists

Two sessions ran concurrently in the same working directory on 2026-07-30. Two
things went wrong, and only one of them was visible:

- **Visible:** a `git add -A` in the shared checkout swept an unrelated
  prototype HTML file into commit `5593764`, a schema/migration commit. Annoying,
  cosmetic, fixable.
- **Nearly invisible:** a sidebar/data-presentation spec was written whose
  migration list named five screens that the other stream was actively editing.
  Nothing would have failed. Tests would have passed. The rewrite would have
  silently dropped the other stream's work.

Branches did not prevent either. Worktrees prevent the first and **not** the
second. Semantic collision needs a declaration of ownership, which is this file.

## 2. Active streams and owned paths

### Stream A — trash and record history

Branch `feat/trash-and-record-history`. Spec:
`docs/work/specs/2026-07-29-trash-and-record-history-design.md`.

Owns, exclusively:

```
electron/db/**                     (schema, migrations, rollback, pendingRestores)
electron/ops/**                    (trash.js, restore.js, pinFields.js, projections)
electron/auth/permissions.js
electron/main.js                   (IPC handlers)
electron/preload.js
electron/sync/syncClient.js
electron/sync/syncServer.js
src/localClient.js
src/localClient.mock.js
src/components/RecordHistory.jsx
src/screens/TrashScreen.jsx
src/screens/recordLabels.js
```

Also holds **History-panel wiring inside** these five screens. It does not own
the screens outright, but its wiring inside them must survive any rewrite:

```
src/screens/GroupsScreen.jsx
src/screens/TiersScreen.jsx
src/screens/ActivitiesScreen.jsx
src/screens/AnchorsScreen.jsx
src/screens/TimeBlocksScreen.jsx
```

### Stream B — sidebar navigation and visual hierarchy

Branch `docs/ux-specs-from-oss-research`, worktree `.claude/worktrees/sidebar`.
Specs: `docs/work/specs/2026-07-30-sidebar-navigation-design.md`,
`2026-07-29-sidebar-visual-hierarchy-design.md`,
`2026-07-30-sidebar-oss-reference.md`.

Owns:

```
src/components/layout/Sidebar.jsx
docs/work/specs/2026-07-2*-sidebar-*  and  2026-07-30-sidebar-*
docs/work/specs/prototypes/2026-07-29-sidebar-*
```

### Shared — coordinate before editing

```
src/App.jsx            SCREENS map, nav callback, derived counts
src/styles/shared.js   both streams add S entries
```

Both streams' edits here are small and additive. Keep them that way.

## 3. The one dangerous pairing

**Stream B's entity-table and structure-tree specs must not run in parallel with
Stream A.**

- `docs/work/specs/2026-07-29-shared-entity-table-design.md` migrates seven
  screens to a shared `EntityTable`. Five are the five Stream A has wired.
- `docs/work/specs/2026-07-29-structure-tree-design.md` proposes eventually
  retiring `CohortsScreen`, `TiersScreen`, `GroupsScreen`.

A wholesale rewrite of those screens drops Stream A's History wiring **without
failing loudly**. Sequence both specs after Stream A merges, and treat
"preserves the existing History panel" as an explicit acceptance criterion of the
migration rather than something to notice afterwards.

Everything else about the two streams is compatible. Stream A's footprint on
`Sidebar.jsx` and `App.jsx` is six additive lines.

## 4. Rules

1. **Never `git add -A` / `git commit -a` in a shared checkout.** Stage explicit
   paths. This is what caused `5593764`.
2. **One worktree per stream**, under `.claude/worktrees/` (gitignored). Do not
   run git operations in another stream's checkout while it has modified files.
3. **Never bare `git stash` / `git stash pop`** — the stash stack is shared
   across worktrees. See the root `CLAUDE.md`.
4. **Merge order: lower in the stack first.** Stream A (schema → IPC → screens)
   merges before Stream B's screen-level work.
5. **Second to land rebases.** Put shared-file edits in a stream's *last*
   commits, not its first, so the conflict surface is small and late.
6. **Before writing a spec, check its file list against §2.** The near-miss above
   was a spec-authoring failure, not a git failure.
7. **Reuse across streams rather than paralleling.** `src/screens/recordLabels.js`
   is the shared home for entity and field labels in camp language
   (`tier_id` → "Unit"). Both streams independently concluded a director must
   never see a column name; only one needs to implement it.
8. **Update this file when a stream starts, finishes, or claims a new path.**
   Delete a stream's section when its branch merges.

## 5. Verify before trusting this

This file records intent at a moment. Check reality:

```bash
git worktree list
git branch -a --sort=-committerdate | head
```

```bash
git log --oneline main..<branch> --name-only | grep -E '^(src|electron)/' | sort -u
```

```bash
git status --short
```

If a path in §2 shows up in a stream that does not own it, that is the
conversation to have before writing more code.

## 6. Known stray

Commit `5593764` on `feat/trash-and-record-history` contains
`docs/work/specs/prototypes/2026-07-29-sidebar-visual-hierarchy-prototype.html`,
which belongs to Stream B and has nothing to do with that commit's
`pending_restores` migration. The same file is committed correctly on Stream B's
branch with identical content, so a merge is clean and no history rewrite is
warranted. Recorded here only so nobody spends time wondering how it got there.
