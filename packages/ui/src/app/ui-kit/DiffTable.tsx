/**
 * L5.12b: `DiffTable` (R4-Comments: Claude's proposal) — a change to a text file, line by line, drawn code-safe: a table
 * whose rows are the caller's (a sign and its word — the sign on screen, the word for assistive technology —, the line
 * numbers before and after, the line's pieces), every row shown in the page's own scroll (no inner box, no "Show all": a
 * reader sees the whole change before any button that applies it). A line is a left-to-right monospace cell in byte
 * order (`dir="ltr"` and a bidi override: right-to-left letters never reorder the digits and signs around them; a line
 * holding them is marked "right-to-left text"), spaces kept, edge spaces `·`, tabs `→`, unseen characters `[U+…]` —
 * the pieces come split that way (comment-words `linePieces`): a text piece holds no direction control, and its text is
 * shown with any left made visible. A gap row says how many unchanged lines it leaves out.
 * The rows differ by more than colour: each starts with its sign (a 3 px bar in the state colour beside it).
 * L5.12b fixes (review A-L7): the table itself is named (a caption for assistive technology: table navigation announces
 * it), and the marks stay visual — edge spaces and tabs are read as words ("2 leading spaces", "a tab"), never as "middle
 * dot" × n.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { shown, visibleControls } from '../bits.js';

/** A piece of a line: text, a run of edge spaces, a tab, an unseen character's code (`U+200B`). */
export type DiffPiece = { kind: 'text'; text: string } | { kind: 'space'; count: number } | { kind: 'tab' } | { kind: 'char'; code: string };

export interface DiffRow {
  kind: 'add' | 'del' | 'context' | 'gap';
  /** The sign on screen (`+`, `−`, `…`, or none). */
  sign: string;
  /** The row's kind in words ("added", "removed", "unchanged", "3 unchanged lines not shown"). */
  word: string;
  /** The line number before and after (none for a gap). */
  base: number | null;
  line: number | null;
  pieces: DiffPiece[];
  /** The line holds right-to-left letters (drawn in byte order: said so). */
  rtl: boolean;
}

/** Edge spaces in words: "2 leading spaces", "1 trailing space", "4 spaces" (a line of spaces only). */
export function spacesWords(count: number, at: 'leading' | 'trailing' | 'only'): string {
  return `${count.toLocaleString('en')} ${at === 'only' ? '' : `${at} `}${count === 1 ? 'space' : 'spaces'}`;
}

/** One line, code-safe: text nodes, and the marks for edge spaces, tabs and unseen characters. */
function Line({ pieces }: { pieces: DiffPiece[] }) {
  return (
    <>
      {pieces.map((p, i) =>
        p.kind === 'text' ? (
          <span key={i}>{visibleControls(p.text)}</span>
        ) : p.kind === 'space' ? (
          <span key={i}>
            <span className="k-diff-mark" aria-hidden="true" title={p.count === 1 ? 'a space' : `${p.count} spaces`}>
              {visibleControls('·'.repeat(p.count))}
            </span>
            <span className="k-sr">
              {visibleControls(pieces.length === 1 ? spacesWords(p.count, 'only') : i === 0 ? `${spacesWords(p.count, 'leading')}, ` : `, ${spacesWords(p.count, 'trailing')}`)}
            </span>
          </span>
        ) : p.kind === 'tab' ? (
          <span key={i}>
            <span className="k-diff-mark" aria-hidden="true" title="a tab">
              →
            </span>
            <span className="k-sr"> a tab </span>
          </span>
        ) : (
          <span key={i} className="k-diff-mark k-diff-char" title="a character you cannot see">
            {visibleControls(`[${p.code}]`)}
          </span>
        ),
      )}
    </>
  );
}

export function DiffTable({
  rows,
  label,
  title,
  testId,
  boxTestId,
}: {
  rows: DiffRow[];
  /** The table's name ("The proposed change, line by line"). */
  label: string;
  /** A head line over the table (the file and its first line). */
  title?: ReactNode;
  testId?: string;
  boxTestId?: string;
}) {
  const titleId = useId();
  return (
    <div className="k-diff" data-testid={boxTestId}>
      {title !== undefined && (
        <p id={titleId} className="k-diff-title k-mono">
          {shown(title)}
        </p>
      )}
      <table className="k-diff-table" data-testid={testId} aria-describedby={title !== undefined ? titleId : undefined}>
        <caption className="k-sr">{visibleControls(label)}</caption>
        <colgroup>
          <col className="k-diff-col-sign" />
          <col className="k-diff-col-n" />
          <col className="k-diff-col-n" />
          <col />
        </colgroup>
        <thead className="k-sr">
          <tr>
            <th scope="col">Change</th>
            <th scope="col">Line before</th>
            <th scope="col">Line after</th>
            <th scope="col">Text</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'gap' ? (
              <tr key={i} className="k-diff-row is-gap" data-testid="diff-row" data-kind="gap">
                <td colSpan={4} className="k-diff-gap">
                  <span aria-hidden="true">⋯ </span>
                  {shown(r.word)}
                </td>
              </tr>
            ) : (
              <tr key={i} className={`k-diff-row is-${r.kind}`} data-testid="diff-row" data-kind={r.kind}>
                <td className="k-diff-sign">
                  <span aria-hidden="true">{shown(r.sign)}</span>
                  <span className="k-sr">{shown(r.word)}</span>
                </td>
                <td className="k-diff-n">{shown(r.base ?? '')}</td>
                <td className="k-diff-n">{shown(r.line ?? '')}</td>
                <td className="k-diff-code">
                  {r.rtl && (
                    <span className="k-diff-rtl" data-testid="diff-rtl" title="Drawn in byte order, left to right: an editor shows right-to-left letters in another order">
                      right-to-left text
                    </span>
                  )}
                  <code dir="ltr" data-testid="diff-line">
                    <Line pieces={r.pieces} />
                  </code>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * L5.12b: `RegionOverlay` — a region drawn over a picture (a frame comment's), placed by its shares of the picture
 * (0–1), its label at its top-left corner; dashed while it is a draft (a drag in progress). Presentational: the pointer
 * surface that draws it is the caller's (and named in the real-controls lint's exceptions there), and it is hidden from
 * assistive technology (the region is said in words beside the picture).
 */
export function RegionOverlay({ region, label, draft, testId }: { region: { x: number; y: number; w: number; h: number }; label: ReactNode; draft?: boolean; testId?: string }) {
  return (
    <span
      className={draft ? 'k-region is-draft' : 'k-region'}
      data-testid={testId}
      aria-hidden="true"
      style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.w * 100}%`, height: `${region.h * 100}%` }}
    >
      <span className="k-region-label">{shown(label)}</span>
    </span>
  );
}
