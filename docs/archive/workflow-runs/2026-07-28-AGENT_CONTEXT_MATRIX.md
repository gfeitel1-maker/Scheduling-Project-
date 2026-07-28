> **ARCHIVED — historical record, not current authority.**
> Governance audit of 2026-07-28. Its recommendations were executed across four PRs;
> where this document and the current tree differ, the tree is right. Several proposals
> here were deliberately **not** adopted (see the PRs for why).
> Current law: [`docs/governance/GOVERNANCE_INDEX.md`](../../governance/GOVERNANCE_INDEX.md)

# Agent Context Matrix — Shoresh

**Produced:** 2026-07-28 · **Phase:** read-only audit · **Status:** proposal awaiting approval

Phases 6 and 7. Paths below are the **proposed post-migration** paths; they do not exist yet.
The goal is not to hard-code one graph — it is to make Governor's dynamic routing informed,
concise, inspectable, and portable.

---

## Part 1 — Per-agent context

Every agent, without exception, always loads `AGENT_WORKFLOW_CONSTITUTION.md` and its own
constitution. Those are omitted from the table below to keep the signal visible.

| Agent | Always loaded | Conditionally loaded | Must not load by default | Required output |
|---|---|---|---|---|
| **Governor** | `GOVERNANCE_INDEX.md` · `PROJECT_CONSTITUTION.md` · `CLAUDE.md` | Standards named by the task class · prior `task-state/` for resumed work | Any standard outside the task class · `docs/archive/**` · full `PLATFORM_STATE.md` (index into it, don't inhale it) | Workflow manifest + Maker brief + pass/retry/escalate decision |
| **Architect** | `ARCHITECTURE_STANDARD.md` · `docs/adr/` index · `PLATFORM_STATE.md` §schema | `SECURITY_STANDARD.md` (auth/sync) · specific prior ADRs · `archive/legacy-architecture/` **when explicitly asked why something was retired** | Design standards · token standard · `docs/archive/**` unprompted | Design + explicit `ADR required: yes/no` |
| **Designer** | `DESIGN_PRINCIPLES.md` · `TOKEN_STANDARD.md` · `UI_STATE.md` | `PRODUCT_PRINCIPLES.md` (new screens) · `references/director-persona.md` | `ARCHITECTURE_STANDARD.md` · `SECURITY_STANDARD.md` · schema docs | Design spec + prototype + animation notes |
| **Maker** | `ARCHITECTURE_STANDARD.md` · `TESTING_STANDARD.md` · the brief | `TOKEN_STANDARD.md` + `DESIGN_PRINCIPLES.md` (UI) · `SECURITY_STANDARD.md` (trust boundary) · the ADR if one exists | `GOVERNANCE_INDEX.md` · other agents' constitutions · `docs/archive/**` | `DONE` signal + files changed + criteria confirmed |
| **Code Reviewer** | The brief/design · the diff · `ARCHITECTURE_STANDARD.md` | `TOKEN_STANDARD.md` (UI diffs) · relevant ADR | `SECURITY_STANDARD.md` (Security's jurisdiction) · `docs/archive/**` | Findings by severity + plan-alignment verdict |
| **Verifier** | `TESTING_STANDARD.md` · the brief's success predicate | Task-specific check definitions from the spec | Every standard — **judgement is not its jurisdiction** | PASS / FAIL / **UNVERIFIED** + raw output |
| **Tester** | `references/director-persona.md` · `references/regression-script.md` · `UI_STATE.md` | Designer's spec when one exists · `TOKEN_STANDARD.md` for fidelity checks | `ARCHITECTURE_STANDARD.md` · `SECURITY_STANDARD.md` · schema docs (**it must not know what `template_slots` is**) | UX friction + visual fidelity findings + 2 scores |
| **Security** | **`SECURITY_STANDARD.md`** · `SECURITY_STATE.md` · ADRs `2026-07-24-centralized-authorization-layer`, `2026-07-25-device-trust-revocation`, `2026-07-25-append-only-audit-event-log` | `ARCHITECTURE_STANDARD.md` (sync/IPC changes) | `docs/archive/**` — **especially `2026-05-24-security-design.md`, which describes the retired Supabase/RLS/Vercel model** | Confirmed vulnerabilities only + clean-areas list + score |
| **Red Hat** | `PRODUCT_PRINCIPLES.md` · `PLATFORM_STATE.md` §known-issues | `SECURITY_STATE.md` accepted tradeoffs (so it challenges the *right* assumptions) | Design standards · token standard | Risks + assumption failures + unhandled edge cases + score |
| **Grader** | The four reports · its rubric | Verifier's report **for context only — never to override it** | Source code · standards · **anything that would let it form an independent opinion** | Consolidated score + justification + PASS/FAIL |

### Three rules this matrix encodes

1. **Tester must not know the schema.** Its value is the non-technical director's perspective; loading `PLATFORM_STATE.md` destroys the instrument. Its current constitution already says this (L32) — the matrix makes it enforceable.
2. **Security's "must not load" list is now the most important cell in the table.** The single largest defect in current governance (C1-1) is that the Security agent reads a retired threat model. After migration, the retired model still exists — in `docs/archive/` — and must be explicitly excluded, not merely un-referenced.
3. **Grader never reads code.** It scores reports. Loading source lets it form the independent opinion its own constitution forbids.

---

## Part 2 — Task-class routing

Ten task classes. **These are informed defaults, not a fixed graph** — Governor may deviate and must record why, exactly as `task-state/2026-07-26-manual-grid-editing.md` already does today.

Legend: ✅ dispatch · ⬜ skip · ⚠️ conditional (trigger stated)

### 1. Trivial copy change
| | |
|---|---|
| Capabilities | copy judgement |
| Agents | Maker ✅ · Verifier ✅ · everyone else ⬜ |
| Governing docs | `PRODUCT_PRINCIPLES.md` |
| Checks | `npm run lint` · `npm run build` |
| Human gates | none |
| Max repair loops | 1 |
| Completion evidence | lint + build pass |
| Manifest | **not required** |

### 2. UI styling change
| | |
|---|---|
| Capabilities | visual design · frontend implementation · design-standard review |
| Agents | Designer ⚠️ (*new component or novel visual moment; skip for token-swap-only*) · Maker ✅ · Code Reviewer ✅ · Tester ✅ · Verifier ✅ · Grader ✅ · Security ⬜ · Red Hat ⬜ · Architect ⬜ |
| Governing docs | `DESIGN_PRINCIPLES.md` · `TOKEN_STANDARD.md` · `UI_STATE.md` |
| Checks | test · lint · build |
| Human gates | none unless it changes a token *value* → then it amends `TOKEN_STANDARD.md` and needs approval |
| Max repair loops | 2 |
| Completion evidence | Verifier PASS · Tester visual-fidelity ≥ 4 |

### 3. Navigation / information-architecture change
| | |
|---|---|
| Capabilities | information architecture · frontend implementation · UX validation |
| Agents | Designer ✅ · Maker ✅ · Code Reviewer ✅ · Tester ✅ · Verifier ✅ · Grader ✅ · Red Hat ⚠️ (*if it changes what a director can reach*) |
| Governing docs | `PRODUCT_PRINCIPLES.md` · `DESIGN_PRINCIPLES.md` · `PLATFORM_STATE.md` §screens |
| Checks | test · lint · build |
| Human gates | **approve the revised IA before Maker starts** |
| Max repair loops | 2 |
| Completion evidence | Verifier PASS · Tester UX ≥ 4 · screen inventory updated in `PLATFORM_STATE.md` |
| Precedent | The 2026-07-26 sidebar/nav work; PLATFORM_STATE L209 shows an unreachable-screen bug that only a live walk caught |

### 4. Scheduling-engine change
| | |
|---|---|
| Capabilities | algorithm design · determinism reasoning · regression testing |
| Agents | Maker ✅ · Code Reviewer ✅ · Verifier ✅ · Red Hat ✅ (*eligibility/flag edge cases*) · Grader ✅ · Architect ⚠️ (*if slot shape or flag taxonomy changes*) · Designer ⬜ · Security ⬜ · Tester ⚠️ (*if flags surface differently in the UI*) |
| Governing docs | `ARCHITECTURE_STANDARD.md` · `TESTING_STANDARD.md` |
| Checks | **`src/engine/buildSchedule.test.js` mandatory** · test · lint · build |
| Human gates | changing flag taxonomy or placement priority — that is product judgement |
| Max repair loops | 2 |
| Completion evidence | Verifier PASS · **seeded-PRNG determinism explicitly asserted** (identical inputs → identical schedule) |
| Note | `buildSchedule.js` is the only unit-tested module in the project; that test is the strongest deterministic asset in the repo |

### 5. SQLite schema migration
| | |
|---|---|
| Capabilities | schema design · migration safety · replay reasoning |
| Agents | **Architect ✅ (mandatory — ADR bar met by definition)** · Maker ✅ · Code Reviewer ✅ · Verifier ✅ · Red Hat ✅ · Security ⚠️ (*if it touches auth/device/audit tables*) · Grader ✅ · Designer ⬜ · Tester ⬜ |
| Governing docs | `ARCHITECTURE_STANDARD.md` · `TESTING_STANDARD.md` · prior schema ADRs |
| Checks | test · lint · build · **`node test/integration/run.js` mandatory** · **fresh-db vs. migrated-db schema equivalence** |
| Human gates | **ADR approval before implementation** · migration + rollback + recovery plan (constitution rule 5) |
| Max repair loops | 2, then escalate |
| Completion evidence | Verifier PASS on all four · ADR filed · rollback documented |
| Precedent | v17 (`anchor_id`/`is_anchor`) and the `PROJECTIONS`-registry omissions — both were *silent* failures where ops were written but nothing materialised. **Registry-completeness must be an explicit check, not an inference from "tests passed."** |

### 6. Sync-protocol change
| | |
|---|---|
| Capabilities | protocol design · conflict reasoning · cross-process verification |
| Agents | **Architect ✅ · Security ✅ · Red Hat ✅** (all mandatory) · Maker ✅ · Code Reviewer ✅ · Verifier ✅ · Grader ✅ · Designer ⬜ · Tester ⚠️ (*if conflicts surface in the Conflicts screen*) |
| Governing docs | `ARCHITECTURE_STANDARD.md` · `SECURITY_STANDARD.md` · ADRs `2026-07-24-bulk-replace-seq-fix`, `2026-07-28-first-pairing-domain-sync-and-template-identity` |
| Checks | **`node test/integration/run.js` mandatory** · test · lint · build · idempotency of retried `client_write_id` |
| Human gates | **ADR approval** · any change to conflict-resolution semantics (a director-facing product decision) |
| Max repair loops | 2, then escalate |
| Completion evidence | Verifier PASS incl. integration · conflict path exercised · ADR filed |
| Note | This is the class where C1-8 does the most damage: today Verifier can return PASS without ever running the cross-process suite |

### 7. Authentication or security change
| | |
|---|---|
| Capabilities | threat modelling · auth implementation · adversarial review |
| Agents | **Security ✅ · Architect ✅ · Red Hat ✅** (all mandatory) · Maker ✅ · Code Reviewer ✅ · Verifier ✅ · Grader ✅ |
| Governing docs | `SECURITY_STANDARD.md` · `SECURITY_STATE.md` · ADRs `2026-07-24-centralized-authorization-layer`, `2026-07-25-device-trust-revocation`, `2026-07-25-append-only-audit-event-log` |
| Checks | integration harness **mandatory** (pairing, revocation, renewal, role change) · test · lint · build · audit-log assertions |
| Human gates | **any change to an accepted tradeoff in `SECURITY_STATE.md` stops for approval** — the plaintext-PIN-over-`ws://` and offline-token-expiry decisions are yours, not an agent's |
| Max repair loops | 1, then escalate |
| Completion evidence | Verifier PASS · Security score ≥ 4 with confirmed findings only · `SECURITY_STATE.md` updated |

### 8. Documentation-only change
| | |
|---|---|
| Capabilities | technical writing · authority classification |
| Agents | Maker ✅ · Code Reviewer ✅ · Verifier ⚠️ (*governance-lint only*) · everyone else ⬜ |
| Governing docs | `GOVERNANCE_INDEX.md` · the metadata standard |
| Checks | link check · frontmatter check · stale-technology check |
| Human gates | **any change to a constitution or standard** |
| Max repair loops | 1 |
| Completion evidence | governance-lint passes |
| Note | **This is the class this audit itself belongs to.** It is also the class with no deterministic checks today — which is how C1-1 through C1-9 accumulated. |

### 9. Release preparation
| | |
|---|---|
| Capabilities | build verification · packaging · security posture review |
| Agents | Verifier ✅ · Security ✅ · Tester ✅ · Red Hat ⚠️ · Grader ✅ · Governor ✅ |
| Governing docs | `TESTING_STANDARD.md` · `SECURITY_STANDARD.md` · all of `docs/current/**` |
| Checks | full suite · integration · `npm run electron:build` · packaged-app smoke test · **dev-vs-packaged db-path check (T9)** · doc-freshness check |
| Human gates | **release approval is always human** |
| Max repair loops | n/a — blocks until green |
| Completion evidence | every gate green · `docs/current/**` reviewed as of this build · no open CONFIRMED ticket of HIGH severity |

### 10. High-risk cross-cutting change
| | |
|---|---|
| Capabilities | all of them |
| Agents | **all ten** |
| Governing docs | full standards set + `PROJECT_CONSTITUTION.md` |
| Checks | everything, plus any task-specific predicate the spec names |
| Human gates | **scope approval before Architect** · **design approval before Maker** · approval before merge |
| Max repair loops | 1, then escalate — do not grind a high-risk change through two silent repair rounds |
| Completion evidence | Verifier PASS · Grader ≥ 4.0 with no dimension < 3 · zero unresolved UNVERIFIED claims · manifest complete |
| Precedent | The manual-grid-editing task classified itself HIGH risk and still (correctly) skipped Security and Red Hat with stated reasons. **Risk level does not automatically mean every agent — but the omission must be recorded, and the class must be re-opened if a reviewer surfaces the omitted concern.** |

---

## Part 3 — Workflow manifest recommendation (Phase 7)

**Not required** for classes 1 and 8. **Required** for classes 3–7, 9, 10. **Optional** for class 2.

Proposed form — frontmatter prepended to the existing `task-state/<slug>.md`, so this adds a
machine-readable header to a practice the project already follows rather than a new artefact:

```yaml
---
task: manual-grid-editing
document_type: task-state
status: active
risk: high
task_class: navigation-ia            # from the ten classes above
created: 2026-07-26
required_capabilities:
  - information-architecture
  - frontend-implementation
  - design-standard-review
  - regression-testing
standards:
  - DESIGN_PRINCIPLES.md
  - TOKEN_STANDARD.md
  - ARCHITECTURE_STANDARD.md
selected_agents: [designer, maker, verifier, code-reviewer, tester, grader]
omitted_agents:
  architect: "no new data model; existing template_slots op-log path"
  security:  "no auth/trust-boundary change"
  red_hat:   "no persistence/sync model change"
deterministic_checks: [npm run test, npm run lint, npm run build]
human_gates:
  - approve revised information architecture
repair_routing:
  max_rounds: 2
  round_1: [D1, D2, D3]
completion_evidence:
  - verifier_pass
  - grader_pass
  - screenshots_compared
unresolved: []
archive_when: "all tickets closed and Verifier PASS recorded"
---
```

**Why this shape.** The `omitted_agents` map — reason required per omission — is the single most
valuable field, and the existing task-state file already produces it in prose. It makes routing
*inspectable after the run*: you can ask "why was Security skipped?" and get an answer that was
recorded before the outcome was known, not reconstructed afterwards.

`repair_routing` and `unresolved` close the loop the current file leaves open: today the task-state
records where the work started but is amended in place as it proceeds, so the routing rationale and
the repair history are not separable.

**Explicitly not proposed:** a coded orchestration graph. Governor's semantic routing is working —
the 2026-07-26 task-state is evidence of a correctly-reasoned, correctly-recorded, non-obvious
routing decision. The gap is observability and portability, not judgement. Revisit a coded graph
only against the Phase 13.10 triggers.

---

## Part 4 — Which checks belong where (Phase 12)

| Safeguard | Home | Rationale |
|---|---|---|
| Broken local Markdown links | `npm run lint:docs` + CI | Fast, deterministic; catches the 9 broken agent paths |
| **Agent name ↔ filename ↔ index reference match** | **test** (Vitest) | Same pattern as the existing `eslint.supabase-ban.test.js` — a governance invariant asserted as a test, which is the one enforcement mechanism this repo has already proven works |
| Retired-technology strings in active governing files | **test** | Would have caught C1-1 the day the migration landed. Allowlist `docs/archive/**` and `legacy/**` |
| Required frontmatter present and valid | lint:docs + CI | Enforces the metadata standard |
| `CLAUDE.md` links to `GOVERNANCE_INDEX.md` | lint:docs | One line, prevents the entry point silently detaching |
| Every active spec names its `governing_docs` | lint:docs | Prevents new buried authority |
| Archived docs never listed as active context | test | Guards the Security "must not load" rule |
| Duplicate document IDs / basenames | lint:docs | Catches ` 2.md` and the `schedule-iteration.md` collision |
| Manifest contains required evidence fields | Governor completion rule | Judgement-adjacent; a lint would be brittle |
| Doc-freshness on architectural change | **git hook** (warn, don't block) | Touching `electron/db/**` or `electron/sync/**` without touching `docs/current/**` is suspicious, not wrong |
| Renamed docs leave redirects | CI, migration-window only | Temporary safeguard; retire after migration settles |
| **Dev-mock ↔ real-client parity** | test | The dev mock has already hidden one project-blocking defect (PLATFORM_STATE L209). Asserting the mock implements the same surface as `localClient` is the deterministic fix for C1-9 |

The last row is not in the spec's list. It is the audit's own recommendation, and it is the only
safeguard here that protects *code* correctness rather than document hygiene — included because the
governance failure it addresses (verifying in an unfaithful environment) has already cost this
project real time.
