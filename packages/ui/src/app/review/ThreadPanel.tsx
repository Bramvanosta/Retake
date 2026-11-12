/**
 * A thread in the inspector (L4.6 part D1; L5.12b « Épure » 4b, R4-Comments' right pane: was CommentsScreen.tsx's): the
 * comment (status, channel, author as text, when), its text, where it points (the anchor's chips as tags), its region and
 * frame, the newer renders, its still when its render is gone, its entries (the channel in words, an author and a text as
 * untrusted text — an MCP entry shows its channel alone: its author is always the server's agent), the newest proposal
 * (ProposalCard.tsx), then Reply, Resolve (a note, optionally the newer render that answers it) or Reopen.
 * Every write of the thread goes through ONE helper (`send`: the op name and its arguments; a lint pins its call), on the
 * thread's hash the panel showed (`if_match`; Reply needs none): a 409 reads the thread again and says so — the text
 * typed stays, nothing is re-sent. One write at a time: the buttons wait while one is sent.
 */
import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ScenarioRenderView } from '@retake/engine';
import type { ThreadAnswer } from '../../server/comment-ops.js';
import { CallError, errorText } from '../api.js';
import { threadWrite, useThreadGet, useThreadStill } from '../data/comments.js';
import type { ThreadPanelArgs, ThreadPanelWrite } from '../data/comments.js';
import type { OpArgs } from '../data/client.js';
import { Txt, When, plural } from '../bits.js';
import { CHANNEL_NOTE, COMMENT_TEXT_MAX, anchorChips, channelWords, entryWords, proposalWords, regionWords, renderWords, statusWords } from '../words/comment-words.js';
import type { Chip } from '../words/comment-words.js';
import { ProposalCard } from './ProposalCard.js';
import { dropProposalFocus } from './proposal-focus.js';
import type { RendersState } from './Renders.js';
import { SessionEnded } from '../session.js';
import { Jpeg } from '../Thumb.js';
import { SHEET_DATA_MAX } from '../thumbs.js';
import { Button, Callout, LinkButton, Select, StatusMark, Tag, TextArea } from '../ui-kit/index.js';
import type { MarkState } from '../ui-kit/index.js';

/** A thread's status as a mark: an open one waits for an answer. */
export const threadMark = (status: string): MarkState => (status === 'resolved' ? 'ok' : 'attention');

/** The anchor's chips, each a tag (its kind, its words, a note where the step is today). */
export function ChipList({ chips, label }: { chips: Chip[]; label: string }) {
  return (
    <ul className="cm-chips" aria-label={label} data-testid="chips">
      {chips.map((c) => (
        <li key={c.kind}>
          <Tag testId={`chip-${c.kind}`}>
            <span className="cm-chip-label">
              <Txt text={c.label} />
            </span>{' '}
            <Txt text={c.words} />
            {c.note && <Txt className="cm-chip-note" text={` (${c.note})`} />}
          </Tag>
        </li>
      ))}
    </ul>
  );
}

