---
title: "An imported double-period bundle's name comes from each device's local activity name, so two concurrent imports can conflict"
document_type: ticket
status: open
created: 2026-10-11
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-29-linked-elective-bundles.md]
related_tickets: [docs/work/tickets/T219-multi-day-catalog-linkage.md]
archive_when: "two devices importing the same file, one holding an unsynced rename of a choice activity, write the same elective_bundles.name for the bundle, proven by a test that drives both devices' imports and asserts no conflicts row"
---

# T375: an imported bundle's name can differ between two concurrent imports

Found by Red Hat on #961 (T219). The keeper ruled it gets fixed if small and ticketed otherwise. It is ticketed because the fix needs data that `materializeImportedVersion` does not have today.

## Cause

`writeSpanBundles` (`electron/ops/materializeImportedVersion.js`) names each bundle `<choice activity name> — <day label>`. It reads both parts from the device's own database at import time.

- Bundle ids are content-derived from set, activity, day and block ids, not from names. So the same file converges on the same rows.
- The `name` field, though, is written by every device that runs the import.
- Suppose device A has renamed the Pottery activity to Ceramics and that rename has not synced yet. If A and B both import the same file, A writes "Ceramics — Monday" and B writes "Pottery — Monday".
- That is a concurrent write of different values to one field, so a `conflicts` row is raised.

**When it does not happen:** if only one device imports, nothing conflicts. The other device's rename touches `activities.name`, never the bundle.

## Fix direction

Name the bundle from the file's own text (the choice label and day as printed), so every device importing the file writes identical bytes.

- `materializeImportedVersion` receives the placements, which carry the day name and, for list cells, the choice text.
- A header-word elective's choices arrive through `confirmedElectiveSets` at commit time and are not passed to materialize. They would need to be threaded through, or the name settled at commit time.

## Not in scope

The id derivation, which already converges.
