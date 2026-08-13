---
title: "Shoresh Ingestion UX — Reconciliation and Uncertainty Compression"
document_type: spec
status: active
created: 2026-08-09
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
archive_when: the ingestion-reconciliation initiative closes and its ADRs record Verifier PASS
---

# Shoresh Ingestion UX — Reconciliation and Uncertainty Compression

> **Founding brief for the `work/ingestion-reconciliation` initiative.** This is the product owner's directive, captured verbatim as the authoritative source. It is DISCOVERY-FIRST: do NOT begin by implementing new screens. Phase A (architecture audit → ADR) precedes any feature code. Governor decomposes into tickets after repository inspection.

## PURPOSE

The ingestion system has become technically capable enough that the next problem is no longer simply:

> "Can Shoresh extract information from an existing camp schedule?"

The problem is now:

> "How can Shoresh reconstruct a camp from imperfect source documents without forcing a camp director to inspect hundreds of inferred facts?"

This work should redesign the ingestion/onboarding experience around that problem.

DO NOT begin by implementing new screens.

First inspect the current ingestion architecture, data model, reconciliation logic, confidence/inference behavior, Setup Readiness flow, activity rules, fixed events, source aliases, enrichment workbook, locations-related work, and current UI.

Determine what already exists and what would need to change.

The desired product model is described below.

## CORE PRODUCT PRINCIPLE

Shoresh should not ask a director to verify an imported schedule.

Shoresh should ask the director to resolve the uncertainty created while interpreting the schedule.

A director may upload a workbook containing hundreds of schedule cells. Those hundreds of observations should NOT produce hundreds of things to review. They should produce a reconstructed camp model plus a small number of meaningful decisions.

The interface should compress evidence into decisions.

## THE FUNDAMENTAL PIPELINE

SOURCE DOCUMENTS → OBSERVATIONS → ENTITY RECONCILIATION → PATTERN DETECTION → PROPOSED CAMP MODEL → CONFIDENCE / UNCERTAINTY CLASSIFICATION → DIRECTOR DECISIONS → CONFIRMED CAMP MODEL

The UI should primarily expose the bottom two layers. The director should not normally need to inspect the machinery above them.

## FOUR TYPES OF INFORMATION (must be distinguished explicitly)

1. **OBSERVED** — something actually appeared in a source (Alufim 1 had Swim Tue 10:35; Art occurred 22 times). Evidence, NOT automatically rules.
2. **INFERRED** — a pattern strong enough to propose meaning (Mifkad appears to be a daily fixed event; Swim ~2x/week for six groups). Must retain provenance so Shoresh can explain WHY.
3. **CONFIRMED** — director explicitly confirmed, or sufficient prior confirmed knowledge exists. Becomes authoritative config.
4. **UNKNOWN** — source lacks evidence (priority, staffing, location, intentional-vs-incidental). UNKNOWN IS A VALID STATE. Do not manufacture information to complete the model. `frequent != high priority`; `recurring != necessarily fixed`; `observed last year != required next year`. Prefer "unknown" over an unjustified rule.

## CONFIDENCE CONTROLS USER ATTENTION

Director workload is determined by uncertainty, not by the amount of imported data.

- **HIGH** (Mifkad 9:20 every weekday, every group): reconstruct without interruption; show in summary; don't require confirmation absent other concern.
- **MEDIUM** (Swim exactly 2x/week, six groups): propose the rule; "Looks right / Edit" — extremely cheap to resolve.
- **LOW / CONFLICT** (Ruach Friday for most but records disagree): surface a focused question; director resolves; do not make them reconstruct from scratch.

## INFERENCE PRODUCES PROPOSALS, NOT FORMS

BAD: "Please configure Swim" [frequency][priority][eligible groups][days][location][staff]…

GOOD: "Here's what Shoresh thinks Swim means." Observed: six groups, usually 2x/week, days vary. Proposed rule: 2/week, eligible [groups]. Unknown: priority. Actions: Looks right / Edit.

Only request information that actually requires human judgment.

## IMPORT RESULT = RECONCILIATION REPORT

After ingestion, do NOT dump the director into the current large inference interface. Primary destination becomes something like:

