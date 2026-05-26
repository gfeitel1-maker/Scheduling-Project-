// src/styles/shared.js
export const S = {
  btnPrimary: { padding: '7px 14px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' },
  btnSecondary: { padding: '7px 14px', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' },
  btnDanger: { padding: '7px 14px', background: 'var(--surface)', color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'var(--font-sans)' },
  th: { padding: '8px 14px', textAlign: 'left', fontSize: 11, fontFamily: 'var(--font-condensed)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-secondary)', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', fontSize: 13, verticalAlign: 'middle', color: 'var(--text)', fontFamily: 'var(--font-sans)' },
  input: { padding: '8px 10px', border: '1.5px solid var(--border)', borderRadius: 7, fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none', background: 'var(--surface)', color: 'var(--text)', width: '100%' },
  label: { fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 5, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' },
  modalSm: { background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, maxWidth: 400, width: '100%', border: '1px solid var(--border)' },
  modalLg: { background: 'var(--surface-elevated)', borderRadius: 12, padding: 28, width: 480, maxWidth: '100%', border: '1px solid var(--border)' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  errorBanner: { background: '#fff5f5', border: '1px solid #f5c6c6', borderRadius: 7, padding: '10px 14px', fontSize: 13, color: '#c0392b', marginBottom: 16 },
}
