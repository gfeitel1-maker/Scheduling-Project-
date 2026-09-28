// T229 -- style constants local to the assignment panel, layered on top of
// src/styles/shared.js's S. No CSS modules (component styles are inline React
// objects, per DESIGN_STANDARD/CLAUDE.md).
export const A = {
  refusalCard: {
    background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
    borderRadius: 6,
    padding: '16px 18px',
  },
  refusalTitle: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--danger)',
    marginBottom: 8,
  },
  statValue: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 20,
    color: 'var(--text)',
  },
  // ONE disclosure idiom for the panel's two collapsible sections (skipped rows,
  // unresolved residue), which were a byte-identical local fork of each other.
  // Matches the app's only other styled <details> summary (RosterList): the summary
  // is a control, so it gets weight, colour and a pointer cursor rather than the
  // browser default.
  disclosure: {
    color: 'var(--text-secondary)',
    fontSize: 12,
    marginBottom: 12,
  },
  disclosureSummary: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    padding: '4px 0',
  },
  // The COLLAPSED weight cue for the residue section. The ADR calls residue "the
  // loud half", and a 12px secondary line is quieter than every other attention
  // affordance in the app — so the summary carries the same severity rail the rows
  // inside it carry, and stays legible before anything is expanded. Left CLOSED by
  // default: opening it is a product change, not a styling one.
  //
  // NEUTRAL, because this is the variant used when everything below is an
  // acknowledgment. `residueSummaryDecide` is the bronze one.
  residueSummary: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    cursor: 'pointer',
    padding: '6px 0 6px 10px',
    borderLeft: '3px solid var(--border)',
  },
  // The residue summary when something ASKS for the director. Bronze is the
  // standard's caution hue and a decision is what it is for; with only
  // acknowledgments below, the neutral `residueSummary` is used instead, because
  // nothing there needs attention.
  residueSummaryDecide: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text)',
    cursor: 'pointer',
    padding: '6px 0 6px 10px',
    borderLeft: '3px solid var(--accent)',
  },
  // The one resolution slice 1 implements. A link-button, not a primary: the
  // primary on this screen is Solve Assignments, and resolving must never read as
  // the way forward — residue is a report, and solving stays available either way.
  residueAction: {
    marginTop: 6,
    padding: 0,
    background: 'none',
    border: 'none',
    color: 'var(--primary)',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  residueResolved: {
    marginTop: 6,
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  // T298 — several actions on one row, so they need to sit on a line rather than
  // stack. A row with ONE action keeps `residueAction` exactly as it was; this
  // wraps two or three of them without changing how one looks.
  residueActions: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: 14,
  },
  // The mapping picker. A native <select> deliberately: the camp's activity list
  // is an open set of arbitrary length, the platform's own control handles a long
  // one better than anything built here would, and there is no existing combobox
  // in this codebase to extend — inventing one for a picker used on a residue row
  // would be the drift `design-system` exists to prevent.
  residuePicker: {
    marginTop: 8,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    alignItems: 'center',
  },
  residueSelect: {
    fontFamily: 'inherit',
    fontSize: 12,
    padding: '4px 6px',
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text)',
    maxWidth: 260,
  },
  // WHY AN OPTION IS PRESELECTED, stated rather than implied. A preselected value
  // in a picker is a proposal, and a proposal a director cannot see the reason for
  // is indistinguishable from the app having decided.
  residueProposal: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  // The distinguishing token of one residue item, and the shared fact above a
  // group of them. Same name/why split as the attention surface
  // (src/screens/RootsHomeScreen.jsx) so one concept reads one way across screens.
  residueWhy: {
    fontWeight: 600,
    fontSize: 13,
    color: 'var(--text)',
    overflowWrap: 'break-word',
  },
  residueHeads: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    marginTop: 2,
    overflowWrap: 'break-word',
  },
  busyRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
  },
}
