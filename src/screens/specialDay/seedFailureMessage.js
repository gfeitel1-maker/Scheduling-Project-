// T106 fix round — non-atomic seeding (accepted): each block's writes in
// SpecialDaysScreen.seedFromCampTimeBlocks are sequential op-log calls, not a
// transaction. A failure partway through leaves the already-written blocks
// in place — this says so, so a director isn't misled into thinking the seed
// either fully succeeded or fully failed. Its own module (rather than a named
// export alongside the screen's default component) so it can be unit-tested
// without react-refresh's only-export-components constraint.
export function seedFailureMessage(seededCount, totalCount) {
  return seededCount > 0
    ? `Added ${seededCount} of ${totalCount} blocks.`
    : "Couldn't add blocks."
}

export function cellFailureMessage(names) {
  const list = [...new Set(names.filter(Boolean))].join(' and ')
  return `Blocks copied; couldn't add ${list || 'your fixed events'} — add them by hand or try again`
}

export function bringFailureMessage(names, written) {
  const list = [...new Set(names.filter(Boolean))].join(' and ')
  return `${written > 0 ? `Added ${written} cell${written === 1 ? '' : 's'}; c` : 'C'}ouldn't add ${list} — try again`
}
