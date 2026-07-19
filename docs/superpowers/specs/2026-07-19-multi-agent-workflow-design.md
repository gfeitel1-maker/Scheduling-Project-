# Multi-Agent Workflow Design
**Date:** 2026-07-19
**Project:** Shoresh Camp Scheduling App
**Status:** Approved — implementing

---

## Overview

A 7-agent team governed by a central Governor that holds the user's goal, decomposes it, and drives a quality loop. Every agent except Maker submits feedback. The loop runs a maximum of 2 rounds before either passing or escalating to the user.

---

## Agent Team

### ⚖️ Governor — Opus
**Role:** Orchestrator. Holds the goal, clarifies spec, plans, dispatches, synthesizes feedback, governs the loop.

**Behavior:**
- Asks the user as many clarifying questions as needed before dispatching any agent
- Determines if the feature is UI-significant (triggers Designer) or logic-only (skips Designer)
- Dispatches Maker (sequentially) then Tester + Security + RedHat + Grader (in parallel)
- Reads all feedback, applies pass/retry/escalate logic
- On retry: re-briefs Maker with consolidated feedback from all reviewers
- On escalate: produces consolidated report for user with best-round score and open findings
- Uses `memory-systems` to accumulate institutional knowledge across sessions

**Skills:** `brainstorming` · `long-horizon-prompting` · `latent-briefing` · `writing-plans` · `executing-plans` · `dispatching-parallel-agents` · `harness-engineering` · `memory-systems` · `context-optimization` · `context-compression` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** Current feature spec + all feedback received + project history (from memory)
- **Desire:** Working, safe, visually correct, high-quality feature shipped in ≤2 rounds
- **Intention:** Clarify → classify → plan → dispatch → synthesize → decide pass/retry/escalate

**Designer dispatch triggers (UI-significant):**
- New screen or major component
- Design update request ("make this feel better", "redesign X")
- Visual polish or animation change
- Layout restructure

**Skip Designer (logic-only):**
- Bug fix
- DB / data change
- Engine / algorithm change
- Performance optimization
- Existing component text/label tweak

---

### 🎨 Designer — Sonnet
**Role:** Visual design. Runs before Maker when Governor judges the feature UI-significant. Produces a design spec and prototype that becomes part of Maker's brief.

**Behavior:**
- Uses `clarify` to decompose vague design requests before producing anything
- Reads existing design DNA from the codebase before designing
- Produces: visual spec, mockup/prototype, animation notes with precise terminology
- Output is appended to Maker's brief as a constraint, not a suggestion

**Skills:** `clarify` · `impeccable` · `design-dna` · `prototype` · `emil-design-eng` · `hallmark` · `apple-design` · `find-animation-opportunities` · `improve-animations` · `animation-vocabulary` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** The existing design DNA of the app + Governor's feature intent
- **Desire:** A design spec Maker can implement without making aesthetic decisions
- **Intention:** Clarify brief → read existing DNA → produce spec + prototype → annotate animations

---

### 🔨 Maker — Sonnet
**Role:** Code implementation. Silent — signals "done" only, no feedback report.

**Behavior:**
- Receives Governor's task brief (+ Designer spec when Designer ran)
- Breaks complex briefs into session tasks via `subagent-driven-development`
- Writes tests first when adding new behavior (`test-driven-development`)
- Reviews own code before signaling done (`simplify`, `verification-before-completion`)
- On round 2: reads all reviewer feedback via `receiving-code-review`, incorporates fully
- Never makes aesthetic decisions when Designer spec is present — implements exactly

**Skills:** `karpathy-guidelines` · `test-driven-development` · `systematic-debugging` · `simplify` · `deep-execution` · `subagent-driven-development` · `design-system` · `filesystem-context` · `sync-context` · `verification-before-completion` · `receiving-code-review` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** Governor's task brief + Designer spec (if present) + current codebase state
- **Desire:** Code that satisfies the spec, passes tests, matches the design, and is clean
- **Intention:** Sync → read context → plan tasks → implement → test → simplify → verify → done

**Styling constraint (always active):**
All styles must be inline React style objects. No CSS files. No className for styling. Use existing CSS vars (`--primary`, `--bg`, `--text`, `--surface`, `--surface-elevated`, `--border`, `--text-secondary`, `--success`, `--warning`). Activity colors: `['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']`.

---

### 🧪 Tester — Haiku
**Role:** Director's-eye UX + visual fidelity evaluator. Reports to Grader.

**Behavior:**
- Navigates the app as a non-technical camp director who has never seen it
- Evaluates two dimensions: UX friction (can the director use it?) and visual fidelity (does it match the design spec / existing DNA?)
- When Designer ran: checks implementation against Designer's spec
- When Designer didn't run: checks against existing design language
- Uses SCRIPT.md + DIRECTOR_BRIEF.md as baseline

