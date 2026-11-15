/**
 * The UI gallery (`#/ui`) — every component of the design system (ui-kit/) in its states, in both appearances side
 * by side (`data-appearance` scopes: the top layer of a sheet, a menu or the palette opened in a column inherits its
 * tokens), plus the shell's own panes filled (the inspector and the status bar's actions). Built from the kit only (a
 * lint); the accessibility checker tours it (studio-e2e-a11y.test.ts) and the kit's behaviours are tested on it
 * (studio-e2e-kit.test.ts). Its text fields are no one's work: `unsaved={null}`. A second toolbar holds a menu, a
 * segmented control and a URL field (the arrows stay theirs).
 */
import type { Appearance } from '../tokens.js';
import { SAMPLE_ACCENT, okHex, pickerValue } from '../words/theme-words.js';
import { ShellSlot } from '../shell/slots.js';
import { Button, ColorField, DataTable, DiffTable, FieldRow, InspectorSection, RegionOverlay } from '../ui-kit/index.js';
import { Frame, GalleryBasics, GalleryLists, GalleryStatus, Section, useGalleryState } from './gallery-controls.js';
import type { GalleryState } from './gallery-controls.js';
import { GalleryBoard, GalleryEdit, GalleryNotices, GalleryOverlays } from './gallery-panes.js';

/** The library's and the themes' parts: a data table and colour fields. */
function GalleryThemes({ appearance, s }: { appearance: Appearance; s: GalleryState }) {
  const { colour, setColour, dragged, setDragged, writes, setWrites, dark, setDark } = s;
  return (
    <Section title="Library and themes (a data table, a colour field)">
      <DataTable
        caption="Slots"
        columns={[
          { key: 'slot', label: 'Slot' },
          { key: 'type', label: 'Type' },
          { key: 'max', label: 'Max', numeric: true },
          { key: 'what', label: 'What it is' },
        ]}
        rows={[
          { key: 'title', cells: ['title', 'text', 60, 'The call to action.'] },
          { key: 'kicker', cells: ['kicker', 'text', 40, null] },
        ]}
      />
      <div className="gl-pane">
        <ColorField
          label="Accent"
          hint="kicker, rules, cursor ripple"
          value={colour}
          picker={pickerValue(dragged ?? colour)}
          {...(okHex(colour) ? { swatch: colour } : {})}
          {...(dragged !== null ? { draft: dragged } : {})}
          onDraft={setDragged}
          onCommit={(hex) => {
            setColour(hex);
            setDragged(null);
            setWrites((w) => [...w, `accent ${hex}`]);
          }}
          testId={`gl-colour-${appearance}`}
        />
        <ColorField
          label="Dark"
          hint="optional"
          value={dark}
          picker={pickerValue(dark)}
          unset={!okHex(dark)}
          removable
          onDraft={() => undefined}
          onCommit={(hex) => {
            setDark(hex);
            setWrites((w) => [...w, `dark ${hex}`]);
          }}
          onRemove={() => {
            setDark('');
            setWrites((w) => [...w, 'dark removed']);
          }}
          testId={`gl-dark-${appearance}`}
        />
        <span className="gl-answer" data-testid={`gl-colour-writes-${appearance}`}>
          {writes.length ? `Written: ${writes.join(' · ')}` : 'Nothing written'}
        </span>
      </div>
    </Section>
  );
}

/** The comments' parts: a region over a frame and a diff table. */
function GalleryComments() {
  return (
    <Section title="Comments (a diff table, a region over a frame)">
      <div className="gl-region">
        <Frame />
        <RegionOverlay region={{ x: 0.2, y: 0.25, w: 0.5, h: 0.45 }} label="Region 1" />
      </div>
      <DiffTable
        label="The proposed change, line by line"
        title="scenarios/quote.yaml · line 104"
        rows={[
          { kind: 'gap', sign: '…', word: '3 unchanged lines not shown', base: null, line: null, pieces: [], rtl: false },
          {
            kind: 'context',
            sign: '',
            word: 'unchanged',
            base: 103,
            line: 103,
            pieces: [
              { kind: 'space', count: 4 },
              { kind: 'text', text: 'component: studio/overlay-callout' },
            ],
            rtl: false,
          },
          {
            kind: 'del',
            sign: '−',
            word: 'removed',
            base: 104,
            line: null,
            pieces: [
              { kind: 'space', count: 4 },
              { kind: 'text', text: 'duration: 2.5' },
            ],
            rtl: false,
          },
          {
            kind: 'add',
            sign: '+',
            word: 'added',
            base: null,
            line: 104,
            pieces: [
              { kind: 'space', count: 4 },
              { kind: 'text', text: 'duration: 3.5' },
              { kind: 'char', code: 'U+200B' },
            ],
            rtl: false,
          },
          { kind: 'add', sign: '+', word: 'added', base: null, line: 105, pieces: [{ kind: 'text', text: '# עברית: a note' }], rtl: true },
        ]}
      />
    </Section>
  );
}

function Column({ appearance }: { appearance: Appearance }) {
  const name = appearance === 'dark' ? 'Dark' : 'Light';
  const s = useGalleryState(SAMPLE_ACCENT);
  return (
    <div className="k-scope gl-column" data-appearance={appearance} data-testid={`scope-${appearance}`}>
      <h2 className="gl-scope">{name}</h2>
      <GalleryBasics name={name} s={s} />
      <GalleryStatus appearance={appearance} name={name} s={s} />
      <GalleryLists name={name} s={s} />
      <GalleryBoard appearance={appearance} name={name} s={s} />
      <GalleryEdit appearance={appearance} s={s} />
      <GalleryThemes appearance={appearance} s={s} />
      <GalleryComments />
      <GalleryNotices name={name} />
      <GalleryOverlays appearance={appearance} name={name} s={s} />
    </div>
  );
}

export function GalleryScreen() {
  return (
    <div className="gl" data-testid="gallery">
      <header className="gl-head">
        <h1 className="gl-h1">UI gallery</h1>
        <p className="gl-lede">Every component of the Studio's design system, in the dark and the light appearance.</p>
      </header>
      <div className="gl-columns">
        <Column appearance="dark" />
        <Column appearance="light" />
      </div>
      <ShellSlot name="inspector">
        <InspectorSection title="Gallery">
          <FieldRow label="Components">
            <span>30</span>
          </FieldRow>
          <FieldRow label="Appearances">
            <span>dark and light</span>
          </FieldRow>
        </InspectorSection>
        <InspectorSection title="About the inspector" collapsible defaultOpen={false}>
          <span>Hidden with the focus inside, it hands the focus to the centre pane.</span>
        </InspectorSection>
      </ShellSlot>
      <ShellSlot name="actions">
        <Button size="sm" variant="ghost" onClick={() => document.getElementById('main')?.scrollTo({ top: 0, behavior: 'auto' })}>
          Back to top
        </Button>
      </ShellSlot>
    </div>
  );
}
