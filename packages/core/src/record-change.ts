/**
 * One change of a Studio recording's annotations (record-annotations.ts: the file and its format), applied against the
 * recording's events (recording.ts): a target choice must name an alternative the recorder offered, an insert a
 * position inside the recording. Pure; the engine applies it under the annotate lock.
 */
import { RECORD_ANNOTATIONS_MAX_BYTES, RECORD_CHOICES_MAX, RECORD_INSERTS_MAX, RecordAnnotationsSchema } from './record-annotations.js';
import type { RecordAnnotationChange, RecordAnnotations, RecordInsert } from './record-annotations.js';
import { recordedAlternatives } from './recording.js';
import type { RecordedEvent } from './recording.js';

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

export type RecordChangeError = { code: 'not_found' | 'invalid' | 'too_many' | 'taken'; message: string };

/**
 * Apply one change to annotations against the recording's events (read by the caller under the annotate lock): the
 * result has `rev + 1`. Pure. A choice must name an event whose element has that alternative (an offered one: not
 * masked, not templated); an insert "at the end" goes after the newest event; a mark without a name gets the first free
 * `m<n>`. Errors are fixed messages (no page or typed text).
 */
export function applyRecordChange(
  a: RecordAnnotations,
  change: RecordAnnotationChange,
  events: readonly RecordedEvent[],
): { annotations: RecordAnnotations; id?: string } | { error: RecordChangeError } {
  const rev = a.rev + 1;
  let lastSeq = -1;
  for (const e of events) if (e.seq > lastSeq) lastSeq = e.seq;
  let out: RecordAnnotations;
  let id: string | undefined;
  if (change.op === 'choose') {
    const ev = events.find((e) => e.seq === change.seq);
    const el = ev && 'el' in ev ? ev.el : null;
    if (!el) return { error: { code: 'not_found', message: 'no recorded action with targets at that position' } };
    if (change.index > 0 && !recordedAlternatives(el).some((x) => x.index === change.index)) {
      return { error: { code: 'invalid', message: 'that alternative target does not exist for this action' } };
    }
    const choices = { ...a.choices, [String(change.seq)]: change.index };
    if (Object.keys(choices).length > RECORD_CHOICES_MAX) return { error: { code: 'too_many', message: `at most ${RECORD_CHOICES_MAX} target choices` } };
    out = { ...a, rev, choices };
  } else if (change.op === 'insert') {
    if (a.inserts.length >= RECORD_INSERTS_MAX) return { error: { code: 'too_many', message: `at most ${RECORD_INSERTS_MAX} inserts` } };
    const at = change.at;
    let anchor: Pick<RecordInsert, 'after_seq' | 'row' | 'after_insert'>;
    if (at === 'end') anchor = { after_seq: lastSeq };
    else if ('after_insert' in at) {
      const ref = a.inserts.find((x) => x.id === at.after_insert);
      if (!ref) return { error: { code: 'not_found', message: 'no such insert' } };
      anchor = { after_seq: ref.after_seq, ...(ref.row ? { row: ref.row } : {}), after_insert: ref.id };
    } else anchor = { after_seq: at.after_step_seq, ...(at.row ? { row: at.row } : {}) };
    const after = anchor.after_seq;
    if (after > lastSeq) return { error: { code: 'invalid', message: 'that position is past the end of the recording' } };
    id = `i${rev}`;
    const v = change.insert;
    let insert: RecordInsert;
    if (v.kind === 'mark') {
      const used = new Set(a.inserts.flatMap((x) => (x.kind === 'mark' ? [x.name] : [])));
      let name = v.name;
      if (name === undefined) {
        let n = 1;
        while (used.has(`m${n}`)) n++;
        name = `m${n}`;
      } else if (used.has(name)) return { error: { code: 'taken', message: 'that mark name is already used in this recording' } };
      insert = { id, ...anchor, kind: 'mark', name };
    } else insert = { id, ...anchor, ...v } as RecordInsert;
    out = { ...a, rev, inserts: [...a.inserts, insert] };
  } else {
    if (!a.inserts.some((x) => x.id === change.id)) return { error: { code: 'not_found', message: 'no such insert' } };
    out = { ...a, rev, inserts: a.inserts.filter((x) => x.id !== change.id) };
  }
  const checked = RecordAnnotationsSchema.safeParse(out);
  if (!checked.success) return { error: { code: 'invalid', message: 'the change does not fit the annotations format' } };
  if (utf8Bytes(JSON.stringify(checked.data)) > RECORD_ANNOTATIONS_MAX_BYTES) {
    return { error: { code: 'too_many', message: `the annotations would pass ${RECORD_ANNOTATIONS_MAX_BYTES / 1024} KiB` } };
  }
  return { annotations: checked.data, ...(id !== undefined ? { id } : {}) };
}
