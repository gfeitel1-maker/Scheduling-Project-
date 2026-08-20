---
title: "Roots home-screen audit remediation (Emil design-eng + Impeccable)"
document_type: spec
status: active
created: 2026-08-20
task_class: ui-ux-design
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/DESIGN_STANDARD.md]
related_docs:
  - docs/work/specs/2026-08-20-roots-dashboard-spine-design.md
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
---

# Roots home-screen audit remediation

After the 3D-relief backdrop + woodcut-orb "lantern" node system merged (PR #121,
main d59afd4), the shipped surface was audited through two lenses — Emil Kowalski's
design-engineering craft/motion framework and the Impeccable whole-screen product
review. This spec captures **every** finding (not just the top ones) as ticket-sized
work, with a recommended approach and acceptance criteria per item, plus the review
scorecard as the target the work is trying to move.

Surface files: `src/components/reconciliation/RootMap.jsx`,
`src/components/reconciliation/rootMapLayout.js`, `src/index.css`,
`src/screens/ReconciliationScreen.jsx`.

Mode: **Operate** (this is the app home / a working dashboard). Guiding principle for
every ticket: **make interactivity and state legible without breaking the calm.** The
craft is shipped and real; nothing here is a regression fix — these are increments.

Coordination note: this surface is owned by the reconciliation initiative (its live
session has ended). Land as a reviewable PR; do not merge without the owner's go.

## Success predicate

The remediation is done when, on the Roots home screen:
1. A first-time director can tell the nodes are interactive **without hovering**.
2. Every node's state is distinguishable **without relying on hue alone**.
3. The domain→root spatial map is learnable **without per-hover probing**.
4. All node glow (hover / selection / attention) runs on `opacity`, not animated
   `filter`, and degrades correctly under `prefers-reduced-motion`.
5. The composition has no reading of "unfinished" dead space, and the hero's size is a
   deliberate IA decision, not an accident.
6. Named edge states (many-attention, many-children, narrow resize) are verified.

## Review scorecard — targets

| Dimension | Now | Target | Tickets |
| --- | --- | --- | --- |
| Distinctiveness / POV | 9 | hold ≥9 | (protect) |
| Visual hierarchy | 6 | 8 | RA-10, RA-11 |
| Metaphor legibility | 6 | 8 | RA-9 |
| Interaction affordance | 5 | 8 | RA-7 |
| Cognitive load (rest) | 8 | hold ≥8 | (protect across all) |
| Accessibility | 6 | 8 | RA-8, RA-3 |
| Product intentionality | 9 | hold ≥9 | (protect) |

Protect list (do NOT sand off while fixing the above): the restraint at rest, the
engraving craft, the trunk-holds-the-dashboard metaphor, the honest empty-state copy
("nothing needs you right now"), the ARIA/keyboard model.

## Tickets

### Wave 1 — craft & motion (low-risk, no design decision)

**RA-1 — Glow via an opacity layer, not animated `filter`.** *(Emil E1+E2)*
- Before: hover/selection glow = inline `filter: drop-shadow(...)` transitioned; attention = `@keyframes rootmapPulse` animating `filter: drop-shadow` infinitely.
- After: render a pre-painted blurred glow element behind each orb (a soft radial in the state colour) and animate/transition its **`opacity`**. Pulse = opacity keyframe; hover/selection = opacity transition.
- Why: `filter` is paint-bound; an infinite filter animation repaints forever, and it doesn't scale if several orbs light at once. Opacity is compositor-only.
- Acceptance: no `filter` is animated or transitioned on nodes; hover, selection, and attention still read; reduced-motion still shows a static selection cue; the many-attention case (RA-12) stays smooth.

**RA-2 — Gate hover-glow to fine pointers.** *(Emil E3)*
- Before: hover state set via JS `onMouseEnter`/`onFocus`, ungated.
- After: only apply the hover glow when `(hover: hover) and (pointer: fine)`, or clear it on `pointerup`/`pointercancel` for coarse pointers.
- Why: on a tap, `onMouseEnter` can leave a stuck glow. Low risk on Electron desktop, but correct.
- Acceptance: a simulated touch tap does not leave a persistent hover glow; keyboard focus still lights the node.

**RA-3 — Soften press scale.** *(Emil E4)*
- Before: `pressScale = pressed ? 0.92 : 1`. After: `0.96`.
- Why: on a ~34px orb, 0.92 lurches; 0.95–0.97 reads as pressed without the jump.
- Acceptance: press still gives feedback; motion is subtle.