/** Memoised (review A-L2): a frame step of the viewer re-renders the screen, never the thread (its props are stable). */
export const ThreadPanel = memo(function ThreadPanel({ slug, name, id, tick, onThread, renders, rs }: { slug: string; name: string; id: string; tick: number; onThread: (t: ThreadAnswer | null) => void; renders: ScenarioRenderView[]; rs: RendersState }) {
  const [loaded, reload] = useThreadGet({ project: slug, comment_id: id }, `${slug}\0${id}`);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [tick, reload]);
  const t = loaded.state === 'ready' ? loaded.data.thread : null;
  useEffect(() => {
    if (t) onThread(t);
  }, [t, onThread]);
  // A thread that cannot be read takes no proposal focus with it to a later visit.
  useEffect(() => {
    if (loaded.state === 'error') dropProposalFocus();
  }, [loaded.state]);
  const head = useId();
  if (loaded.state === 'loading') {
    return (
      <p className="cm-quiet" role="status">
        Loading the thread…
      </p>
    );
  }
  if (loaded.state === 'error') {
    const gone = loaded.code === 'not_found';
    return (
      <Callout state={gone ? 'idle' : 'fail'} role="alert" title={gone ? 'Note: no such thread' : 'This thread cannot be read'}>
        <p className="cm-pre" data-testid="thread-error">
          <Txt text={loaded.error} />
        </p>
        <p>
          <LinkButton size="sm" variant="ghost" to={{ name: 'comments', slug, scenario: name }}>
            Back to the threads
          </LinkButton>
        </p>
      </Callout>
    );
  }
  const th = loaded.data.thread;
  const texts = new Map(th.untrusted.entries.map((e) => [e.id, e]));
  const chips = anchorChips({ frame: th.frame, timecode: th.timecode, anchor: th.anchor, ...(th.step_now !== undefined ? { step_now: th.step_now } : {}) });
  return (
    <article className="cm-thread" aria-labelledby={head} data-testid="thread" data-id={th.id} data-status={th.status} data-hash={th.hash}>
      <div className="cm-thread-head">
        <h2 id={head} className="cm-h2">
          <Txt text={`Comment at ${th.timecode} on ${renderWords(th.render_id)}`} />
        </h2>
        <StatusMark state={threadMark(th.status)} word={statusWords(th.status)} />
      </div>
      <p className="cm-meta">
        <Txt text={th.untrusted.author} />
        <Txt className="cm-quiet-inline" text={` (${channelWords(th.via)}) · `} />
        <When iso={th.created_at} />
      </p>
      <p className="cm-text cm-pre" data-testid="thread-text">
        <Txt text={th.untrusted.text} />
      </p>
      <ChipList chips={chips} label="Where it points" />
      <p className="cm-quiet" data-testid="thread-region">
        <Txt text={`${th.region ? `Region ${regionWords(th.region)}` : 'About the whole frame'} · frame ${th.frame.toLocaleString('en')}${th.variant !== 'landscape' ? ` · ${th.variant}` : ''}`} />
      </p>
      {th.newer_renders.length > 0 && (
        <p className="cm-small" data-testid="newer-renders">
          <Txt text={`Newer renders: ${th.newer_renders.map(renderWords).join(', ')} — the frame may already be fixed there.`} />
        </p>
      )}
      {!th.render_present && th.still && <ThreadStill slug={slug} id={th.id} renderId={th.render_id} />}
      {th.entries.length > 0 && (
        <>
          <h3 className="cm-h3">
            <Txt text={plural(th.entries_total, 'entry', 'entries')} />
          </h3>
          {th.entries_total > th.entries.length && (
            <p className="cm-quiet">
              <Txt text={`The newest ${th.entries.length} are shown.`} />
            </p>
          )}
          <ol className="cm-entries" data-testid="thread-entries">
            {th.entries.map((e) => {
              const u = texts.get(e.id);
              return (
                <li key={e.id} className="cm-entry" data-testid="thread-entry" data-kind={e.kind} data-via={e.via}>
                  <p className="cm-entry-head" data-testid="entry-head">
                    <Tag>
                      <Txt text={channelWords(e.via)} />
                    </Tag>{' '}
                    {u && e.via !== 'mcp' && (
                      <>
                        <Txt text={u.author} />{' '}
                      </>
                    )}
                    <Txt text={`${entryWords(e.kind)}${e.render_id ? ` with ${renderWords(e.render_id)}` : ''} · `} />
                    <When iso={e.created_at} />
                  </p>
                  {u && u.text !== '' && (
                    <p className="cm-pre cm-entry-text">
                      <Txt text={u.text} />
                    </p>
                  )}
                  {e.proposal && (
                    <p className="cm-small cm-line" data-testid="entry-proposal" data-state={e.proposal.state}>
                      <StatusMark state={e.proposal.actionable ? 'warn' : 'idle'} word={proposalWords(e.proposal.state)} />{' '}
                      <Txt text={`A change to scenarios/${name}.yaml: ${plural(e.proposal.added, 'line')} added, ${e.proposal.removed} removed, in ${plural(e.proposal.hunks, 'place')}.`} />
                    </p>
                  )}
                  {e.applies && (
                    <p className="cm-quiet">
                      <Txt text={`Applied the proposal of ${e.applies}.`} />
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
      {loaded.data.proposal && <ProposalCard slug={slug} name={name} th={th} p={loaded.data.proposal} rs={rs} reload={reload} />}
      <ThreadActions slug={slug} name={name} th={th} renders={renders} reload={reload} />
      <p className="cm-quiet">
        <Txt text={CHANNEL_NOTE} />
      </p>
    </article>
  );
});

/** A thread's still (its render is gone): asked once, a checked data: JPEG. */
function ThreadStill({ slug, id, renderId }: { slug: string; id: string; renderId: string }) {
  const [loaded] = useThreadStill({ project: slug, comment_id: id }, `${slug}\0${id}`);
  return (
    <figure className="cm-still" data-testid="thread-still">
      {loaded.state === 'ready' ? (
        <Jpeg base64={loaded.data.base64} max={SHEET_DATA_MAX} width={loaded.data.width} height={loaded.data.height} alt={`The still of this comment, made on ${renderWords(renderId)} (its region outlined)`} />
      ) : (
        <p className="cm-quiet">{loaded.state === 'error' ? <Txt text={loaded.error} /> : 'Loading the still…'}</p>
      )}
      <figcaption className="cm-quiet">
        <Txt text={`The still kept with the thread: ${renderWords(renderId)} is gone.`} />
      </figcaption>
    </figure>
  );
}

type Write = { kind: 'idle' } | { kind: 'sending'; what: string } | { kind: 'done'; words: string } | { kind: 'conflict'; words: string } | { kind: 'error'; words: string };

function ThreadActions({ slug, name, th, renders, reload }: { slug: string; name: string; th: ThreadAnswer; renders: ScenarioRenderView[]; reload: () => void }) {
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const item = { kind: 'comment' as const, project: slug, scenario: name };
  const newer = th.newer_renders.filter((r) => renders.some((x) => x.render_id === r));
  const [answer, setAnswer] = useState<string>(newer[0] ?? '');
  const [write, setWrite] = useState<Write>({ kind: 'idle' });
  const send = <K extends ThreadPanelWrite>(what: string, op: K, args: ThreadPanelArgs<K>, done: string, clear: () => void) => {
    setWrite({ kind: 'sending', what });
    // The op's arguments: the thread's two, then the write's own (ThreadPanelArgs<K>: the op's arguments without those two).
    threadWrite(op, { project: slug, comment_id: th.id, ...args } as OpArgs<K>)
      .then(
        () => {
          clear();
          setWrite({ kind: 'done', words: done });
        },
        (e: unknown) => {
          if (e instanceof SessionEnded) return;
          // The thread changed since the panel showed it (Claude replied, another tab): read it again, send nothing.
          if (e instanceof CallError && e.status === 409) setWrite({ kind: 'conflict', words: `The thread changed since you opened it: read it again, then ${what.toLowerCase()} — nothing was written. (${errorText(e)})` });
          else setWrite({ kind: 'error', words: errorText(e) });
        },
      )
      .finally(reload);
  };
  const sending = write.kind === 'sending';
  return (
    <div className="cm-thread-actions">
      <form
        className="cm-form"
        aria-label="Reply"
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) send('Reply', 'thread_reply', { text: reply }, 'Reply posted', () => setReply(''));
        }}
      >
        <TextArea label="Reply" rows={3} value={reply} onChange={setReply} unsaved={reply.trim() ? item : null} maxLength={COMMENT_TEXT_MAX} placeholder="Answer or ask for another change" testId="reply-text" />
        <Button size="sm" submit data-testid="reply" disabled={sending || reply.trim() === ''}>
          Reply
        </Button>
      </form>
      {th.status === 'open' ? (
        <form
          className="cm-form"
          aria-label="Resolve"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) send('Resolve', 'thread_resolve', { note, if_match: th.hash, ...(answer ? { render_id: answer } : {}) }, 'Resolved', () => setNote(''));
          }}
        >
          <TextArea label="Resolve — what was changed" rows={2} value={note} onChange={setNote} unsaved={note.trim() ? item : null} maxLength={COMMENT_TEXT_MAX} testId="resolve-note" />
          {newer.length > 0 && <Select label="Answered by" value={answer} onChange={setAnswer} testId="resolve-render" options={[...newer.map((r) => ({ value: r, label: renderWords(r) })), { value: '', label: 'no render' }]} />}
          <Button size="sm" submit data-testid="resolve" disabled={sending || note.trim() === ''}>
            Resolve
          </Button>
        </form>
      ) : (
        <form
          className="cm-form"
          aria-label="Reopen"
          onSubmit={(e) => {
            e.preventDefault();
            send('Reopen', 'thread_reopen', { if_match: th.hash, ...(note.trim() ? { note } : {}) }, 'Reopened', () => setNote(''));
          }}
        >
          <TextArea label="Reopen — why (optional)" rows={2} value={note} onChange={setNote} unsaved={note.trim() ? item : null} maxLength={COMMENT_TEXT_MAX} testId="reopen-note" />
          <Button size="sm" submit data-testid="reopen" disabled={sending}>
            Reopen
          </Button>
        </form>
      )}
      <p className="cm-small" aria-live="polite" data-testid="thread-write">
        {write.kind === 'sending' ? <Txt text={`${write.what}…`} /> : write.kind === 'done' ? <Txt text={write.words} /> : ''}
      </p>
      {(write.kind === 'conflict' || write.kind === 'error') && (
        <Callout state={write.kind === 'conflict' ? 'warn' : 'fail'} role="alert" title={write.kind === 'conflict' ? 'Not written: the thread changed' : 'Not written'}>
          <p className="cm-pre" data-testid="thread-write-error">
            <Txt text={write.words} />
          </p>
        </Callout>
      )}
    </div>
  );
}
