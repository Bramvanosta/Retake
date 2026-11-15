/**
 * The UI gallery's parts for the screens (GalleryScreen.tsx lays out the columns): the storyboard's and the recorder's,
 * the editor's and the review's, the notices (facts, blockers, a checklist, an empty state) and the overlays (a menu,
 * sheets, the command palette).
 */
import type { Appearance } from '../tokens.js';
import {
  Blocker,
  Button,
  Callout,
  Checklist,
  ChecklistItem,
  ChoiceChips,
  CommandPalette,
  ContactSheet,
  Disclosure,
  EmptyState,
  Facts,
  FrameGrid,
  FrameOption,
  Menu,
  NumberField,
  Playhead,
  RadioGroup,
  RowCard,
  Scrubber,
  Sheet,
  StatusMark,
  Switch,
  Tag,
  Track,
  TrackItem,
} from '../ui-kit/index.js';
import type { Command } from '../ui-kit/index.js';
import { Frame, Section } from './gallery-controls.js';
import type { GalleryState } from './gallery-controls.js';

/** The storyboard's and the recorder's parts. */
export function GalleryBoard({ appearance, name, s }: { appearance: Appearance; name: string; s: GalleryState }) {
  const { frame, setFrame, rowCard, setRowCard, stepRow, setStepRow, way, setWay, caption, setCaption } = s;
  return (
    <>
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
    </>
  );
}

/** The editor's and the review's parts. */
export function GalleryEdit({ appearance, s }: { appearance: Appearance; s: GalleryState }) {
  const { chip, setChip, seg2, setSeg2, at, setAt, speed, setSpeed } = s;
  return (
    <>
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
          <Scrubber
            time="0:04"
            max={99}
            value={at}
            valueText={`frame ${at}`}
            onChange={setAt}
            marks={[
              { at: 0, label: '0:00' },
              { at: 0.5, label: '0:05' },
            ]}
          />
          <Track name="Segments" testId={`gl-track-${appearance}`} count={2}>
            <TrackItem variant="segment" place={{ from: 0, to: 45 }} frames={100} label="Scene request, 0:00 to 0:04" pressed={seg2 === 'a'} band={0.1} testId="gl-seg" onActivate={() => setSeg2('a')}>
              request
            </TrackItem>
            <TrackItem variant="segment" place={{ from: 45, to: 100 }} frames={100} label="Scene proposal, 0:04 to 0:10" pressed={seg2 === 'b'} testId="gl-seg" onActivate={() => setSeg2('b')}>
              proposal
            </TrackItem>
          </Track>
          <Track name="Markers" testId={`gl-markers-${appearance}`} count={1}>
            <TrackItem
              variant="pin"
              place={{ at: 60 }}
              frames={100}
              label="Comment, open, at 0:06"
              states={['open']}
              testId="gl-pin"
              onActivate={() => setAt(60)}
              tip="open · 0:06 · the zoom starts too early"
            >
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
    </>
  );
}

/** Facts, disclosure, blockers, a checklist and an empty state. */
export function GalleryNotices({ name }: { name: string }) {
  return (
    <>
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
    </>
  );
}

/** A menu, sheets and the command palette. */
export function GalleryOverlays({ appearance, name, s }: { appearance: Appearance; name: string; s: GalleryState }) {
  const { sheet, setSheet, busy, setBusy, palette, setPalette, answer, setAnswer } = s;
  const commands: Command[] = [
    { id: 'projects', label: 'Projects', group: 'Go to', icon: 'folder', run: () => (location.hash = '#/') },
    { id: 'gallery', label: 'UI gallery', group: 'Go to', hint: 'this page', icon: 'components', run: () => setAnswer('UI gallery') },
    { id: 'hello', label: 'Say hello', group: 'Commands', hint: 'writes the last answer', run: () => setAnswer('hello') },
    { id: 'inspector', label: 'Toggle the sample inspector', group: 'Commands', kbd: ['⌥', '⌘', 'I'], run: () => setAnswer('inspector') },
  ];
  return (
    <Section title="Menu, sheet, palette">
      <Menu
        label={`Take actions (${name})`}
        text="Take"
        items={[
          { id: 'dup', label: 'Duplicate', kbd: ['⌘', 'D'] },
          { id: 'rename', label: 'Rename…' },
          { id: 'export', label: 'Export', disabled: true },
          'separator',
          { id: 'delete', label: 'Delete take', danger: true },
        ]}
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
  );
}
