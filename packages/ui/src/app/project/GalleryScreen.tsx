/**
 * L5.9: the UI gallery (`#/ui`) — every component of the design system (ui-kit/) in its states, in both appearances side
 * by side (`data-appearance` scopes: the top layer of a sheet, a menu or the palette opened in a column inherits its
 * tokens), plus the shell's own panes filled (the inspector and the status bar's actions). Built from the kit only (a
 * lint); the accessibility checker tours it (studio-e2e-a11y.test.ts) and the kit's behaviours are tested on it
 * (studio-e2e-kit.test.ts). Its text fields are no one's work: `unsaved={null}`. A second toolbar holds a menu, a
 * segmented control and a URL field (review A-M2: the arrows stay theirs).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Appearance } from '../tokens.js';
import { POSTER_DATA_MAX } from '../thumbs.js';
import { Picture } from '../Thumb.js';
import { SAMPLE_ACCENT, okHex, pickerValue } from '../words/theme-words.js';
import { ShellSlot } from '../shell/slots.js';
import {
  AppMark,
  Blocker,
  Button,
  Checklist,
  ChecklistItem,
  CommandPalette,
  Disclosure,
  EmptyState,
  Facts,
  FieldRow,
  ChoiceChips,
  ColorField,
  ContactSheet,
  DataTable,
  DiffTable,
  RegionOverlay,
  FrameCard,
  IconButton,
  InspectorSection,
  Kbd,
  LinkButton,
  MARK_STATES,
  Menu,
  PosterCard,
  PosterGrid,
  Callout,
  FrameGrid,
  NumberField,
  Playhead,
  Scrubber,
  Tag,
  Track,
  TrackItem,
  FrameOption,
  RadioGroup,
  RowCard,
  Progress,
  Segmented,
  SegmentedLinks,
  Select,
  Sheet,
  SourceList,
  StatusBar,
  StatusMark,
  Switch,
  TextArea,
  TextField,
  Timecode,
  Toolbar,
} from '../ui-kit/index.js';
import type { ButtonVariant, Command, MarkState } from '../ui-kit/index.js';
import type { MarkVariant } from '../../mark.js';

/** A 32 × 18 grey picture (PNG): the cards' frame. */
const FRAME_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAABtklEQVR42q3TVW4cURSE4bMcx05MM2YaZmZmZmaP2U7MJK839dRq9b2PdwOfSr9UtLKp+bWlXVPp/+wYN/bMWwdW1ZF958S5d+be13gOdb5jQ+DUFNJYIjpbzOBImFwpsztt9Wbt/rwzWHSHy95o1R+vB5PNUKoVyXRiuV6iMEiVRpnKJFebEfTVbd1vtWF917S5b9k+tKmPHbunLugHWu+R3n9iDJ6Zw1prVG+PG51J6BZPxubLOQIFV6jkiVR8sVog0YAeTrej2W48308Wh+nyOFud5utzwnauju1cHdu5OrazerF5TijD1VGGq6MMV0cZVi+3Lwi6Ir1URpFeKqNIL5WRpy80FqXWstK5JGzn6tjO1bGdq2M7q9d614QyXB1luDrKcHWUYfXG4JagK9JLZRTppTKK9FIZefpq96rev2kO7wjbuTq2c3Vs5+rYzurt8QOJOhTKsHp3+o9EHQq6PH1rdN+Z/O3NHknUobCd1QeLZxJ1KJRh9dHylUQdCro8fX/+NDx/GV+8kahDYTurT68+SNShUIbV5zdfJOpQ0OXpJ5fvs+vPxe03iToUtrP68v7nP8P2dLcYjGN9AAAAAElFTkSuQmCC';

/** The app mark's variants at the sizes they are seen at (L5.13b), each named in a visible caption (the marks are aria-hidden). */
const APP_MARKS: Array<[MarkVariant, number]> = [['full', 128], ['full', 64], ['small', 32], ['tiny', 18], ['tiny', 16]];
const WORDS: Record<MarkState, string> = { ok: 'Ready', running: 'Running', waiting: 'Waiting', idle: 'Idle', warn: 'Warning', attention: 'Blocked', fail: 'Failed', recording: 'Recording' };
const VARIANTS: Array<[ButtonVariant, string]> = [
  ['primary', 'Render'],
  ['secondary', 'Rehearse'],
  ['ghost', 'Duplicate'],
  ['destructive', 'Delete take'],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gl-section">
      <h3 className="gl-title">{title}</h3>
      <div className="gl-row">{children}</div>
    </section>
  );
}

