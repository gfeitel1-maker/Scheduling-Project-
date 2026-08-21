// T73/S5b — a plain-camp phrase for each field a diff or conflict can name, so
// neither the kept-change card nor the reconciliation ledger ever shows a raw
// column name ("Swim's frequency will change from 2 to 3", not "min_per_week").
// Extracted from ImportScreen.jsx so ImportScreen and ReconciliationLedger share
// ONE map (design spec §7.3 — "do not author a second one"). Unknowns fall back
// to a humanized column name.
export const FIELD_LABEL = {
  location: 'where it happens',
  sort_order: 'the order it appears in',
  day_of_week: 'which day of the week it is',
  start_time: 'when it starts',
  end_time: 'when it ends',
  availability: 'when it’s available',
  min_per_week: 'how many times a week (fewest)',
  max_per_week: 'how many times a week (most)',
  priority: 'how important it is',
  eligible_groups: 'which groups can do it',
  unit: 'which age division it belongs to',
  name: 'its name',
  label: 'its name',
}

export const fieldLabel = (f) => FIELD_LABEL[f] ?? String(f).replace(/_/g, ' ')
