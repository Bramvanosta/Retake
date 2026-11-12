/**
 * The timeline's banner while it previews a proposal (L4.6 part D2; L5.12b on the kit: a Callout over Edit's stage —
 * was ProposalPanel.tsx's): `timeline_view {proposal}` plans the proposed text in memory on the commented take, nothing is
 * written and the switches are off. It says which comment, whether the plan shows the change, and Back to the comment —
 * the thread, scrolled to its proposal (a one-shot hand-off: focusProposalOf). It NEVER applies: Apply is offered only
 * where the whole diff is shown (the thread's ProposalCard). Every server string is text.
 */
import { useThreadGet } from '../data/comments.js';
import { Txt } from '../bits.js';
import { proposalButtons, proposalSummary } from '../words/comment-words.js';
import { focusProposalOf } from './proposal-focus.js';
import { versionWords } from '../words/render-words.js';
import { Callout, LinkButton } from '../ui-kit/index.js';

export function ProposalBanner({ slug, name, proposal, shown }: { slug: string; name: string; proposal: { comment_id: string; entry_id: string }; shown: boolean | undefined }) {
  const [loaded] = useThreadGet({ project: slug, comment_id: proposal.comment_id, entry_id: proposal.entry_id }, `${slug}\0${proposal.comment_id}\0${proposal.entry_id}`);
  const data = loaded.state === 'ready' ? loaded.data : null;
  const p = data?.proposal && data.proposal.entry === proposal.entry_id ? data.proposal : null;
  const { why } = proposalButtons(p?.offer);
  return (
    <div className="cm-banner" data-testid="proposal-banner" data-shown={shown === false ? 'no' : 'yes'}>
      <Callout state="idle" role="note" title="Note: previewing a proposed change">
        <p>
          {data ? (
            <Txt
              text={`The edit Claude proposed on the comment at ${data.thread.timecode} (${versionWords(data.thread.render_id)}, frame ${data.thread.frame.toLocaleString('en')}), planned on its take. Nothing is written here; switches and Render are off. Read the whole diff and apply it in the thread.`}
            />
          ) : (
            'The edit Claude proposed on a comment, planned on its take. Nothing is written here: read the whole diff and apply it in the thread.'
          )}
        </p>
        {p && (
          <p>
            <Txt text={`${proposalSummary(p)}.`} />
          </p>
        )}
        {shown === false && <p data-testid="proposal-not-shown">The preview cannot show this change on this take (the plan comes out as captured): read the diff in the thread instead.</p>}
        {loaded.state === 'error' && (
          <p className="cm-pre" role="alert">
            <Txt text={loaded.error} />
          </p>
        )}
        <div className="cm-actions">
          <LinkButton size="sm" variant="primary" to={{ name: 'comments', slug, scenario: name, thread: proposal.comment_id }} testId="banner-back" onClick={() => focusProposalOf(slug, proposal.comment_id)}>
            Back to the comment
          </LinkButton>
        </div>
        {p && p.offer.apply !== true && why && (
          <p className="cm-quiet" data-testid="banner-why">
            <Txt text={`${why}.`} />
          </p>
        )}
      </Callout>
    </div>
  );
}