function Frame() {
  return <Picture format="png" base64={FRAME_PNG} max={POSTER_DATA_MAX} width={248} height={140} alt="" />;
}

function Column({ appearance }: { appearance: Appearance }) {
  const name = appearance === 'dark' ? 'Dark' : 'Light';
  const [seg, setSeg] = useState<'blocks' | 'yaml' | 'both'>('blocks');
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [title, setTitle] = useState('Checkout in three steps');
  const [note, setNote] = useState('');
  const [take, setTake] = useState('2');
  const [card, setCard] = useState(1);
  const [poster, setPoster] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [rowCard, setRowCard] = useState(false);
  const [stepRow, setStepRow] = useState(true);
  const [way, setWay] = useState('0');
  const [caption, setCaption] = useState(true);
  const [pressed, setPressed] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  const [answer, setAnswer] = useState('none yet');
  const [fit, setFit] = useState<'fit' | 'fill'>('fit');
  const [link, setLink] = useState('https://example.com/a');
  const [chip, setChip] = useState('card');
  const [seg2, setSeg2] = useState<string | null>('a');
  const [at, setAt] = useState(40);
  const [speed, setSpeed] = useState('1.5');
  const [colour, setColour] = useState(SAMPLE_ACCENT);
  const [dragged, setDragged] = useState<string | null>(null);
  // L5.12c fixes: what the colour fields wrote (the kit's ColorField behaviours are tested on it: studio-e2e-kit).
  const [writes, setWrites] = useState<string[]>([]);
  const [dark, setDark] = useState('');
  const commands: Command[] = [
    { id: 'projects', label: 'Projects', group: 'Go to', icon: 'folder', run: () => (location.hash = '#/') },
    { id: 'gallery', label: 'UI gallery', group: 'Go to', hint: 'this page', icon: 'components', run: () => setAnswer('UI gallery') },
    { id: 'hello', label: 'Say hello', group: 'Commands', hint: 'writes the last answer', run: () => setAnswer('hello') },
    { id: 'inspector', label: 'Toggle the sample inspector', group: 'Commands', kbd: ['⌥', '⌘', 'I'], run: () => setAnswer('inspector') },
  ];
  return (
    <div className="k-scope gl-column" data-appearance={appearance} data-testid={`scope-${appearance}`}>
      <h2 className="gl-scope">{name}</h2>
      <Section title="Buttons">
        {VARIANTS.map(([v, label]) => (
          <Button key={v} variant={v}>
            {label}
          </Button>
        ))}
        <Button variant="record">Capture</Button>
        <Button variant="record" recording>
          Stop recording
        </Button>
        <Button size="sm">Small</Button>
        <Button size="lg" variant="primary">
          Large
        </Button>
        <Button icon="plus">Add a scene</Button>
        <Button kbd={['⌘', 'K']} variant="ghost">
          Commands
        </Button>
        <Button busy>Saving…</Button>
        <Button disabled why="Open a scenario first">
          Render
        </Button>
        <LinkButton to={{ name: 'projects' }}>All projects</LinkButton>
      </Section>
      <Section title="Icon buttons and key caps">
        <IconButton icon="inspector" label={`Inspector (${name})`} pressed={pressed} onClick={() => setPressed((p) => !p)} />
        <IconButton icon="undo" label="Undo" />
        <IconButton icon="redo" label="Redo" disabled />
        <IconButton icon="more" label="More" size="sm" />
        <Kbd keys={['⇧', '⌘', 'R']} />
      </Section>
      <Section title="Segmented controls">
        <Segmented
          label={`View (${name})`}
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'blocks', label: 'Blocks' },
            { value: 'yaml', label: 'YAML' },
            { value: 'both', label: 'Both', disabled: true },
          ]}
        />
        <SegmentedLinks
          label={`Sample places (${name})`}
          items={[
            { key: 'g', label: 'Gallery', to: { name: 'ui' }, current: true },
            { key: 'p', label: 'Projects', to: { name: 'projects' }, current: false },
          ]}
        />
        <SegmentedLinks
          label={`Sample modes (${name})`}
          hint="Open a scenario to choose a mode"
          items={[
            { key: 's', label: 'Script', to: null, current: false },
            { key: 'e', label: 'Edit', to: null, current: false },
          ]}
        />
      </Section>
      <Section title="Switches">
        <Switch label="Captions" hint="Burned into the video" checked={on} onChange={setOn} />
        <Switch label="Cursor trail" checked={off} onChange={setOff} />
        <Switch label="Sound" checked={false} onChange={() => undefined} disabled />
      </Section>
      <Section title="Fields">
        <TextField label="Title" value={title} onChange={setTitle} unsaved={null} />
        <TextField label="Note" value={note} onChange={setNote} unsaved={null} placeholder="A word for the team" hint="Shown under the step" />
        <TextField label="Target" value="#checkout" onChange={() => undefined} unsaved={null} mono error="No element matches this selector" />
        <TextField label="Run id" value="20260101-120000-bits" onChange={() => undefined} unsaved={null} mono readOnly layout="row" />
        <Select
          label="Take"
          value={take}
          onChange={setTake}
          layout="row"
          options={[
            { value: '1', label: 'Take 1' },
            { value: '2', label: 'Take 2' },
          ]}
        />
        <FieldRow label="Zoom">
          <Segmented
            label={`Zoom (${name})`}
            size="sm"
            value="1"
            onChange={() => undefined}
            options={[
              { value: '1', label: '1×' },
              { value: '2', label: '1.4×' },
            ]}
          />
        </FieldRow>
        <TextArea label="Caption" value="Every frame carries its number." onChange={() => undefined} unsaved={null} rows={2} />
      </Section>
      <Section title="Status marks">
        {MARK_STATES.map((s) => (
          <StatusMark key={s} state={s} word={WORDS[s]} />
        ))}
      </Section>
      <Section title="App mark">
        {APP_MARKS.map(([variant, size]) => (
          <AppMark key={`${variant}-${size}`} variant={variant} size={size} />
        ))}
        <span className="gl-lede">{APP_MARKS.map(([variant, size]) => `${variant} ${size} px`).join(' · ')}</span>
      </Section>
      <Section title="Time and progress">
        <Timecode seconds={49} total={72} frame={1470} />
        <Progress label="Rendering" value={64} valueText="64 %" />
        <Progress label="Preparing the browser" />
      </Section>
      <Section title="Toolbar">
        <Toolbar label={`Step tools (${name})`}>
          <IconButton icon="plus" label="Add a step" />
          <IconButton icon="copy" label="Duplicate the step" />
          <IconButton icon="close" label="Remove the step" />
          <Button size="sm">Open timeline</Button>
        </Toolbar>
        <Toolbar label={`Take tools (${name})`}>
          <IconButton icon="plus" label="Add a take" />
          <Menu label={`More take tools (${name})`} icon="more" items={[{ id: 'first', label: 'Make it the first' }, { id: 'last', label: 'Make it the last' }]} onSelect={(id) => setAnswer(id)} />
          <Segmented label={`Fit (${name})`} size="sm" value={fit} onChange={setFit} options={[{ value: 'fit', label: 'Fit' }, { value: 'fill', label: 'Fill' }]} />
          <TextField label="Link" type="url" value={link} onChange={setLink} unsaved={null} layout="row" />
          <IconButton icon="close" label="Remove the take" />
        </Toolbar>
      </Section>
      <Section title="Status bar">
        <StatusBar
          label={`Sample status (${name})`}
          state={<StatusMark state="ok" word="Connected" />}
          info="worker idle"
          actions={
            <>
              <Button size="sm" variant="ghost">
                Rehearse
              </Button>
              <Button size="sm" variant="record">
                Capture
              </Button>
            </>
          }
        />
        <StatusBar
          label={`Sample status with a blocker (${name})`}
          state={<StatusMark state="ok" word="Connected" />}
          info="Idle"
          actions={
            <>
              <Blocker compact word="Capture blocked: 1 hook" fix={{ copy: 'retake run northfield-fixture quote' }} testId={`gallery-compact-${appearance}`} />
              <Button size="sm" kbd={['⌘', 'R']}>
                Rehearse
              </Button>
            </>
          }
        />
      </Section>
      <Section title="Source list">
        <SourceList
          label={`Sample browser (${name})`}
          groups={[
            {
              key: 'lib',
              heading: 'Library',
              items: [
                { key: 'ui', to: { name: 'ui' }, label: 'Components', icon: 'components', current: true, count: 24 },
                { key: 'p', to: { name: 'projects' }, label: 'Themes', icon: 'theme', current: false, flag: 'unsaved' },
              ],
            },
            {
              key: 'loc',
              heading: 'Locations',
              items: [
                { key: 'l1', to: { name: 'projects' }, label: 'local', icon: 'location', current: false, flag: 'default' },
                { key: 'l2', to: { name: 'projects' }, label: 'Scene 1', lead: '1', value: '0:09.4', current: false, quiet: true },
              ],
            },
          ]}
        />
      </Section>
      <Section title="Inspector sections">
        <div className="gl-pane">
          <InspectorSection title="Step">
            <FieldRow label="Action">
              <span>click</span>
            </FieldRow>
          </InspectorSection>
          <InspectorSection title="Advanced" collapsible defaultOpen={false}>
            <span>Retries and timeouts</span>
          </InspectorSection>
        </div>
      </Section>
      <Section title="Cards">
        <div className="gl-cards">
          {[1, 2].map((n) => (
            <FrameCard key={n} picture={<Frame />} number={n} title={n === 1 ? 'Open the catalogue' : 'Pick a size'} meta={`${n + 2} steps`} selected={card === n} onSelect={() => setCard(n)} />
          ))}
          <PosterCard picture={<Frame />} title="Quote" meta="4 scenes · 1 min 12 s" to={{ name: 'projects' }} />
        </div>
      </Section>
      <Section title="Productions (a listbox)">
        <div className="gl-pane">
          <PosterGrid
            label={`Sample productions (${name})`}
            selected={poster}
            onSelect={setPoster}
            onOpen={(id) => setAnswer(`open ${id}`)}
            items={[
              { id: 'quote', picture: <Frame />, title: 'Request a quote', meta: <StatusMark state="ok" word="Rendered · clean" /> },
              { id: 'catalogue', picture: <Frame />, title: 'Manage the catalogue', meta: <StatusMark state="warn" word="Render outdated" /> },
              { id: 'signup', picture: <Frame />, title: 'Sign up', meta: <StatusMark state="idle" word="Draft · not shot yet" /> },
              { id: 'reports', picture: <Frame />, title: 'Reports', meta: <StatusMark state="fail" word="Failed at step 3 of export" /> },
            ]}
          />
        </div>
      </Section>
      <Section title="Storyboard (frames, a row card, a callout, a switch row)">
        <div className="gl-pane">
          <FrameGrid
            label={`Sample frames (${name})`}
            tabbable
            activeId={`gl-frame-${appearance}-${frame}`}
            onKeyDown={(e) => {
              const to = e.key === 'ArrowRight' ? Math.min(2, frame + 1) : e.key === 'ArrowLeft' ? Math.max(0, frame - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1;
              if (to < 0) return;
              e.preventDefault();
              setFrame(to);
            }}
          >
            {['Hover “Finca Lirandel”', 'Scroll to “Fresh arrivals”', 'Click “Selowa Ridge”'].map((t, i) => (
              <FrameOption
                key={t}
                id={`gl-frame-${appearance}-${i}`}
                dataKey={`discover.${i}`}
                label={`Step ${i + 1}: ${t}. done`}
                selected={frame === i}
                picture={<Frame />}
                number={String(i + 1)}
                title={t}
                meta={<StatusMark state="ok" word="done 0.7 s" />}
                draggable={false}
                drop={null}
                dragging={false}
                onPick={() => setFrame(i)}
              />
            ))}
          </FrameGrid>
        </div>
        <RowCard tile="Card" title="Step two — Ask the roaster for a quote" meta="Card · the theme's card · 2.5 s" selected={rowCard} onSelect={() => setRowCard((v) => !v)} />
        <Callout state="warn" title="Note: what the browser does changed since this run">
          A render of this run shows the take as it was captured.
        </Callout>
        <div className="gl-pane">
          <Switch layout="row" label="Caption" hint={caption ? 'On this step' : 'No caption on this step'} checked={caption} onChange={setCaption} />
        </div>
      </Section>
      <Section title="Record (compact rows, a radio group)">
        <div className="gl-pane">
          <RowCard compact tile="2" title="Scroll to “Fresh arrivals”" meta="Recorded scroll" selected={false} onSelect={() => setStepRow(false)} />
          <RowCard compact tile="3" title="Click “Selowa Ridge”" meta="Suggested: text" aside="2 alternatives" selected={stepRow} onSelect={() => setStepRow((v) => !v)} />
        </div>
        <RadioGroup
          legend={`Ways to find “Selowa Ridge” (${name})`}
          value={way}
          onChange={setWay}
          options={[
            { value: '0', label: 'Text “Selowa Ridge”', aside: 'Suggested' },
            { value: '1', label: 'Role: link “Selowa Ridge”' },
            { value: '2', label: 'CSS .lot-card:nth-child(3)', detail: 'depends on the page’s code (a CSS selector)', disabled: true },
          ]}
        />
      </Section>
      <Section title="Edit (choice chips, tracks, a scrubber, a number field, a tag)">
        <div className="gl-pane">
          <span id={`gl-chips-${appearance}`}>Layout</span>
          <ChoiceChips
            labelledBy={`gl-chips-${appearance}`}
            chips={[
              { key: 'default', label: 'Theme default', value: '', checked: chip === 'default' },
              { key: 'card', label: 'Card', value: 'card', checked: chip === 'card' },
              { key: 'laptop', label: 'Laptop', value: 'laptop', checked: chip === 'laptop' },
              { key: 'split', label: 'Split screen', value: 'split', checked: false, disabled: true, why: 'no scene of this video films more than one page' },
            ]}
            onPick={setChip}
          />
        </div>
        <div className="gl-pane gl-tracks">
          <Scrubber time="0:04" max={99} value={at} valueText={`frame ${at}`} onChange={setAt} marks={[{ at: 0, label: '0:00' }, { at: 0.5, label: '0:05' }]} />
          <Track name="Segments" testId={`gl-track-${appearance}`} count={2}>
            <TrackItem variant="segment" place={{ from: 0, to: 45 }} frames={100} label="Scene request, 0:00 to 0:04" pressed={seg2 === 'a'} band={0.1} testId="gl-seg" onActivate={() => setSeg2('a')}>
              request
            </TrackItem>
            <TrackItem variant="segment" place={{ from: 45, to: 100 }} frames={100} label="Scene proposal, 0:04 to 0:10" pressed={seg2 === 'b'} testId="gl-seg" onActivate={() => setSeg2('b')}>
              proposal
            </TrackItem>
          </Track>
          <Track name="Markers" testId={`gl-markers-${appearance}`} count={1}>
            <TrackItem variant="pin" place={{ at: 60 }} frames={100} label="Comment, open, at 0:06" states={['open']} testId="gl-pin" onActivate={() => setAt(60)} tip="open · 0:06 · the zoom starts too early">
              ●
            </TrackItem>
          </Track>
          <Playhead at={at / 100} />
        </div>
        <NumberField label="Other speed" value={speed} onChange={setSpeed} step={0.05} min={0} max={4} />
        <Tag>today's edit</Tag>
      </Section>
      <Section title="Review (a contact sheet)">
        <ContactSheet
          items={[
            { key: 'a', name: 'contact sheet (1 fps)', label: 'contact sheet (1 fps)', meta: '0:00 – 0:10', picture: <Frame />, state: 'ok' },
            { key: 'b', name: 'scene request', label: 'scene request', picture: null, words: 'Loading the contact sheet…', state: 'waiting' },
          ]}
        />
      </Section>
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
            { kind: 'context', sign: '', word: 'unchanged', base: 103, line: 103, pieces: [{ kind: 'space', count: 4 }, { kind: 'text', text: 'component: studio/overlay-callout' }], rtl: false },
            { kind: 'del', sign: '−', word: 'removed', base: 104, line: null, pieces: [{ kind: 'space', count: 4 }, { kind: 'text', text: 'duration: 2.5' }], rtl: false },
            { kind: 'add', sign: '+', word: 'added', base: null, line: 104, pieces: [{ kind: 'space', count: 4 }, { kind: 'text', text: 'duration: 3.5' }, { kind: 'char', code: 'U+200B' }], rtl: false },
            { kind: 'add', sign: '+', word: 'added', base: null, line: 105, pieces: [{ kind: 'text', text: '# עברית: a note' }], rtl: true },
          ]}
        />
      </Section>
      <Section title="Facts and disclosure">
        <div className="gl-pane">
          <Facts
            rows={[
              { key: 'len', label: 'Length', value: '1:00.0' },
              { key: 'content', label: 'Content', value: '4 scenes · 2 cards · 25 steps' },
              { key: 'take', label: 'Last take', value: <StatusMark state="ok" word="Capture succeeded" /> },
            ]}
          />
          <Disclosure summary="2 warnings in project.yaml">
            <span>environments.staging: no display URL</span>
          </Disclosure>
        </div>
      </Section>
      <Section title="Blocker">
        <Blocker word="Blocked" fix={{ copy: 'pnpm fixture' }}>
          The setup hook needs the fixture running.
        </Blocker>
        <Blocker compact word="Blocked: the file has errors" fix={{ label: 'Open the YAML', to: { name: 'ui' } }} />
      </Section>
      <Section title="Checklist">
        <Checklist label={`Checks before a take (${name})`}>
          <ChecklistItem state="ok" word="Ready" title="Location">
            The shop and the console on this Mac.
          </ChecklistItem>
          <ChecklistItem state="attention" word="Pending: a capture asks first" title="Sessions" actions={<Button size="sm">Sign in…</Button>}>
            buyer · shop — expired.
          </ChecklistItem>
          <ChecklistItem state="idle" word="Off" title="Live picture during a capture">
            Off by default.
          </ChecklistItem>
        </Checklist>
      </Section>
      <Section title="Empty state">
        <EmptyState title="No scenario yet" level={3} actions={<Button variant="primary">New scenario</Button>}>
          Write the steps of a demo; the Studio films them.
        </EmptyState>
      </Section>
      <Section title="Menu, sheet, palette">
        <Menu
          label={`Take actions (${name})`}
          text="Take"
          items={[{ id: 'dup', label: 'Duplicate', kbd: ['⌘', 'D'] }, { id: 'rename', label: 'Rename…' }, { id: 'export', label: 'Export', disabled: true }, 'separator', { id: 'delete', label: 'Delete take', danger: true }]}
          onSelect={(id) => setAnswer(id)}
        />
        <Button onClick={() => setSheet(true)}>Discard the take…</Button>
        <Button onClick={() => setBusy(true)}>Render the take…</Button>
        <Button onClick={() => setPalette(true)} kbd={['⌘', 'K']}>
          Open the palette
        </Button>
        <span className="gl-answer" data-testid={`answer-${appearance}`}>
          Last answer: {answer}
        </span>
        <Sheet
          open={sheet}
          destructive
          title="Discard the take?"
          actions={[
            { id: 'cancel', label: 'Cancel', isCancel: true },
            { id: 'discard', label: 'Discard', variant: 'destructive', isDefault: true },
          ]}
          onAction={(id) => {
            setSheet(false);
            setAnswer(id);
          }}
        >
          Its frames and its timeline go; the scenario stays.
        </Sheet>
        <Sheet
          open={busy}
          title="Rendering the take"
          actions={[
            { id: 'wait', label: 'Keep waiting', isCancel: true, isDefault: true },
            { id: 'stop', label: 'Stop rendering', variant: 'destructive' },
          ]}
          onAction={(id) => {
            setAnswer(id);
            if (id === 'stop') setBusy(false);
          }}
        >
          The render goes on while this stays open; Escape keeps waiting.
        </Sheet>
        <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
      </Section>
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
