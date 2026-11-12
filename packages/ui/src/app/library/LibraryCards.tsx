/**
 * L5.12c « Épure » 4c: the Library's cards (R4-Library; was LibraryScreen.tsx's) — the screen's context (the theme, the
 * image loader, the render pump, the on-screen observer, the selection), a component's picture box, its play controls
 * and its poster card.
 *
 * - A card is one selection control (the kit's PosterCard: a pressed button — the inspector then shows the component)
 *   and its play controls under it: Play (a toggle: `aria-pressed`, ONE name — "Play <name>", its state the pressed look
 *   and the "Playing · loop" mark on the poster; loops never start by themselves), Retry of a failed poster or loop,
 *   "Render again"; the failure's words (untrusted). Each button's name is its words and the component's name
 *   (`aria-labelledby` the button and the element showing the name: the name, agent-writable text, is never copied into
 *   an attribute — review B L1 of L4.7).
 * - Cards are memoised (a grid of 200+ stays responsive): a card renders again only when ITS item, selection or play
 *   state changes (an item compared by value: a re-read of the view hands new objects); the pump is read per card
 *   (useSyncExternalStore of that card's two keys), never a re-render of every card per pump change.
 * - A picture box tells the pump and the image loader when it is on screen: the observer's root is the scroller that
 *   holds the box (the shell's centre pane; the inspector's picture is watched against the window).
 * - L5.12c fixes: the grid is ONE tab stop (review A-M3: a roving tab stop — the selected card, else the last one
 *   picked, else the first; its controls are stops too, every other card's are not: LibraryScreen.tsx moves it with the
 *   arrows, Home / End, and Enter on the selected card takes the focus to its inspector); the card's frame — the
 *   selection fill and ring, the hover — is the whole card with its Play (review B-M1: the ring is the selecting
 *   button's own mark, drawn over the card); the selecting button is named by
 *   the component's name, its id and tags its description (review A-L7: the picture's alt is not said first); with the
 *   inspector hidden, the selected card links to its page (review B-L3); Play pressed has a look of its own, not the focus
 *   ring's (review A-L6), and its icon turns to a pause.
 *
 * Safety: every manifest word is text (`Txt`); pictures reach the one `<img>` only as checked data addresses (`Picture`:
 * PNG posters, GIF loops, magic and caps).
 */