**Skills:** `webapp-testing` · `ui-ux-pro-max` · `impeccable` · `design-dna` · `evaluation` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** The app as a camp director perceives it, with no technical knowledge
- **Desire:** Zero UX friction, visual design faithful to the spec
- **Intention:** Walk the feature as a director → report friction + visual gaps → score both dimensions

---

### 🔒 Security — Sonnet
**Role:** Threat model and vulnerability audit. Reports to Grader.

**Behavior:**
- Audits new code against OWASP top 10 and app-specific threat surface (RLS, JWT, Supabase, XSS in inline styles, injection via user inputs)
- Confirms every finding is reproducible before reporting — no speculative vulnerabilities
- Uses `systematic-debugging` to investigate potential vulns to their root before flagging

**Skills:** `security-review` · `verification-before-completion` · `systematic-debugging` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** All code is untrusted until proven otherwise
- **Desire:** Zero exploitable vulnerabilities shipped
- **Intention:** Map attack surface → audit code → confirm findings → report only confirmed vulns

---

### 🎩 Red Hat — Sonnet
**Role:** Adversarial challenger. Finds assumptions nobody questioned. Reports to Grader.

**Behavior:**
- Challenges design premises, not just implementation details
- Runs multiple adversarial perspectives via `council-execution`
- Asks: "What is everyone assuming that might be wrong?" "What happens when this breaks at 3am?"
- Does not report bugs — reports risks, edge cases, and assumption failures

**Skills:** `advanced-evaluation` · `council-execution` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** Every assumption in the design is potentially wrong
- **Desire:** Surface the risk nobody thought of
- **Intention:** Challenge premises → run adversarial scenarios → report risks with evidence

---

### 📊 Grader — Haiku
**Role:** Calibrated scorer. Receives Tester + Security + RedHat reports. Applies rubric with position-swap bias mitigation. Outputs score + justification to Governor.

**Rubric (direct scoring, 1–5 per dimension):**

| Dimension | Source | Always scored? |
|-----------|--------|----------------|
| UX Friction | Tester | Yes |
| Security | Security | Yes |
| Resilience | Red Hat | Yes |
| Visual Fidelity | Tester (design-dna) | Only when Designer ran or feature is visual |

**Pass threshold:** Average ≥ 4.0, no individual dimension below 3. Visual Fidelity excluded from average when N/A.

**Bias mitigation:** Runs two scoring passes with reports in swapped order. If passes disagree, returns lower score and flags inconsistency. Requires evidence citation before any score.

**Skills:** `advanced-evaluation` · `evaluation` · `bdi-mental-states`

**BDI Mental State:**
- **Belief:** The three reviewer reports are the ground truth
- **Desire:** An accurate, calibrated, bias-free score
- **Intention:** Evidence → score pass 1 → swap order → score pass 2 → reconcile → output

---

## Loop Structure

```
User → Governor (clarify until spec is clear)
      ↓
      → [UI-significant?] → Designer → spec/prototype → (appended to Maker brief)
      ↓
      → Maker (round 1)
      ↓ "done"
      → [Tester + Security + RedHat] in parallel
      ↓ reports
      → Grader → score + justification
      ↓
      Governor decision:
        PASS (avg ≥ 4, no dim < 3) → signal complete to user
        RETRY (score < threshold AND round == 1) → re-brief Maker with all feedback → round 2
        ESCALATE (score < threshold AND round == 2) → consolidated report to user

Max rounds: 2
Round 2 Maker brief includes: UX friction · vuln findings · red hat risks · grader justification
```

---

## File Structure

```
agents/
  GOVERNOR.md      ← entry point; wires the whole team
  DESIGNER.md
  MAKER.md
  TESTER.md
  SECURITY.md
  REDHAT.md
  GRADER.md
tester/
  BRIEF.md         ← existing QA brief (structured test runs)
  DIRECTOR_BRIEF.md
  SCRIPT.md
  REPORT_*.md
docs/
  superpowers/
    specs/
      2026-07-19-multi-agent-workflow-design.md
```

---

## Model Summary

| Agent | Model | Rationale |
|-------|-------|-----------|
| Governor | Opus | Synthesis, planning, loop governance — quality of Maker brief prevents round 2 |
| Designer | Sonnet | Creative visual judgment; Haiku produces generic results |
| Maker | Sonnet | Code quality is the bottleneck; Haiku makes errors that cost more than saved |
| Tester | Haiku | Scripted navigation + structured report; pattern-matching task |
| Security | Sonnet | Vulnerability recognition requires full pattern coverage |
| Red Hat | Sonnet | Lateral reasoning to challenge premises |
| Grader | Haiku | Applying structured rubric to structured input |

---

## Future State (v2)

- `self-improvement-loops` on Governor: mines own round 2 failures, proposes bounded edits to its briefs
- `hosted-agents`: run team as deployed services
