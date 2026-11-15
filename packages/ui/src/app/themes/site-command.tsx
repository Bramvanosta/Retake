/**
 * The site panel's command half as it is drawn: the page URL with Show the command, and the command to copy for it
 * (never run from here). Presentational: site_list and the copy are the site panel's.
 */
import type { RefObject } from 'react';
import type { SiteListAnswer } from '../../server/theme-ops.js';
import { Txt } from '../bits.js';
import { Button, TextField } from '../ui-kit/index.js';

/** The page URL line: Enter or Show the command asks for the command. */
export function SiteUrlLine({ url, setUrl, onAsk }: { url: string; setUrl: (u: string) => void; onAsk: () => void }) {
  return (
    <div className="tm-url-line">
      <div className="tm-url">
        <TextField
          label="Page URL"
          type="url"
          value={url}
          onChange={setUrl}
          unsaved={null}
          maxLength={2048}
          placeholder="https://www.example.com"
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => e.key === 'Enter' && url && onAsk()}
          testId="site-url"
        />
      </div>
      <Button disabled={!url} onClick={() => onAsk()} data-testid="site-command">
        Show the command
      </Button>
    </div>
  );
}

/** The command for a URL: the host it extracts, the line (selected when copying is refused), Copy, and Claude's way. */
export function SiteCommandBox({
  command,
  lineRef,
  copied,
  onCopy,
}: {
  command: NonNullable<SiteListAnswer['command']>;
  lineRef: RefObject<HTMLElement | null>;
  copied: 'no' | 'yes' | 'failed';
  onCopy: () => void;
}) {
  return (
    <div className="tm-command" data-testid="site-command-box">
      <p className="tm-line">
        {'In a terminal (it extracts '}
        <Txt className="k-mono" text={command.untrusted.host} />
        {' after you approve it there):'}
      </p>
      <code ref={lineRef} className="k-mono tm-code" data-testid="site-command-line">
        <Txt text={command.line} />
      </code>
      <div className="tm-actions">
        <Button size="sm" icon="copy" onClick={onCopy} data-testid="site-command-copy">
          Copy the command
        </Button>
        <span className="tm-line" role="status">
          {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was refused: the command is selected — copy it with ⌘C.' : ''}
        </span>
      </div>
      <p className="tm-quiet">
        <Txt text={command.claude} />
      </p>
    </div>
  );
}