```
Shoresh reconstructed your camp from last year's schedule.
UNDERSTOOD      374 observations / facts reconciled
NEEDS ATTENTION 4 decisions
NOT IN SOURCE   2 optional setup areas
CHANGED         7 differences from existing configuration
```

Then summarize the reconstructed model by meaningful categories (STRUCTURE / SCHEDULING MODEL / RESOURCES), with ✓ understood, ⚠ needs review, ○ not present. **Derive the exact categories from the actual Shoresh domain model, not these examples.**

## REVIEW IS EXCEPTION-DRIVEN

If Shoresh understands 374 things and is uncertain about four, the primary action is "Review 4 decisions", not "Review your imported camp". Permit: resolve one decision, return to summary, leave and return later, accept high-confidence reconstruction, open advanced details on demand, change inferred/confirmed rules later via normal screens. NOT a mandatory setup wizard.

## DO NOT HIDE TRANSPARENCY

Compression != opacity. Every inference remains inspectable ("Why does Shoresh think this?" → the evidence: per-group observed days). But evidence is progressively disclosed; it does NOT occupy the primary interface.

## SETUP READINESS EVOLVES

Distinguish REQUIRED TO BUILD A SCHEDULE (units, groups, days, time blocks, activities, enough activity rules to generate) versus OPTIONAL ENRICHMENT (locations, staffing, facility map, other). A missing optional resource does NOT mean the camp is misconfigured. Shoresh can say "Ready to build a week." AND "Locations have not been configured."

## MULTIPLE SOURCE DOCUMENTS ARE NORMAL

Do not assume one master workbook. Schedule workbook / location source / staffing source separately enrich the SAME camp model: source A → partial model; source B → enrich/reconcile; source C → enrich/reconcile. Architecture must support incremental enrichment rather than requiring all info simultaneously.

## CAMP / FACILITY MAP — FUTURE CAPABILITY TO DESIGN FOR NOW

The map does NOT currently exist as a feature. Do NOT bolt in a full mapping system unless architectural review shows a small prerequisite must be added now. BUT the ingestion/domain architecture should leave room for it. Future Shoresh should represent a camp's physical environment (sources: uploaded image, PDF, diagram, manual map, location list). Locations (Pool, Gym, Art Room, Field, Gaga Pit, Archery, Theater, Playground, Pavilion) should become first-class entities that may later connect to activities, fixed events, capacity, simultaneous-use constraints, indoor/outdoor, weather mode, transitions, accessibility, staffing, scheduling constraints. DO NOT assume all of these get built — they explain why location identity must not be modeled narrowly around today's importer.

## FUTURE LOCATION INGESTION EXPERIENCE

A reconciliation report might say: "Locations — Not found in the uploaded schedule. [Add another source] [Build/use camp map] [Add manually] [Skip for now]". A schedule lacking location info is NOT an ingestion failure. Same for staffing.

## THE MAP IS NOT JUST DECORATION

When eventually designed: FACILITY MAP → LOCATION ENTITIES → ACTIVITY↔LOCATION RELATIONSHIPS → SCHEDULING CONSTRAINTS. But preserve flexibility — do not prematurely design GIS/spatial engine. A director may simply upload a map and identify meaningful places on it.

## SOURCE PROVENANCE MUST SURVIVE COMPRESSION

SOURCE → OBSERVATION → INFERENCE → CONFIRMATION. Matters for: explaining decisions, re-import, changed-source detection, reconciliation, debugging, confidence calculation, future MCP/CLI. Inspect whether existing ingestion already preserves enough. PREFER extending existing provenance mechanisms over parallel systems.

## RE-IMPORT IS A FIRST-CLASS USE CASE

Distinguish: what Shoresh knew before / what the new source says / what changed / what is unchanged / what conflicts. (Swim was 2/week, new source most groups 2/week → no attention. New source several groups 3/week → surface a possible change.) Onboarding is hardest year one, dramatically easier thereafter.

## FUTURE MCP / CLI (not this slice)

Do not build now. But preserve a domain model that eventually allows NL ops ("Swim twice a week for every group except Giborim"; "Arts & Crafts can use either the art room or pavilion"). GUI, ingestion, and future CLI/MCP manipulate the SAME domain concepts — do not encode critical scheduling semantics exclusively inside UI components.

## ARCHITECTURAL QUESTIONS FOR THE GOVERNOR (Phase A must answer)

