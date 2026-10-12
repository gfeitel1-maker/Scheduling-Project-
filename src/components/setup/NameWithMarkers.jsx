// A setup row's name followed by its review markers (duplicate, provenance): the markers always sit
// right after the name, together, and never wrap apart onto a line of their own under a long name
// (consistency audit 2026-10-12, C9). The name itself may still wrap.
export default function NameWithMarkers({ children, markers }) {
  return (
    <>
      {children}
      {markers && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 6, whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{markers}</span>}
    </>
  )
}
