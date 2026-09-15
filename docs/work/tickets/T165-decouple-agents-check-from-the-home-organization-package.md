---
title: "Decouple agents:check from the unversioned home organization package"
document_type: ticket
status: completed
created: 2026-09-14
task_class: test-infrastructure
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-09-04-portable-agent-team-compatibility-layer.md]
archive_when: npm run agents:check produces a correct verdict on a machine with no ~/.claude/organization directory, and the fragment source it used is recorded in a file under version control
---

# T165 — Decouple `agents:check` from the unversioned home organization package

`scripts/generateAgentProfiles.js` resolves its fragment source to
`~/.claude/organization` and hard-exits 1 when that directory is absent:

```js
if (!fs.existsSync(ORG_DIR)) { console.error(`No organization package at ${ORG_DIR}`); process.exit(1) }
```

That directory is `VERSION 0.1.0`, holds one fragment (`SKILL_MANDATE_WRAPPER.md`), and is not
under version control anywhere. So the verdict of a project gate depends on untracked home state:
a fresh clone, CI, or a second machine gets a hard failure rather than an answer.

**This blocks T166.** Adding `agents:check` to `VERIFY_STEPS` before this is fixed would couple
`npm run verify` — the whole gate — to that directory.

## Shape of the fix
Vendor the fragments into the repo and resolve `ORG_DIR` with an environment-variable override
that still defaults to the home path, so nothing breaks for the current machine. The fragment
bytes must be preserved exactly: `generateAgentProfiles.js` strips one trailing newline when
splicing, so a whitespace change there re-renders all 13 profiles.

## Related rot found while investigating
`--check` never reads `docs/governance/agent-bindings/manifest.json` — it is written only under
`--write`. The recorded `adapter_hash`/`generated_hash` values can therefore be arbitrarily stale
and nothing notices. Making the manifest load-bearing belongs with this work.

## Closed 2026-09-15 — verified, not assumed

Implemented at some point without a closing reference, so the ticket sat `open`
while the code had moved. Found by checking the premise before rebuilding it.

`scripts/generateAgentProfiles.js` now resolves fragments to
`docs/governance/agent-fragments/` **by default** (same `VERSION` + `fragments/*.md`
shape as the home package, so an override behaves identically), with
`SHORESH_ORG_DIR` as the override for fragment development against a live
`~/.claude/organization`.

Verified rather than read: `node scripts/generateAgentProfiles.js` with **no**
environment variable exits 0 — *"All generated profiles are byte-identical to the
committed .claude/agents/*.md files."* The vendored `fragments/SKILL_MANDATE_WRAPPER.md`
is present in the repo.

A near-miss worth recording: pointing `SHORESH_ORG_DIR` at a nonexistent path
still exits 1, which is correct, and briefly looked like a live gate-breaking
defect until the default path was tested. The check that matters is the one with
no override set.
