// Plain reasons for a failed write (spec 0.4); never a raw error.
export function failureCopy(err) {
  const text = `${err?.message ?? ''} ${err?.code ?? ''} ${err?.error ?? ''}`.toLowerCase()
  if (/not_found|stale/.test(text)) return { message: 'Someone else changed this just now. Showing the latest.', stale: true }
  if (/permission|not authorized|forbidden|unauthori[sz]ed|denied/.test(text)) return { message: 'You no longer have permission to change imports.', stale: false }
  return { message: 'Something went wrong saving that. Nothing was changed.', stale: false }
}
