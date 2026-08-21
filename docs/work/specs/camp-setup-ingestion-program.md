---
title: Camp Setup + Ingestion Program Brief
document_type: program-brief
status: draft
authority: subordinate-to-constitution
owner: Governor (session camp-setup-ingestion-0ce0e1)
created: 2026-08-21
review_trigger: any workstream promoted to an ADR or spec; any change to the peer-session boundary
related_sessions:
  - architecture-product-audit-d0340e (owns authoring UI + grid interaction + special-day/override render)
  - shoresh-v1-closure-audit-14b20a (owns Roots Context census / UNKNOWN model)
---

# Camp Setup + Ingestion Program Brief

Reframes the owner's 10-item brain-dump (roots → day overrides) into a governed
program. This is a **program**, not a build order: most items are decisions or
research that must resolve — several through an ADR or a human product ruling —
before any Maker touches code. Terminology and "what done means to a director"
are explicit human-approval gates (Constitution Art. IV).

## Product intent (binds every workstream)

Shoresh lets a camp director control, adapt, and own their setup and schedule.
The director is not a software operator. Pre-production: no live camps yet, so
prefer clean cutovers over back-compat caution — quality, test-first at real
seams, and adversarial review still hold.

## Program success predicate

The camp-setup + ingestion pipeline, from "roots" (ingested reality) through
day-level overrides, is coherent when: (a) one ratified vocabulary is used in
data model, ingest, and UI with no synonym drift; (b) a director can go from an
uploaded prior-year artifact to a correct, editable setup — units included —
without hand-repair; (c) every screen in the setup path earns its place in the
navigation (no overwhelming pathway sprawl); and (d) electives, single-day
events, and location maps are first-class, director-authored, and match how
directors actually think — verified by the Tester against real uploaded
artifacts, not assumptions.

## Peer-session boundary (agreed 2026-08-21)

- **architecture-product-audit owns:** elective authoring UI (T105/T110/T111),
  empty-cell inline-editor grid interaction (T112), special-day AUTHOR UI
  (T106), day-override re-point/render (T108), facility topology ADR (build
  deferred), and the special_days→Roots Context wiring (T107, shared with
  v1-closure).
- **This program owns (ingestion side):** special-day INGEST (incl. the T16
  " - " split mis-read of person/room cells), elective INGEST (recognizing
  flattened "Chugim"/"Indoor Elective" activities as elective-set candidates),
  unit-creation-from-import, terminology unification, and location mapping.
- **Two overlaps requiring a sync before either side writes:** (1) day-overrides
  — they re-point/render, this program only ingests into the data model; (2) the
  Roots "Context" census surface — this program feeds it but does not touch the
  census/UNKNOWN model.

## Workstreams

| ID | Workstream | Type | Gate | Depends on | Route |
|----|-----------|------|------|-----------|-------|
| W1 | Vocabulary unification (unit vs age-division, "programs", "resources"=locations) | Decision | HUMAN (terminology) | — | domain-modeling → Architect ADR |
| W2 | Setup navigation / IA (roots-primary vs import-first; cut pathway sprawl) | Decision | HUMAN (nav model) | W1 labels | brainstorming → Designer → ADR |
| W3 | Roots visual direction (metaphor vs node-graph vs watermark; salvage node animation) | Design | Director approval | — | brainstorming → prototype → Designer |
| W4 | Elective + single-day event INGEST | Research+Impl | uploads; HUMAN (mental model) | uploads, W1 | domain-modeling → Architect |
| W5 | Location mapping hardening (upload non-geospatial maps; drag-drop render) | Research+Impl | uploads | uploads | prototype → Architect ADR → Maker |
| W6 | Ingestion correctness: units-from-import | Impl | — | W1 | systematic-debugging → Maker → Verifier |
| W7 | Camp-specific wording pass | Impl | — | W1, W6 | Designer copy spec → Maker → Tester |
| W8 | Peer-reach architecture (syncthing) — RESEARCH DONE by peer session; see note | Research (complete) | HUMAN (productionization) | — | ADR exists (peer branch) |
| W9 | Programming-collaboration via doc storage on events/electives | Concept | HUMAN (new capability) | W4 | brainstorming → domain-modeling → Architect |
| W10 | MCP surface (CLI shipped, MCP did not) | Impl | — | — | mcp-builder + tool-design → Maker → Verifier |
| W11 | /improve-codebase-architecture | Audit | — | all | architecture-auditor (standalone) |

### Sequence

1. Parallel start: **W1** (foundation), **W10** (independent build), **W3**
   (design track), **W8** (research spike).
2. W1 unblocks **W2, W6, W7**.
3. **W4 / W5** unblock the moment the director provides uploads; **W9** follows W4.
4. **W11** last, event-triggered by the ADRs this program produces.

### Non-counting outcomes (do not return these as "done")

- Code changes on any HUMAN-GATE item before the director has ruled.
- Elective/location work started before the director's real artifacts exist.
- A terminology "fix" that picks a synonym without the glossary being ratified.
- Any syncthing implementation — W8 is a written recommendation only.
- Writing the day-override data model or Roots Context census model without
  syncing the peer sessions that own the render/census sides.
- A tidy screen that hides a conflict, unfillable slot, or sync issue.

## Current status (2026-08-21)

- W1: brainstorm with owner IN PROGRESS (owner chose to brainstorm before any
  glossary draft).
- W4, W5: PARKED pending owner uploads (events/electives, camp maps).
- W8: RESEARCH COMPLETE by peer session `relaxed-albattani-000799`
  (branch claude/shoresh-future-architecture-364e03). Accepted ADR
  docs/adr/2026-08-17-shared-project-multi-transport-sync.md + SYNCTHING_SPIKE.md;
  field-tested on owner's two machines (embedded+tuned Syncthing via relay,
  fsWatcherDelayS=1 → ~47ms one-way, 0 missed). PRODUCTIONIZATION (bundle binary
  into real electron/, package/sign, auto-pair via identity flow) is a SEPARATE
  owner-gated program — not started by anyone; do not begin without an owner ruling.
- All others: not started.