import { createContext, memo, useCallback, useContext, useEffect, useId, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { LibraryItem } from '../../server/library-ops.js';
import { SlotContext } from '../shell/slots.js';
import { Txt, shown } from '../bits.js';
import type { ImageEntry, ImageWant, LibraryImages, RenderPump } from './library-load.js';
import { SOURCE_WORDS, canPlay, loopWords, pictureAlt, posterWords } from '../words/library-words.js';
import { Picture } from '../Thumb.js';
import { LOOP_DATA_MAX, POSTER_DATA_MAX } from '../thumbs.js';
import { Button, LinkButton, PosterCard, StatusMark, Tag } from '../ui-kit/index.js';

const CARD_W = 320;
const CARD_H = 180;
const DETAIL_W = 640;
const DETAIL_H = 360;

export interface LibraryCtx {
  slug: string;
  theme: string;
  images: LibraryImages;
  pump: RenderPump;
  setPlaying(component: string, on: boolean): void;
  select(component: string | null): void;
  /** Read the view again (after a theme write: the event follows too). */
  reload(): void;
  observe(el: Element, on: (visible: boolean) => void): () => void;
}

export const LibraryContext = createContext<LibraryCtx | null>(null);
export const useLibrary = (): LibraryCtx => {
  const c = useContext(LibraryContext);
  if (!c) throw new Error('outside the library');
  return c;
};

/** A key's asked state for its card's words (re-renders this card only when that key's state changes). */
function useAsked(pump: RenderPump, key: string): 'asked' | 'ended' | undefined {
  const subscribe = useCallback((fn: () => void) => pump.subscribe(fn), [pump]);
  const a = useSyncExternalStore(subscribe, () => pump.askedOf(key));
  return a === 'ended' ? 'ended' : a === 'pending' || a === 'asked' ? 'asked' : undefined;
}

function useImage(images: LibraryImages, want: ImageWant | null): ImageEntry | undefined {
  return useSyncExternalStore(
    (fn) => (want ? images.subscribe(want, fn) : () => undefined),
    () => (want ? images.get(want) : undefined),
  );
}

/** The image a picture box wants (a poster committed or cached, a playing cached loop), or null. */
function posterWant(i: LibraryItem): ImageWant | null {
  if (i.poster.state === 'committed') return { kind: 'poster', component: i.component };
  if (i.poster.state === 'cached') return { kind: 'poster', component: i.component, key: i.poster.key };
  return null;
}
const loopWant = (i: LibraryItem): ImageWant | null => (i.loop.state === 'cached' ? { kind: 'loop', component: i.component, key: i.loop.key } : null);

const IMAGE_WORDS: Record<string, string> = {
  missing: 'The picture is not in the cache any more',
  too_large: 'The picture is too large to show',
  not_builtin: 'No committed poster for this component',
  unreadable: 'The picture cannot be shown',
  failed: 'The picture could not be loaded',
};

/**
 * A component's picture: the loop while it plays (and is there), else the poster, else words. Its box tells the pump
 * and the image loader when it is on screen.
 */
export function PictureBox({ item, playing, large = false }: { item: LibraryItem; playing: boolean; large?: boolean }) {
  const lib = useLibrary();
  const box = useRef<HTMLSpanElement>(null);
  const posterAsked = useAsked(lib.pump, item.poster.key);
  const loopAsked = useAsked(lib.pump, item.loop.key);
  // One want object per (component, state, key): the loader's subscriptions and the observer stay put across re-renders.
  const pw = useMemo(() => posterWant(item), [item.component, item.poster.state, item.poster.key]);
  const lw = useMemo(() => (playing ? loopWant(item) : null), [playing, item.component, item.loop.state, item.loop.key]);
  const poster = useImage(lib.images, pw);
  const loop = useImage(lib.images, lw);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let visible = false;
    const stop = lib.observe(el, (v) => {
      if (v === visible) return;
      visible = v;
      lib.pump.setVisible(item.component, v);
      if (pw) lib.images.setVisible(pw, v);
      if (lw) lib.images.setVisible(lw, v);
    });
    return () => {
      stop();
      if (visible) {
        lib.pump.setVisible(item.component, false);
        if (pw) lib.images.setVisible(pw, false);
        if (lw) lib.images.setVisible(lw, false);
      }
    };
    // A new want (a theme change, a new render, Play) observes again: the observer reports the box at once.
  }, [lib, item.component, pw, lw]);
  const w = large ? DETAIL_W : CARD_W;
  const h = large ? DETAIL_H : CARD_H;
  let picture: ReactNode = null;
  let state = 'words';
  if (loop?.state === 'ok') {
    picture = <Picture format="gif" base64={loop.data} max={LOOP_DATA_MAX} width={w} height={h} alt={pictureAlt(item.component, lib.theme, 'loop')} className="lb-img" />;
    state = 'loop';
  } else if (poster?.state === 'ok') {
    picture = <Picture format="png" base64={poster.data} max={POSTER_DATA_MAX} width={w} height={h} alt={pictureAlt(item.component, lib.theme, 'poster')} className="lb-img" />;
    state = 'poster';
  }
  const pWords = posterWords(item.poster, { asked: posterAsked });
  const words = picture ? null : (pWords ?? (poster?.state === 'missing' ? IMAGE_WORDS[poster.reason] : pw ? 'Loading the poster…' : null));
  const note = playing && picture && loop?.state !== 'ok' ? (loop?.state === 'missing' ? IMAGE_WORDS[loop.reason] : (loopWords(item.loop, true, { asked: loopAsked }) ?? 'Loading the loop…')) : null;
  return (
    <span ref={box} className={large ? 'lb-pic lb-pic-large' : 'lb-pic'} data-testid="lib-picture" data-state={state}>
      {shown(picture)}
      {words && (
        <span className="lb-pic-words" data-testid="lib-pic-words">
          <Txt text={words} />
        </span>
      )}
      {state === 'loop' && (
        <span className="lb-playing">
          <StatusMark state="running" word="Playing · loop" />
        </span>
      )}
      {note && (
        <span className="lb-pic-note">
          <Txt text={note} />
        </span>
      )}
    </span>
  );
}

/**
 * Play (a toggle with one name), Retry of a failed poster or loop, "Render again"; the failure's words (untrusted).
 */
