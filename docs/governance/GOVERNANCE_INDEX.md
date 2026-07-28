---
title: Governance Index
document_type: index
authority: governing
status: active
applies_to: [product, architecture, security, design, testing, workflow, agents]
last_reviewed: 2026-07-28
review_trigger: any document promoted, archived, moved, or added to the standards set
---

# Governance Index

**Start here to find out what governs a piece of work.** This page resolves authority mechanically
so no agent has to infer it.

Every path below points at a document that exists today. Paths marked **→ moving** are scheduled to
relocate when historical material is archived; the entry will be updated in that same commit.

---

## 1. Highest authority

[`constitution/CONSTITUTION.md`](constitution/CONSTITUTION.md), subordinate only to explicit current
human instruction. It holds the precedence order, the ten rules, the human-approval gates, the agent
roster, and the loop.

## 2. What Governor always reads

`CLAUDE.md` · this index · `constitution/CONSTITUTION.md`

Nothing else by default. Everything below is loaded because a task class calls for it.

---

## 3–8. Task-class routing

| Task class | Governing standards | Current-state reference | Deterministic checks | Human gate |
|---|---|---|---|---|
| **Architecture** | `CONSTITUTION.md` Art. I · relevant ADRs | `PLATFORM_STATE.md` | test · lint · build · integration | **ADR approval** |
| **UI / UX / design** | `docs/superpowers/specs/design-system.md` **→ moving** | `PLATFORM_STATE.md` §screens | test · lint · build | changing a token *value* |
| **Security / auth** | [`../../SECURITY.md`](../../SECURITY.md) · ADRs `2026-07-24-centralized-authorization-layer`, `2026-07-25-device-trust-revocation`, `2026-07-25-append-only-audit-event-log` | `SECURITY.md` "Known limitations" | test · lint · build · **integration (mandatory)** | **any change to an accepted tradeoff** |
| **Scheduling engine** | `CONSTITUTION.md` Art. V (determinism, surface-don't-resolve) | `PLATFORM_STATE.md` §engine | **`buildSchedule.test.js` (mandatory)** · test · lint · build | flag taxonomy or placement priority |
| **Database / sync** | relevant ADRs · `2026-07-24-bulk-replace-seq-fix`, `2026-07-28-first-pairing-domain-sync-and-template-identity` | `PLATFORM_STATE.md` §schema | **integration (mandatory)** · fresh-vs-migrated schema equivalence · test · lint · build | **ADR + migration/rollback plan** |
| **Copy / terminology** | `CONSTITUTION.md` Art. V | — | lint | terminology is product judgement |
| **Documentation / governance** | this index · `CONSTITUTION.md` | — | link + reference check | **any change to a constitution or standard** |

Gate commands: `npm run test` · `npm run lint` · `npm run build` · `node test/integration/run.js`
(the integration harness covers cross-process behaviour — pairing, revocation, token renewal,
conflict detection, clock skew, role changes — that the unit suite structurally cannot).

---

## 9. Descriptive only — never cite as law

`PLATFORM_STATE.md` · `README.md` · the "What is hardened" and "Known limitations" sections of
`SECURITY.md`

These describe what exists now. Per `CONSTITUTION.md` Article I they sit **below** code and test
evidence: where they disagree with the code, the code is right and the document is stale. Report the
drift; do not reason from the stale text.

## 10. Historical — never load as instruction

`docs/superpowers/plans/**` · `docs/superpowers/specs/**` · `legacy/**` · `tester/REPORT_2026-06-28.md`

Two exceptions currently living in `docs/superpowers/specs/` that are **not** historical:

- `design-system.md` — the authoritative design and token contract **→ moving**
- `2026-07-19-multi-agent-workflow-design.md` — superseded as law by `CONSTITUTION.md` Art. VI–VII;
  retained as the historical design record

Everything else under those two directories is a completed plan or design. Several describe the
retired Supabase architecture accurately as of their date. **`docs/superpowers/specs/2026-05-24-security-design.md`
in particular is a detailed, confident, fully-retired security architecture** — it is not current
guidance and must not be read as such.

---

## 11. Resolving disagreement between documents

Apply `CONSTITUTION.md` Article I. In short:

1. Is one of them historical? It loses.
2. Is one of them describing reality (`PLATFORM_STATE.md`) and the other prescribing it (a standard)? The standard governs what *must* be true; the description is evidence of what *is*.
3. Does the code contradict a standard? **Report it and stop.** Do not amend the standard to match the code, and do not amend the code to match a standard without the human gate.
4. Still tied? Escalate. Rule 8 permits any role to stop and challenge.

## 12. When work stops for human review

See `CONSTITUTION.md` Article IV for the exhaustive list. The gates most often hit in practice:
an architecture change with no ADR · a change to an accepted security tradeoff · a Verifier FAIL or
UNVERIFIED at round 2 · anything irreversible.

## 13. Conditionally loaded specialist references

`tester/SCRIPT.md` (regression walkthrough) · `tester/DIRECTOR_BRIEF.md` (director persona) ·
`tester/BRIEF.md` — all **→ moving**. Loaded by Tester; not authority for anyone else.

## 14. Never authority, however detailed

- Anything in §10.
- Any completed spec or plan, regardless of how precisely it is written.
- Agent-local summaries — where an agent constitution restates a standard, **the standard wins**.
- Files under `~/.claude/` — personal defaults, subordinate to this repository (Art. III).
- Skills — convenience, never authority.

Detail is not authority. A 200-line historical plan does not outrank a 10-line current standard.

---

## Agent context loading

Every agent always loads `CONSTITUTION.md` and its own constitution. Beyond that:

| Agent | Also loads | Must not load |
|---|---|---|
| Governor | this index, `CLAUDE.md` | standards outside the task class |
| Architect | `PLATFORM_STATE.md` §schema, ADRs | design standard, historical specs |
| Designer | design system, `PLATFORM_STATE.md` §screens | architecture, security, schema |
| Maker | the brief, ADR if any, design system when UI | other agents' constitutions |
| Code Reviewer | the brief, the diff | `SECURITY.md` (Security's jurisdiction) |
| Verifier | the brief's success predicate, gate list | every standard — judgement is not its jurisdiction |
| Tester | `tester/*.md`, Designer's spec if any | schema and architecture docs — **it must not know what `template_slots` is** |
| Security | `SECURITY.md`, the three auth ADRs | **`docs/superpowers/specs/2026-05-24-security-design.md` and all archived security material** |
| Red Hat | `PLATFORM_STATE.md` §known-issues, accepted tradeoffs | design standard |
| Grader | the four reports, its rubric | source code — it must form no independent opinion |

The "must not load" column is load-bearing. Security's entry exists because a retired threat model
sat in an active agent constitution for weeks without being noticed.
