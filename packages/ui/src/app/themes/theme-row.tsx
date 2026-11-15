/**
 * A card of the Themes list: the theme's tile (its colours), its swatches, its name (a link when it opens in the editor), its tags, what uses it,
 * Edit / Open and Copy to edit…, why it is read-only and its first problems. Presentational.
 */
import type { ThemeListAnswer } from '../../server/theme-ops.js';
import { Txt } from '../bits.js';
import { hrefTo } from '../route.js';
import { SOURCE_BADGE, offersCopy, okHex, opensInEditor, usedByWords } from '../words/theme-words.js';
import { Button, LinkButton, StatusMark, Tag } from '../ui-kit/index.js';

export type ListTheme = ThemeListAnswer['themes'][number];

/** A colour swatch: only a hex value reaches the style (anything else draws nothing). Theme data, not the Studio's chrome. */
export function Swatch({ hex, label }: { hex?: string | null; label: string }) {
  if (!okHex(hex)) return null;
  return <span className="tm-swatch" style={{ background: hex }} title={`${label} ${hex}`} aria-label={`${label} ${hex}`} role="img" />;
}

/**
 * A theme's tile: its paper, its name in its text colour over an accent rule — theme data drawn as the card's picture
 * (only hex values reach the style; a theme without them shows the Studio's own video tone).
 */
export function ThemeTile({ t }: { t: ListTheme }) {
  const paper = okHex(t.colors.paper) ? t.colors.paper : undefined;
  const text = okHex(t.colors.text) ? t.colors.text : undefined;
  const accent = okHex(t.colors.accent) ? t.colors.accent : undefined;
  return (
    <div className="tm-tile" aria-hidden="true" style={paper ? { background: paper } : undefined}>
      <span className="tm-tile-kicker" style={accent ? { color: accent } : undefined}>
        Product tour
      </span>
      <span className="tm-tile-name" style={text ? { color: text } : undefined}>
        <Txt text={t.name} />
      </span>
      <span className="tm-tile-rule" style={accent ? { background: accent } : undefined} />
    </div>
  );
}

export function ThemeRow({ slug, t, onCopy }: { slug: string; t: ListTheme; onCopy: () => void }) {
  return (
    <li className="tm-row tm-card" data-testid="theme-row" data-theme={t.name} data-editable={t.editable === true ? 'yes' : 'no'}>
      <ThemeTile t={t} />
      <div className="tm-row-main">
        <span className="tm-swatches" aria-hidden={!t.colors.accent}>
          <Swatch hex={t.colors.paper} label="paper" />
          <Swatch hex={t.colors.text} label="text" />
          <Swatch hex={t.colors.accent} label="accent" />
        </span>
        <span className="tm-row-name">
          {opensInEditor(t) ? (
            <a href={hrefTo({ name: 'themes', slug, theme: t.name })} className="tm-link" data-testid="theme-open">
              <Txt className="k-mono" text={t.name} />
            </a>
          ) : (
            <Txt className="k-mono" text={t.name} />
          )}
        </span>
        <span className="tm-tags">
          <Tag testId="theme-tag">
            <Txt text={SOURCE_BADGE[t.source]} />
          </Tag>
          {t.default && <Tag testId="theme-tag">The project's theme</Tag>}
          <Tag testId="theme-tag">
            <Txt text={t.editable === true ? 'Editable' : 'Read-only'} />
          </Tag>
          {t.issues.length > 0 && <StatusMark state="fail" word="Broken: it does not load" />}
        </span>
        <Txt className="tm-quiet" text={usedByWords(t.used_by, slug)} />
        <span className="tm-row-actions">
          {opensInEditor(t) && (
            <LinkButton size="sm" variant="ghost" to={{ name: 'themes', slug, theme: t.name }} label={`${t.editable === true ? 'Edit' : 'Open'} ${t.name}`}>
              {t.editable === true ? 'Edit' : 'Open'}
            </LinkButton>
          )}
          {offersCopy(t) && (
            <Button size="sm" onClick={onCopy} data-testid="theme-row-copy">
              Copy to edit…
            </Button>
          )}
        </span>
      </div>
      {t.editable !== true && (
        <p className="tm-quiet" data-testid="theme-row-why">
          <Txt text={t.editable.why} />
        </p>
      )}
      {t.issues.slice(0, 2).map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a theme's first issues, replaced whole on each read, text only: the index is the identity
        <p key={i} className="tm-failure">
          <Txt text={x} />
        </p>
      ))}
    </li>
  );
}
