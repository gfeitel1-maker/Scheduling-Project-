---
title: "Repository-layer policy: repositories where shared persistence mapping exists, localClient otherwise"
document_type: adr
authority: normative
status: accepted
date: 2026-08-04
supersedes: []
implementation_state: existing pattern — policy now explicit
affects: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
---

# Repository-layer policy: repositories where shared persistence mapping exists, localClient otherwise

**Status:** accepted

## Context

`ARCHITECTURE_STANDARD.md` and the documented dependency rule both describe a four-tier renderer stack:

```
Screens → Hooks → Repositories → localClient
```

One repository exists — `src/data/scheduleRepository.js` — covering the schedule domain. Approximately fifteen non-schedule screens call `localClient` directly, because no repository exists for their entities (groups, tiers, activities, cohorts, time blocks, days, anchors, devices, users). Three schedule-adjacent screens mix repository calls with direct `localClient` calls for the same entities.

The 2026-08-04 architecture audit (TARGET_ARCHITECTURE §8 R5; BOUNDARY_AUDIT §src/data/scheduleRepository.js) found that the rule as written describes an aspiration for one domain and a structural fiction for the rest. Writing fifteen pass-through repositories to satisfy the diagram would add fifteen files whose deletion test would fail for most of them: deleting a pass-through repository would reduce complexity at the call site, not increase it.

The audit's recommendation: amend the rule to match the code's actual, sound choice.

## Decision

**A repository is required when a domain has meaningful shared persistence mapping, normalization, batching, or access policy worth centralizing.** Do not create pass-through repositories merely to satisfy a diagram.

The two approved dependency shapes are:

```
Complex mapped domain:
  Screen → Hook → Repository → localClient

Simple domain:
  Screen → Hook → localClient
```

A screen may call `localClient` directly only for genuinely simple, screen-owned operations where a hook would add no reusable behavior. The practical signal is the deletion test: if deleting a repository disperses real complexity across call sites, the repository is earning its keep. If deleting it would reduce complexity at the call site, the repository is a pass-through and should not exist.

Components remain presentational and must not perform IO except for separately documented, approved exceptions (current approved exception: `DeleteWeekDialog`, which performs its own reads to compute live deletion counts — see BOUNDARY_AUDIT §Week management).

## What caused `scheduleRepository` to exist

`src/data/scheduleRepository.js` earned its existence by replacing three separately-drifting copies of the same engine-slot → DB-row mapping (`mapSlotToRow`). The deletion test passes: removing the repository reintroduces that triplication. That is the standard a new repository must meet.

## Candidate for a second repository

`activities` is the strongest current candidate: it has the most fields of any entity, the most screens touching it, an existing partial hook (`scheduleRepository.writeActivityFields`), and the same multi-field write pattern that made schedule mapping nontrivial. A second repository for `activities` should not be created until evidence of repeated mapping or access divergence accumulates across call sites. That evidence does not currently exist.

Do not create repositories for all existing entities. The remaining entities (groups, tiers, cohorts, time blocks, days, anchors, devices, users, camps) do not currently show the multi-site drift that would justify centralization.

## Consequences

- `ARCHITECTURE_STANDARD.md` is amended to replace the bare `Screens → Hooks → Repositories → localClient` rule with this policy and the two approved dependency shapes.
- The ~15 screens that call `localClient` directly are conforming under the amended rule, not violations of it.
- The architecture audit finding R5 (layering rule 90% aspirational) is closed by this amendment.
- Future work adding domain repositories must meet the deletion-test standard described above.
- The `activities` repository is a named future candidate; no ticket should be created for it without concrete evidence of mapping divergence.
