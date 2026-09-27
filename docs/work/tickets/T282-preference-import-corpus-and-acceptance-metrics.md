---
title: "Stage 4 — a synthetic shape-parameterised import corpus and the two acceptance numbers"
document_type: ticket
status: open
created: 2026-09-27
task_class: test-infrastructure
archive_when: "a shape-parameterised generator emits every observed and plausible shape class with a test that FAILS if a class is uncovered; every camper name in the corpus provably comes from a committed synthetic name list, asserted by a test, and no file derived from a real camp's filled-in responses is committed in any format; the corpus includes re-import and drifted-re-import cases; and the correct-binding rate and the silent-miss rate are both reported from tests that enter at file bytes and assert at the database, with the silent-miss number covering remembered bindings as well as freshly proposed ones and labelled device-local unless the journal is deliberately aggregated"
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md]
---

# T282 — Stage 4: the corpus and the acceptance metrics

Umbrella: **T278**. Design: ADR §8, §8.0.

**Synthetic-only is normative and NO GATE CAN ENFORCE IT.** `scanPrivacy` cannot match an
unstructured personal name, and `scripts/security-gate.js:295-298` records that binary files are
path-scanned only, contents never read. The name-list assertion in `archive_when` is the only real
control — see ADR §8.0.

**Shape class H (a camp-platform portal export) must be modelled as UNKNOWN and never fabricated.**
No vendor publishes a column-level spec and no sample has been seen. **No longer blocked — ADR §9 Q1
is CLOSED, answered NO (2026-09-27).** The owner will not supply a real export, and his reasoning is
the design reason rather than a refusal: designing the reader against one real file makes that file
the spec. Class H is therefore a shape class this corpus **deliberately designs without**, not a gap
awaiting a sample.

**STAGE 4 IS PART-BUILT AND THE BASELINE IS MEASURED.** On the owner's instruction, 40 probe files
were built and run against unmodified code before any adapter existed — results in ADR §8.1, raw run
in `docs/work/evidence/T282-preference-corpus-baseline.json`. Shipped this round:

- `scripts/fixtures/make-preference-corpus.mjs`, `test/fixtures/preference-corpus/`
- `scripts/preferenceCorpusProbe.mjs` (measurement harness — asserts nothing, by design)
- `test/preferenceCorpusNames.test.js` — the §8.0 clause 4 synthetic-name control, which is the
  `archive_when` clause about a committed name list, now satisfied

**ROUND 4 SCOPE CORRECTION.** The owner has ruled T278 is the **elective** importer only — electives
are a nested schedule inside an already-defined day. The seven probes that entered through
`runIngestCli` (the camp-schedule path) are out of scope and excluded from the totals: P20, P21, P24,
P25, P27, P28, P40. Corrected in-scope counts over 33 probes: **9 WORK / 17 BREAK LOUDLY / 7 BREAK
SILENTLY**. The silent-miss baseline to beat is therefore **7 of 33**, not 9 of 40. See ADR §11.

**A consequence for this ticket's own design.** Because the days, periods, and *which coordinates are
elective at all* already exist in the projection (`template_slots.elective_set_id` /`event_id`), the
corpus can assert the three mechanical checks in ADR §11.2 — domain, elective-eligibility, coverage —
rather than only a director's confirmation. That is what makes the silent-miss metric computable
without a human in the loop.

**Still open for this ticket:** the shape-parameterised coverage test that FAILS when a class is
uncovered; scaling to a ~500-camper realistic camp with per-division geometries; and both acceptance
numbers (correct-binding rate, silent-miss rate) reported from tests rather than from a harness. The
silent-miss baseline to beat is **7 of 33** (see the round-4 correction above), and P38 is the drifted-re-import instance §8's metric 2
says must be zero.
