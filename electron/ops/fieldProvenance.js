// "Did a human set this field?" — one answer, two sources.
//
// docs/adr/2026-09-09-field-provenance-in-the-document.md.
//
// This question protects a director's hand edits from being overwritten by a
// later re-import (ADR 2026-08-08-s2a). It used to be answered from the
// `operations` table alone: read the field's latest op and look at its `source`.
//
// That stopped being sufficient when CRDT sync replaced the op-log transport. A
// field that arrived by document merge has NO op row on the receiving device, so
// the op-log answer is not merely unavailable — it is confidently wrong. The
// device reports "no human ever touched this" about a correction a director made
// on another device ten minutes ago.
//
// So the document is asked first (it now carries a per-field human marker), and
// the op-log is the fallback. The fallback is not legacy tolerance:
//
//   - a Host that has been running since before this change has years of
//     provenance in its op-log and a document seeded from it;
//   - a device whose document has not loaded yet (startup, or the flag paths in
//     liveDoc) must still answer correctly rather than defaulting to "import"
//     and silently unprotecting everything.
//
// The two agree by construction: `appendOp` passes the op's own `source` into
// the document on every local write, and `seedDocFromSqlite` carries existing
// op-log provenance in at seed time.
import { latestOp } from './operations.js'
import { isHumanEdited } from '../automerge/campDocument.js'
import { getDocIfLoaded } from '../sync/automerge/liveDoc.js'

/**
 * True when a human is the latest writer of this field.
 *
 * NULL DECODES TO HUMAN, deliberately — appendOp defaults `source = null`, and
 * ADR 2026-08-08-s2a §2 is explicit that an unlabelled write counts as a hand
 * edit. Only an explicit 'import' hands ownership to the importer. Reversing
 * this would quietly unprotect most edits, so it is asserted in
 * fieldProvenance.test.js rather than left to a reader's care.
 */
export function isHumanOwned(db, entity, entityId, field) {
  const doc = getDocIfLoaded(db)
  if (doc && isHumanEdited(doc, entity, entityId, field)) return true

  const latest = latestOp(db, entity, entityId, field)
  if (!latest) {
    // No op row AND no document marker. Under the op-log this meant "never
    // written here", which was safe to treat as not-human because every write
    // this device knew about had a row. It is no longer safe on its own — hence
    // the document check above — but as a final fallback "not human" remains the
    // right answer: it lets a re-import proceed, which is recoverable, rather
    // than freezing a field nobody can show was hand-edited.
    return false
  }
  return latest.source !== 'import'
}
