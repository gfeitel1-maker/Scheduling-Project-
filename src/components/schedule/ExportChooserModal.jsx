import { S } from '../../styles/shared'

// A camp can hold two schedules and NEITHER is the real one — that decision
// belongs to the director, not to us. Export is the one place the app must act
// on exactly one, so it asks, every time, and does not remember the answer: a
// remembered choice would be the app quietly electing a winner
// (CONSTITUTION.md Art. V).
//
// The counts are the whole point of the screen — they let a director tell two
// ideas apart without opening both.
export default function ExportChooserModal({ options, onChoose, onCancel }) {
  return (
    <div style={S.overlay}>
      <div style={{ ...S.modalLg, maxWidth: 460 }}>
        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, marginBottom: 6 }}>Which schedule do you want to export?</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 18 }}>
          You have more than one week in progress. Pick the one to send to Excel.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
          {options.map(opt => (
            <button
              key={opt.key}
              onClick={() => onChoose(opt.key)}
              disabled={opt.filled === 0 && opt.total === 0}
              style={{
                textAlign: 'left',
                padding: '14px 16px',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                cursor: opt.total === 0 ? 'not-allowed' : 'pointer',
                opacity: opt.total === 0 ? 0.45 : 1,
                fontFamily: 'inherit',
              }}
            >
              <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{opt.title}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', marginTop: 3 }}>
                {opt.total === 0 ? 'not started' : `${opt.filled} of ${opt.total} placed`}
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnSecondary}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
