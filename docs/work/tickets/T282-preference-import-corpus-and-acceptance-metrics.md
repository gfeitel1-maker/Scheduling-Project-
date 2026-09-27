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
No vendor publishes a column-level spec and no sample has been seen. Blocked on ADR §9 Q1.