1. What portions of this model already exist?
2. How does the current importer represent: observations, inferred rules, confidence, provenance, reconciliation, aliases, fixed events, activity rules, locations?
3. Where is current UI exposing internal inference state directly to the director?
4. Can existing ingestion output be transformed into a reconciliation report WITHOUT rewriting the importer?
5. What information currently gets inferred without sufficient evidence?
6. Where is "high priority" currently assigned and why?
7. Can UNKNOWN become an explicit state where necessary without breaking scheduling?
8. How should confirmed director decisions survive re-import?
9. What existing Setup Readiness concepts should be reused?
10. What minimal architectural decisions are necessary NOW to preserve future facility-map support?
11. Are locations already sufficiently first-class in the schema/domain for that future?
12. What tests protect re-import/idempotency/reconciliation behavior?
13. Which proposed changes are domain changes versus presentation changes?

## AGENT REVIEW (perspectives required)

- **ARCHITECT** — domain boundaries; inference/provenance architecture; future map compatibility; avoiding parallel models.
- **UI/UX AUDITOR** — cognitive load; progressive disclosure; reconciliation flow; directors see decisions, not machinery.
- **RED HAT** — destructive reconciliation; incorrect high-confidence inference; silent overwrites; re-import behavior; ambiguous source interpretation.
- **SECURITY** — spreadsheet/file ingestion boundaries; formula injection & existing sanitization; future map/document ingestion attack surface.
- **TESTER** — regression coverage; idempotent re-import; confirmed-vs-inferred state; source changes; unknown states.
- **REVIEWER** — unnecessary complexity; duplicated systems; scope creep; whether implementation actually reduces director workload.

## WORKTREE / BRANCH DISCIPLINE

Do not develop in the main working tree. Governor inspects current git/worktree state + conventions, then creates ONE clearly named isolated worktree/branch (suggested `ingestion-reconciliation`; use repo convention — this repo uses `work/<name>` off main). Rules: main stays stable; no overlapping worktrees without need; explicit dependency order; merge foundational/domain changes BEFORE dependent UI; verify tests before each merge; verify main after merge; delete completed worktrees per project practice; don't ask the user to do git ops unless genuinely necessary; explain any user-facing git decision in plain language.

## IMPLEMENTATION ORDER (Governor decomposes after inspection)

- **PHASE A — DISCOVERY / ADR:** current architecture audit → define observed/inferred/confirmed/unknown semantics → confidence + provenance requirements → minimal future-map compatibility requirements.
- **PHASE B — DOMAIN GAPS:** fix unjustified inference → explicit uncertainty where necessary → preserve confirmed decisions → re-import reconciliation semantics.
- **PHASE C — COMPRESSION LAYER:** convert ingestion results into understood / needs-attention / missing-unknown / changed → generate director-facing decisions from unresolved uncertainty.
- **PHASE D — EXPERIENCE:** reconciliation summary → focused decision resolution → progressive "why?" evidence → Setup Readiness integration.
- **PHASE E — VALIDATION:** real import, re-import same, modified import, incomplete import, multiple-source enrichment, regression suite, UI/UX audit.

## SCOPE CONTROL (do NOT)

build MCP now; build CLI now; build full staffing scheduling now; build electives now; build a GIS system; build the entire camp map merely because described here; replace working ingestion machinery unnecessarily; redesign unrelated screens; create a second parallel setup model; turn this into a mandatory wizard; force directors to confirm high-confidence info; infer certainty merely to eliminate blank fields.

## SUCCESS TEST

Not "did Shoresh parse the workbook?" but: "A director uploaded last year's schedule with hundreds of pieces of information. How many decisions did Shoresh require before they could productively use the reconstructed camp?" Target: AS FEW AS THE EVIDENCE JUSTIFIES. Not zero. Not one question per field. Not one screen per category. The smallest set of genuine human judgments to turn historical evidence into a usable camp model.

## PRODUCT NORTH STAR

Give Shoresh what you already have → Shoresh reconstructs what it can → shows you what it believes it understands → asks only about the things it cannot responsibly decide → you resolve those → you have a usable camp model. Everything else remains available for inspection, correction, enrichment, or later configuration — but never stands between the director and a usable schedule.
