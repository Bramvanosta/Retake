/**
 * The scenario views' "Comments (N open)" tab (L4.6 part D1, critique B8 / C2): the scenario's open threads counted from
 * the thread files alone (`threads_counts`: no render read, no view built), read again when that scenario's comments
 * change (commentsEventAction) or after a reconnection. A count that cannot be read leaves the plain tab.
 */
import { useCall } from './api.js';
import { commentsEventAction, useEvents } from './events.js';
import { hrefTo } from './route.js';

interface Counts {
  scenarios: Record<string, { open: number; resolved: number }>;
}

export function CommentsTab({ slug, name, current = false }: { slug: string; name: string; current?: boolean }) {
  const [counts, reload] = useCall<Counts>('threads_counts', { project: slug, name }, `${slug}\0${name}`);
  useEvents((e) => {
    if (commentsEventAction(e, slug, name).threads) reload();
  });
  const open = counts.state === 'ready' ? (counts.data.scenarios[name]?.open ?? 0) : null;
  return (
    <a href={hrefTo({ name: 'comments', slug, scenario: name })} aria-current={current ? 'page' : undefined} className={current ? 'tab current' : 'tab'} data-testid="comments-tab" data-open={open ?? ''}>
      Comments{open !== null ? ` (${open} open)` : ''}
    </a>
  );
}
