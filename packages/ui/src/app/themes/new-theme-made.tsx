/**
 * What a made theme's answer said (New theme's last step): its name and base, Open it in the editor, its palette
 * adjustments and warnings.
 */
import type { ThemeCreated } from '../data/ops.js';
import { Txt } from '../bits.js';
import { Button, LinkButton } from '../ui-kit/index.js';

/** What the made theme's answer said: its name and base, Open it in the editor, its palette adjustments and warnings. */
export function NewThemeMade({ slug, made, onClose }: { slug: string; made: ThemeCreated; onClose: () => void }) {
  return (
    <div className="tm-panel-body" role="status" data-testid="theme-new-made">
      <p className="tm-line">
        {'Theme '}
        <Txt className="k-mono" text={made.name} />
        {' made over '}
        <Txt text={made.base} />
        {'. '}
        <LinkButton size="sm" variant="primary" to={{ name: 'themes', slug, theme: made.name }} testId="theme-new-edit">
          Open it in the editor
        </LinkButton>
      </p>
      {made.palette.adjusted.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one answer's adjustments, fixed once said, text only: the index is the identity
        <p key={i} className="tm-line">
          <Txt text={`Adjusted ${a.key}: ${a.from} → ${a.to} (for ${a.check.replace(/_/g, ' ')}).`} />
        </p>
      ))}
      {made.palette.suggestions.accent && (
        <p className="tm-line">
          <Txt text={`A stronger accent would pass on the paper: ${made.palette.suggestions.accent} (not applied).`} />
        </p>
      )}
      {made.warnings.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: one answer's warnings, fixed once said, text only: the index is the identity
        <p key={i} className="tm-quiet">
          <Txt text={w} />
        </p>
      ))}
      <span>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </span>
    </div>
  );
}