export function PlayControls({ item, playing, nameId, tabStop = true }: { item: LibraryItem; playing: boolean; nameId: string; /** Not a tab stop: a card of the grid that is not its stop. */ tabStop?: boolean }) {
  const lib = useLibrary();
  const id = useId();
  const posterAsked = useAsked(lib.pump, item.poster.key);
  const loopAsked = useAsked(lib.pump, item.loop.key);
  const named = (what: string) => ({ id: `${id}-${what}`, 'aria-labelledby': `${id}-${what} ${nameId}`, ...(tabStop ? {} : { tabIndex: -1 }) });
  const playable = canPlay(item.loop);
  const lw = loopWords(item.loop, playing, { asked: loopAsked });
  const ended = posterAsked === 'ended' || loopAsked === 'ended';
  const failure = item.poster.untrusted ?? item.loop.untrusted;
  return (
    <div className="lb-controls">
      <Button
        size="sm"
        variant="ghost"
        icon={playing ? 'pause' : 'play'}
        aria-pressed={playing}
        disabled={!playable && !playing}
        {...named('play')}
        data-testid="lib-play"
        onClick={() => {
          lib.setPlaying(item.component, !playing);
          if (!playing) lib.pump.wantLoops([item.component]);
        }}
      >
        Play
      </Button>
      {item.poster.state === 'failed' && (
        <Button size="sm" variant="ghost" {...named('retry-poster')} data-testid="lib-retry-poster" onClick={() => void lib.pump.retry(item.component, 'poster')}>
          Retry the poster
        </Button>
      )}
      {item.loop.state === 'failed' && (
        <Button size="sm" variant="ghost" {...named('retry-loop')} data-testid="lib-retry-loop" onClick={() => void lib.pump.retry(item.component, 'loop')}>
          Retry the loop
        </Button>
      )}
      {ended && (
        <Button size="sm" variant="ghost" {...named('again')} onClick={() => lib.pump.again(item.component)}>
          Render again
        </Button>
      )}
      {lw && (
        <span className="lb-words" data-testid="lib-loop-words">
          <Txt text={lw} />
        </span>
      )}
      {failure && (
        <span className="lb-failure" data-testid="lib-failure">
          {'Why: '}
          <Txt text={failure.reason} />
        </span>
      )}
    </div>
  );
}

/** The source as a tag in words (never "made with Claude": nobody can tell who wrote one). */
export function SourceTag({ source }: { source: LibraryItem['source'] }) {
  return <Tag testId="lib-source">
      <Txt text={SOURCE_WORDS[source].badge} />
    </Tag>;
}

/** "Theme default" (the kind in brackets when the theme picks it as another kind than its own). */
export function DefaultTag({ item }: { item: LibraryItem }) {
  if (!item.theme_default.length) return null;
  return <Tag testId="lib-default">
      <Txt text={`Theme default${item.theme_default.length === 1 && item.theme_default[0] !== item.kind ? ` (${item.theme_default[0]})` : ''}`} />
    </Tag>;
}

/** Two cards show the same thing (a re-read of the view hands new item objects with the same values). */
function sameCard(a: CardProps, b: CardProps): boolean {
  return a.selected === b.selected && a.playing === b.playing && a.tabStop === b.tabStop && a.testId === b.testId && (a.item === b.item || JSON.stringify(a.item) === JSON.stringify(b.item));
}

interface CardProps {
  item: LibraryItem;
  selected: boolean;
  playing: boolean;
  /** The grid's one tab stop (its select button and controls). */
  tabStop: boolean;
  testId: string;
}

/** With the inspector hidden, the selected card links to the component's page (its facts are there; review B-L3). */
function CardPage({ item, nameId, tabStop }: { item: LibraryItem; nameId: string; tabStop: boolean }) {
  const lib = useLibrary();
  const host = useContext(SlotContext);
  const id = useId();
  if (!host?.hidden?.inspector) return null;
  return (
    <LinkButton size="sm" variant="ghost" to={{ name: 'library', slug: lib.slug, theme: lib.theme, component: item.component }} testId="lib-card-open" id={id} labelledBy={`${id} ${nameId}`} {...(tabStop ? {} : { tabIndex: -1 })}>
      Details
    </LinkButton>
  );
}

/** A component's poster card: the selection control (the kit's PosterCard) and its play controls, in one frame. */
export const LibraryCard = memo(function LibraryCard({ item, selected, playing, tabStop, testId }: CardProps) {
  const lib = useLibrary();
  const nameId = useId();
  const metaId = useId();
  return (
    <li className="lb-card" data-selected={selected ? 'yes' : undefined} data-testid={testId} data-component={item.component} data-poster-state={item.poster.state} data-loop-state={item.loop.state}>
      <PosterCard
        selected={selected}
        onSelect={() => lib.select(selected ? null : item.component)}
        tabIndex={tabStop ? 0 : -1}
        labelledBy={nameId}
        describedBy={metaId}
        picture={<PictureBox item={item} playing={playing} />}
        title={
          <span id={nameId} data-testid="lib-name">
            <Txt text={item.untrusted.name} />
          </span>
        }
        meta={
          <span className="lb-card-meta" id={metaId}>
            <Txt className="k-mono lb-id" text={item.component} />
            <SourceTag source={item.source} />
            <DefaultTag item={item} />
            {(item.poster.queued || item.loop.queued) && <Tag>queued</Tag>}
          </span>
        }
      />
      <PlayControls item={item} playing={playing} nameId={nameId} tabStop={tabStop} />
      {selected && <CardPage item={item} nameId={nameId} tabStop={tabStop} />}
    </li>
  );
}, sameCard);
