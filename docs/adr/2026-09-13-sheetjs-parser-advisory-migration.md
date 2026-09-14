---
title: "Migrate off npm-published SheetJS (xlsx) to the advisory-fixed line"
document_type: adr
authority: normative
status: accepted
date: 2026-09-13
supersedes: []
implementation_state: implemented
program: security-hardening
affects:
  - package.json
  - src/utils/exportSanitize.js
  - scripts/ingestCli.js
  - scripts/mcp/tools.js
  - src/ingest/workbookToSource.js
  - src/ingest/sheetGrid.js
  - src/screens/ImportScreen.jsx
  - src/screens/ActivitiesScreen.jsx
  - src/screens/AnchorsScreen.jsx
  - src/screens/DaysScreen.jsx
  - src/screens/GroupsScreen.jsx
  - src/screens/LocationsScreen.jsx
  - src/screens/TiersScreen.jsx
  - src/screens/TimeBlocksScreen.jsx
  - src/screens/elective/ElectiveSetDetail.jsx
  - src/screens/event/EventGridEditor.jsx
---

# Migrate off npm-published SheetJS (xlsx) to the advisory-fixed line

**Status: ACCEPTED.** A standalone security-hardening ticket, separable from any feature work.
It records a decision with a supply-chain consequence (the install source changes), accepted and
implemented together: `package.json` is pinned to the CDN tarball and the ingest test corpus
re-verified against the new version.

## Context

Shoresh parses camp schedule files (`.xlsx`/`.xlsm`/`.xls`) with SheetJS, imported as the `xlsx`
package. A camp file is the one input a director routinely **receives from someone else** and
imports — so the parser processes attacker-authorable input under the ordinary workflow, not only
under an exotic threat model.

The pinned dependency is `xlsx@^0.18.5` — the last SheetJS release published to the public npm
registry. `npm audit` reports two open **high**-severity advisories against it, both with **no fix
available on npm**:

- **Prototype Pollution** — [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)
- **Regular-Expression Denial of Service (ReDoS)** — [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)

SheetJS stopped publishing to npm after 0.18.5 and now distributes fixed releases (0.20.x and
later) **only from its own CDN** (`https://cdn.sheetjs.com/...`). The advisory fixes therefore
cannot be obtained by an `npm update` — resolving them requires changing where the dependency is
installed from, which is why this is a decision and not a routine bump.

### What is and is not already mitigated

Two hardening controls already exist in `src/utils/exportSanitize.js` and are applied on the
primary ingest paths:

- **`assertImportFileSize` + `assertWorkbookComplexity`** bound byte length, sheet count, and rows
  per sheet *before the workbook is walked*. These blunt the **ReDoS / zip-bomb** angle on the
  paths that call them. (A separate ticket, "Wire import caps into 7 per-entity XLSX importers",
  closes the gap that these caps are not yet wired into every read path.)
- **`unescapeRow` / `sanitizeCell`** handle formula/CSV injection on the read/write round-trip
  (ADR 2026-08-08).

Neither control addresses **prototype pollution**, which triggers *inside* `XLSX.read` during
parsing — before any cap or unescape step runs. That advisory is the load-bearing reason for this
migration; the caps are a partial, not a complete, mitigation.

## Decision

Pin SheetJS to the advisory-fixed line (0.20.x or later) installed from the SheetJS CDN tarball
rather than the npm-registry `xlsx@0.18.5`, and keep it current against future advisories.

The concrete `package.json` form SheetJS documents is a versioned CDN tarball dependency, e.g.:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

The import surface (`import * as XLSX from 'xlsx'`) is unchanged, so no call site needs to change
for the swap itself; the affected files listed above are the parse/read sites that must be
re-verified against the new version, not necessarily edited.

## Options considered

1. **Migrate to the SheetJS CDN fixed line (recommended).** Directly resolves both advisories.
   - *Cost:* the dependency no longer resolves from the npm registry. CI, `npm ci`, and any
     air-gapped or mirror-based install must be able to fetch (or vendor) the CDN tarball. Lockfile
     integrity is preserved by npm against the tarball URL, but the supply-chain trust root shifts
     from "npm registry" to "SheetJS CDN".
2. **Vendor a fixed build into the repo.** Removes the network-at-install-time dependency; adds a
   checked-in binary blob the team must manually keep current. Heavier maintenance; only warranted
   if (1)'s install-source constraint proves unworkable in CI.
3. **Replace SheetJS with a different parser** (e.g. `exceljs`). Largest blast radius — every
   parse/serialize call site and the whole ingest test corpus would need re-validation against a
   different API and different quirks. Not justified by the advisories alone.
4. **Accept the risk, rely on the existing caps.** Rejected: the caps do not touch prototype
   pollution, and the input is attacker-authorable under the normal workflow.

**Recommendation: option 1.** It is the smallest change that actually closes the prototype-pollution
advisory, keeps the existing API and test corpus intact, and is what SheetJS itself prescribes. The
one real tradeoff — install source moves off the npm registry — is an operational CI concern to
validate, not a security regression.

**Confidence: medium-high.** High that option 1 is the right direction; medium on install-source
friction until CI (`npm ci` in the actual pipeline) is proven against the CDN tarball.

## Consequences

- Both open high advisories clear `npm audit`.
- CI and every install path must fetch the CDN tarball; validate `npm ci` in the real pipeline
  before merge. Document the install source in `SECURITY.md` and README so a future `npm install`
  surprise is pre-explained.
- A standing item is added to the Security agent's supply-chain checklist (already recorded in
  `.claude/agents/security.md`): re-check SheetJS advisories on every bump, against the installed
  version.

## Verification

- `npm audit` shows zero high advisories attributable to `xlsx`.
- The full ingest test corpus (`src/ingest/**`, `scripts/mcp/tools.test.js`, the integration
  scenarios) passes unchanged against the new version — this is the regression proof that the
  parser swap did not alter parse behavior.
- `npm ci` succeeds in CI from a clean cache.