**RA-4 — Label show-delay.** *(Emil E5)*
- Before: the label pill appears instantly on hover.
- After: ~120ms delay before a label shows; instant once any label is already open (Emil's tooltip principle).
- Why: sweeping the pointer across the fan currently flickers a label on every orb crossed.
- Acceptance: quick sweeps don't flash labels; a deliberate hover shows the label promptly; the first label after a rest still waits the delay.

**RA-5 — Backdrop to a modern format.** *(Emil E6)*
- Before: `root-map-3d.png` ≈ 1.8 MB (the LCP hero).
- After: ship WebP (and/or AVIF) at equivalent quality; keep a PNG fallback only if a target renderer needs it (Electron/Chromium supports WebP).
- Why: perceived performance — it's the biggest thing on first paint.
- Acceptance: backdrop file materially smaller (target <600 KB) with no visible quality loss at production width; packaging/build.files still ships it.

### Wave 2 — legibility (light design, no IA change)

**RA-6 — Resting interactivity affordance + first-visit cue.** *(Impeccable I1; reconcile with existing T94)*
- Before: orbs read as decorative until hovered; the "click me" reward comes only after discovery.
- After: give resting orbs a permanent, quiet affordance (a hairline ring, a 1px lift, or a consistent cursor+outline) AND a one-time first-visit coach cue ("these are clickable"). **Reconcile with T94** (roots first-timer orientation caption) so we ship one coherent cue, not two.
- Why: on a home surface a director may never learn the roots are the interface.
- Acceptance: nodes signal interactivity at rest without adding visual noise at the all-understood default; first-visit cue shows once and is dismissible; no duplication with T94.
- Recommendation: a single hairline resting ring in `--anchor` at low opacity + reuse the T94 caption as the first-visit cue (don't invent a second coach mark).

**RA-7 — Non-colour second channel for state.** *(Impeccable I3)*
- Before: understood/attention/changed filled orbs differ only by hue; absent/not_set_up differ by shape.
- After: add a non-colour cue for the three filled states (a tiny glyph, differing ring weight, or fill texture) so a colour-blind director distinguishes them on the canvas, not just in the panel/ARIA.
- Why: WCAG 1.4.1 (use of colour) — state must not be conveyed by colour alone.
- Acceptance: the five states are mutually distinguishable in greyscale at production size; the panel/ARIA labels remain the source of truth; calm at rest preserved.
- Recommendation: differentiate by a small engraved glyph baked into each orb sprite (e.g., understood = solid, changed = a re-struck double-ring already in the sprite kit, attention = the fissure) rather than adding SVG chrome — keeps the woodcut register.

**RA-8 — Self-describing domain map.** *(Impeccable I4)*
- Before: Structure-left … Context-right ordering is intentional but invisible until per-orb hover.
- After: a persistent, very quiet way to learn the map once — either faint always-on domain labels near the five major roots, or a single-line legend beneath the tiles.
- Why: the eye should learn the layout once, not re-probe each visit.
- Acceptance: a first-timer can name which region is which domain without hovering; the cue is quiet enough not to compete with node state.
- Recommendation: a one-line legend under the tile row (Structure · Scheduling · Time · Facility · Context, left→right) — cheaper and calmer than five canvas labels, and it doubles as orientation.

### Wave 3 — information architecture (needs a decision + Architect)

**RA-9 — Hero footprint decision.** *(Impeccable I2)*
- Problem: the tree is the largest element but the controls (tiles, nodes, panel) carry the task; it's currently between "tree is the interface" and "tree is ambient backdrop."
- Options: (a) commit to **tree-as-primary** — pull the tile counts into/around the crown so the hero *is* the control surface; (b) **tighten** the tree so the tiles/nodes clearly lead. 
- Decision owner: product + Architect. Recommendation: **(a) tree-as-primary**, since the whole thesis is roots-as-interface — but this is an ADR-worthy change, not a quick edit.
- Acceptance: the hero's size is justified by an explicit IA decision recorded in an ADR; visual-hierarchy read improves to the target.

**RA-10 — Bottom-third dead space.** *(Impeccable I5)*
- Problem: raising the tree left the lower canvas empty (no nodes below ~0.66), reading as unfinished.
- Options: crop the canvas height to the live region, or use the space (e.g., the inspector panel sits in it on wide screens).
- Recommendation: on wide screens, move the inspector panel into the lower-canvas region so the space is used and the tree/panel read as one composition; crop on narrow.
- Acceptance: no "unfinished" dead-space read at any supported width.

### Verification

**RA-11 — Edge-state hardening.** *(Impeccable I6)*
- Verify and, where needed, fix: many simultaneous attention nodes (noise + perf with RA-1), a domain with many children (canvas caps at 5 positions — confirm the panel roster absorbs overflow), and window resize down to a narrow Electron pane (tiles wrap; orbs stay on their roots).
- Acceptance: each state has a test or a documented manual check; none degrades the calm or drops the orb-on-root registration.

## Recommended sequence

1. **Wave 1** (RA-1…RA-5): pure craft/perf, no design decisions — one Maker pass, reviewed + verified.
2. **Wave 2** (RA-6…RA-8): legibility; light Designer input, then Maker; reconcile RA-6 with T94.
3. **Decisions gate**: owner picks RA-9 and RA-10 directions; Architect writes the ADR for RA-9 if pursued.
4. **Wave 3** (RA-9, RA-10): IA changes behind the ADR.
5. **RA-11**: edge-state verification folded into each wave's gate; final Grader read.

Each wave is its own branch/PR through the Governor loop (Maker → Code Reviewer → Verifier → Grader; Red Hat on RA-1's motion-state changes and RA-9's IA change). Full `npm run verify` gate before each PR.
