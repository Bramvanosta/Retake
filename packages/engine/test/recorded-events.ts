/**
 * Recorded events for the in-memory capture runner's recording window (src/capture/memory-sessions.ts memoryRecord):
 * what the recorder writes when a person opens a page and presses one button on it — the window's first page, one
 * verified press, the end. The engine-logic cases of the recordings (record.test.ts, record-jobs.test.ts) draft their
 * scenario from these; the real recorder's events are the runner package's own tests'.
 */
import type { RecordedEvent } from '@retake/core';

/** The window opens on environment page `pageKey` at `path`, the person presses the button `button`, the window closes. */
export function oneButtonPress(o: { pageKey: string; path?: string; button: string }): RecordedEvent[] {
  const path = o.path ?? '/';
  return [
    { seq: 0, t: 0, page: 'p1', path, kind: 'navigation', cause: 'start', same_document: false, where: 'environment', page_key: o.pageKey },
    {
      seq: 1,
      t: 1200,
      page: 'p1',
      path,
      kind: 'pointer',
      button: 'left',
      via: 'pointer',
      quiet_ms: 900,
      ms: 3,
      el: {
        target: { role: 'button', name: o.button },
        matches: 1,
        fragile: [],
        in: 'page',
        action: { kind: 'click', verified: true },
        role: 'button',
        tag: 'button',
        input_type: null,
        name: o.button,
        text: o.button,
        label: null,
        placeholder: null,
        testid: null,
        href_path: null,
        in_view: true,
        state: { disabled: false, expanded: false, checked: false, selected: false, popup_expected: false, covered: false },
        appeared: false,
        secret: false,
      },
    },
    { seq: 2, t: 2000, page: 'p1', path, kind: 'stop', reason: 'closed' },
  ];
}
