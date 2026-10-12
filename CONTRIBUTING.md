# Working on Shoresh

This guide is for a developer working on a camp's own fork. Building and
running the app are covered in the [README](README.md).

## How the repository is governed

Shoresh is built with a written process, and the repository enforces part of
it.
- **Who decides what:**
  [docs/governance/GOVERNANCE_INDEX.md](docs/governance/GOVERNANCE_INDEX.md)
  resolves which document governs a given change.
- **Highest authority:**
  [docs/governance/constitution/CONSTITUTION.md](docs/governance/constitution/CONSTITUTION.md),
  subordinate only to current human instruction.
- **What exists now:**
  [docs/current/PLATFORM_STATE.md](docs/current/PLATFORM_STATE.md) and
  [docs/current/WHERE_DATA_LIVES.md](docs/current/WHERE_DATA_LIVES.md) describe
  the current app. They are descriptive: where they disagree with the code, the
  code is right and the document is stale.
- **Decisions and work:** architectural decisions are ADRs in `docs/adr/`. Work
  is ticketed in `docs/work/tickets/`; run `npm run ticket:next` for the next free
  number.

## The gate

A change merges only when the gate is green. CI is the gate of record:
`.github/workflows/gate.yml` runs `npm run verify` on every pull request, on a
clean Linux machine.

`npm run verify` runs these steps in order, cheapest first, and stops at the
first failure:
1. agents:check
2. check:governance
3. licenses:check
4. build
5. security
6. test:integration
7. lint
8. test:sync
9. test:rest

`scripts/verify.js` holds the authoritative list. The run always ends with one
verdict line.

**`npm run check:governance` runs before every push.** It takes about a second.
It checks:
- ticket and ADR frontmatter;
- run records;
- that a descriptive document does not name a file that no longer exists;
- that a ticket a merge closed is not left open.

You do not need to run the full local gate before pushing; CI runs it. A local
`npm run verify` takes a machine-wide lock, so two runs never compete.

Other commands you will use:

```bash
npm test -- path/to/file.test.js   # one test file
npm run lint
npm run test:integration           # multi-process sync and import scenarios
npm run schema:check               # required for any change under electron/db/
```

## Working practices the codebase expects

- **Test first at the seams that matter.** Data, schema, sync, the op log,
  security and bug fixes get a test that fails before the change and passes
  after it. Prefer tests that enter where the user does: the IPC handlers, or a
  real file through the import pipeline. Assert what was written to the
  database, not that a function was called.
- **The document is the source of truth.** A write goes to the Automerge
  document first; SQLite is a projection of it. The `operations` table is local
  history (Trash, Restore, undo), not sync. Read the "Architecture" section of
  [CLAUDE.md](CLAUDE.md) before touching sync or storage.
- **Every write goes through `authorize()`**, and every PIN check through
  `attemptLogin`. Keep both single.
- **Schema changes** need a migration, a rollback module, and
  `npm run schema:check`.
- **Never hide a failed write.** A mutation that fails tells the user, in plain
  words.
- **UI:** shared design tokens live in `src/index.css`. Component styles are
  inline; see the "Styling" section of CLAUDE.md for the one scoped stylesheet
  exception.
- **Fixtures are synthetic.** Never commit a real camp's file, camper names, or
  anything derived from them. `npm run security` scans for some of this, but not
  all of it.

## Native modules

`better-sqlite3-multiple-ciphers` is a native module that must match the
runtime using it:

```bash
npx electron-rebuild -f -w better-sqlite3   # before npm run electron:dev
npm rebuild better-sqlite3                   # before npm test
```

On an Intel Mac, run `npm ci` and `npm run electron:build` under Node 22. A git
worktree needs its own `npm ci`.

## Security issues

See [SECURITY.md](SECURITY.md#how-to-report-a-security-issue).
