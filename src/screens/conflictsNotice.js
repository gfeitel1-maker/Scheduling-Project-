// Maps every non-success syncClient.write()/resolveConflict() status to an
// inline message for the conflict card. 'conflict' keeps the original
// round-1/round-2 copy; 'timeout'/'disconnected' get connectivity-specific
// copy; 'error' (and anything unrecognized) gets a generic fallback so no
// status can ever fall through silently with buttons just re-enabling and no
// explanation.
//
// Lives in its own module (not ConflictsScreen.jsx) so that screen file only
// exports its component — keeping react-refresh/only-export-components happy.
export function noticeForStatus(status) {
  switch (status) {
    case 'conflict':
      return "This changed again — pick again below."
    case 'timeout':
    case 'disconnected':
      return "Couldn't reach the network — try again when connected."
    case 'error':
    default:
      return 'Something went wrong — try again.'
  }
}
