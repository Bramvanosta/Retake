/**
 * The UI gallery's sample state and its first parts (GalleryScreen.tsx lays out the columns): buttons, fields, status
 * and app marks, time and progress, toolbars, the status bar, a source list, inspector sections, cards and a listbox of
 * productions; and what every part shares (a section, a sample frame).
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Appearance } from '../tokens.js';
import { POSTER_DATA_MAX } from '../thumbs.js';
import { Picture } from '../Thumb.js';
import {
  AppMark,
  Blocker,
  Button,
  FieldRow,
  FrameCard,
  IconButton,
  SearchTrigger,
  InspectorSection,
  Kbd,
  LinkButton,
  MARK_STATES,
  Menu,
  PosterCard,
  PosterGrid,
  Progress,
  Segmented,
  SegmentedLinks,
  Select,
  SourceList,
  StatusBar,
  StatusMark,
  Switch,
  TextArea,
  TextField,
  Timecode,
  Toolbar,
} from '../ui-kit/index.js';
import type { ButtonVariant, MarkState } from '../ui-kit/index.js';
import type { MarkVariant } from '../../mark.js';

/** A 32 × 18 grey picture (PNG): the cards' frame. */
const FRAME_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAASCAIAAAC1qksFAAABtklEQVR42q3TVW4cURSE4bMcx05MM2YaZmZmZmaP2U7MJK839dRq9b2PdwOfSr9UtLKp+bWlXVPp/+wYN/bMWwdW1ZF958S5d+be13gOdb5jQ+DUFNJYIjpbzOBImFwpsztt9Wbt/rwzWHSHy95o1R+vB5PNUKoVyXRiuV6iMEiVRpnKJFebEfTVbd1vtWF917S5b9k+tKmPHbunLugHWu+R3n9iDJ6Zw1prVG+PG51J6BZPxubLOQIFV6jkiVR8sVog0YAeTrej2W48308Wh+nyOFud5utzwnauju1cHdu5OrazerF5TijD1VGGq6MMV0cZVi+3Lwi6Ir1URpFeKqNIL5WRpy80FqXWstK5JGzn6tjO1bGdq2M7q9d614QyXB1luDrKcHWUYfXG4JagK9JLZRTppTKK9FIZefpq96rev2kO7wjbuTq2c3Vs5+rYzurt8QOJOhTKsHp3+o9EHQq6PH1rdN+Z/O3NHknUobCd1QeLZxJ1KJRh9dHylUQdCro8fX/+NDx/GV+8kahDYTurT68+SNShUIbV5zdfJOpQ0OXpJ5fvs+vPxe03iToUtrP68v7nP8P2dLcYjGN9AAAAAElFTkSuQmCC';

/** The app mark's variants at the sizes they are seen at, each named in a visible caption (the marks are aria-hidden). */
const APP_MARKS: Array<[MarkVariant, number]> = [
  ['full', 128],
  ['full', 64],
  ['small', 32],
  ['tiny', 18],
  ['tiny', 16],
];
const WORDS: Record<MarkState, string> = { ok: 'Ready', running: 'Running', waiting: 'Waiting', idle: 'Idle', warn: 'Warning', attention: 'Blocked', fail: 'Failed', recording: 'Recording' };
const VARIANTS: Array<[ButtonVariant, string]> = [
  ['primary', 'Render'],
  ['secondary', 'Rehearse'],
  ['ghost', 'Duplicate'],
  ['destructive', 'Delete take'],
];

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gl-section">
      <h3 className="gl-title">{title}</h3>
      <div className="gl-row">{children}</div>
    </section>
  );
}

export function Frame() {
  return <Picture format="png" base64={FRAME_PNG} max={POSTER_DATA_MAX} width={248} height={140} alt="" />;
}

/** The gallery's sample state, one set per column (each control writes its own); `accent`: the colour field's first value. */
export function useGalleryState(accent: string) {
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
  const [colour, setColour] = useState(accent);
  const [dragged, setDragged] = useState<string | null>(null);
  // What the colour fields wrote (the kit's ColorField behaviours are tested on it: studio-e2e-kit).
  const [writes, setWrites] = useState<string[]>([]);
  const [dark, setDark] = useState('');
  return {
    seg,
    setSeg,
    on,
    setOn,
    off,
    setOff,
    title,
    setTitle,
    note,
    setNote,
    take,
    setTake,
    card,
    setCard,
    poster,
    setPoster,
    frame,
    setFrame,
    rowCard,
    setRowCard,
    stepRow,
    setStepRow,
    way,
    setWay,
    caption,
    setCaption,
    pressed,
    setPressed,
    sheet,
    setSheet,
    busy,
    setBusy,
    palette,
    setPalette,
    answer,
    setAnswer,
    fit,
    setFit,
    link,
    setLink,
    chip,
    setChip,
    seg2,
    setSeg2,
    at,
    setAt,
    speed,
    setSpeed,
    colour,
    setColour,
    dragged,
    setDragged,
    writes,
    setWrites,
    dark,
    setDark,
  };
}

export type GalleryState = ReturnType<typeof useGalleryState>;

/** Buttons, icon buttons, segmented controls, switches and fields. */
export function GalleryBasics({ name, s }: { name: string; s: GalleryState }) {
  const { seg, setSeg, on, setOn, off, setOff, title, setTitle, note, setNote, take, setTake, pressed, setPressed } = s;
  return (
    <>
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
      <Section title="Icon buttons, key caps and the search">
        <IconButton icon="inspector" label={`Inspector (${name})`} pressed={pressed} onClick={() => setPressed((p) => !p)} />
        <IconButton icon="undo" label="Undo" />
        <IconButton icon="redo" label="Redo" disabled />
        <IconButton icon="more" label="More" size="sm" />
        <Kbd keys={['⇧', '⌘', 'R']} />
        <SearchTrigger placeholder="Search scenarios, scenes, commands" kbd={['⌘', 'K']} onOpen={() => undefined} />
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
    </>
  );
}

/** Status and app marks, time and progress, a toolbar and the status bar. */
export function GalleryStatus({ appearance, name, s }: { appearance: Appearance; name: string; s: GalleryState }) {
  const { setAnswer, fit, setFit, link, setLink } = s;
  return (
    <>
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
          <Menu
            label={`More take tools (${name})`}
            icon="more"
            items={[
              { id: 'first', label: 'Make it the first' },
              { id: 'last', label: 'Make it the last' },
            ]}
            onSelect={(id) => setAnswer(id)}
          />
          <Segmented
            label={`Fit (${name})`}
            size="sm"
            value={fit}
            onChange={setFit}
            options={[
              { value: 'fit', label: 'Fit' },
              { value: 'fill', label: 'Fill' },
            ]}
          />
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
    </>
  );
}

/** A source list, inspector sections, cards and a listbox of productions. */
export function GalleryLists({ name, s }: { name: string; s: GalleryState }) {
  const { card, setCard, poster, setPoster, setAnswer } = s;
  return (
    <>
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
    </>
  );
}
