/**
 * L5.13b: the app mark, "two takes" — the drawing of mark.ts (the one source the favicon and the desktop icon are made
 * from), inline, decorative (`aria-hidden`: the app's name is always written beside it), painted by classes on the
 * `--ui-mark-*` tokens (the plate lifted in dark, the ink plate in light). The variant follows the size it is seen at
 * (`tiny` for the 18 px title bar, `full` for Welcome's 128 px): mark.ts `markVariantFor`.
 */
import { MARK, MARK_GRID } from '../../mark.js';
import type { MarkVariant } from '../../mark.js';

export function AppMark({ variant, size }: { variant: MarkVariant; size: number }) {
  return (
    <svg className="k-appmark" viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`} width={size} height={size} aria-hidden="true" focusable="false" data-variant={variant}>
      {MARK[variant].map((s) =>
        s.kind === 'path' ? (
          <path key={s.paint} className={`k-appmark-${s.paint}`} d={s.d} strokeWidth={s.stroke} strokeLinejoin="round" />
        ) : (
          <rect key={s.paint} className={`k-appmark-${s.paint}`} x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} strokeWidth={s.stroke} />
        ),
      )}
    </svg>
  );
}
