/**
 * A job in words, written once: what it does (jobWhat), how far a running one is (jobProgress) and what a finished one
 * produced (jobOutcome). The MCP server's and the Studio's summary line (job-lines.ts jobLine) and the terminal's
 * `retake jobs` (the CLI) compose them; each says a kind's words in one place.
 */
import type { JobInput } from '../jobs/job-input.js';
import type { JobProgress, JobResult } from '../jobs/types.js';

/** `n thing` / `n things`. */
function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "run quote (dry) on staging → 20261017-142233-quote", "hooks catalogue:setup", "sign-in of supplier (headed)"… */
export function jobWhat(i: JobInput): string {
  const on = 'env' in i && i.env ? ` on ${i.env}` : '';
  switch (i.kind) {
    case 'run':
      return `run ${i.scenario} (${i.mode})${on} → ${i.run_id}`;
    case 'hooks':
      return `hooks ${i.source}${i.dry ? ' (dry)' : ''}${on}`;
    case 'env_reset':
      return `env reset${i.dry ? ' (dry)' : ''}${on}`;
    case 'auth_login':
      return `sign-in of ${i.persona ?? 'the persona'} (${i.mode})${on}`;
    case 'sandbox_up':
      return `sandbox up${on}`;
    case 'sandbox_reset':
      return `sandbox reset${i.reseed ? ' (reseed)' : ''}${on}`;
    case 'render':
      return `render ${i.scenario} (run ${i.run_id}${i.template ? `, theme ${i.template}` : ''}) → ${i.render_id}`;
    case 'review':
      return `review ${i.render_id}${i.fps === 2 ? ' (2 fps)' : ''}`;
    case 'export':
      return `export ${i.render_id} → ${i.formats.join(', ')}`;
    case 'preview': {
      const t = i.target;
      const shown = t.kind === 'component' ? t.component : t.kind === 'library' ? count(t.items.length, 'library component') : 'the theme';
      return `preview of ${shown}${i.template ? ` (theme ${i.template})` : ''} → ${i.preview_id}`;
    }
    case 'inspect': {
      const s = i.source;
      const where = s.kind === 'page' ? `page ${s.page} ${s.path}` : `scenario ${s.scenario}${s.until ? ` until ${s.until}` : ''}`;
      return `inspect ${where}${on} → ${i.inspect_id}`;
    }
    case 'record':
      return `record ${i.scenario ?? 'a scenario'} from page ${i.source.page} ${i.source.path}${on} → ${i.rec_id}`;
    case 'site':
      return `site extraction of ${i.url} → ${i.site_id}`;
    default:
      return unknownKind(i);
  }
}

/** A running job's progress: a percent when the job knows it (a render, a review), else its steps or its phase. */
export function jobProgress(p: JobProgress): string {
  if (p.fraction !== undefined) return `${Math.round(p.fraction * 100)} %${p.phase ? ` · ${p.phase}` : ''}${p.eta_s !== undefined ? ` · ~${p.eta_s} s left` : ''}`;
  if (p.steps_total === 0 && !p.current && p.phase) return p.phase;
  const at = p.current ? ` · ${p.current.scene}.${p.current.step} ${p.current.action}` : p.phase ? ` · ${p.phase}` : '';
  return `${p.steps_done}/${p.steps_total} steps${at}`;
}

/**
 * What a finished job produced, in a few words. `brief`: the summary line's (no path); `full`: the terminal's, with the
 * file or folder it wrote and a few more details.
 */
export function jobOutcome(r: JobResult, form: 'brief' | 'full'): string {
  const full = form === 'full';
  const to = (where: string | null): string => (full && where ? ` → ${where}` : '');
  switch (r.kind) {
    case 'run':
      return `run ${r.status}${full ? ` · ${r.steps_done}/${r.steps_total} steps` : ''}`;
    case 'hooks':
    case 'env_reset':
      return r.ok ? 'ok' : 'with failures';
    case 'auth_login':
      return r.signed_in ? `signed in${full ? ` (${r.status})` : ''}` : `not signed in (${r.status})`;
    case 'render':
      return `${r.duration_s} s ${r.width}×${r.height}${to(r.file)}`;
    case 'review':
      return `${r.clean ? 'clean' : `${r.counts.error} errors, ${r.counts.warning} warnings`}${to(r.dir)}`;
    case 'export':
      return `${r.outputs.length} files${r.failed.length ? `, ${r.failed.length} failed` : ''}${to(r.dir)}`;
    case 'preview':
      return `${count(r.images.length, 'image')} (${r.theme} theme)${to(r.dir)}`;
    case 'inspect':
      return `${r.reported ? `${r.status}${r.counts ? `, ${r.counts.listed} elements listed` : ''}` : `not inspected (replay ${r.run_status})`}${to(r.dir)}`;
    case 'record':
      if (r.not_saved === 'nothing_recorded') return 'nothing recorded';
      if (full) return `${r.stats.steps} steps${r.saved ? ` → ${r.saved.file}` : ` (not saved: ${r.not_saved})`} · check ${r.check.status}`;
      return `${r.stats.steps} steps${r.saved ? ', saved' : ''}, check ${r.check.status}`;
    case 'site': {
      if (r.status !== 'ok') return `the page could not be read${to(r.dir)}`;
      const accent = full && r.palette ? `, accent ${r.palette.roles.accent ?? 'none'}` : '';
      return `${count(r.candidates.length, 'logo candidate')}${accent}${to(r.dir)}`;
    }
    case 'sandbox_up':
    case 'sandbox_reset':
      return r.reset ? `reset ${r.reset.strategy}` : 'up, no seed needed';
    default:
      return unknownKind(r);
  }
}

/** Exhaustiveness: a new kind fails to compile until it has its words. */
function unknownKind(x: never): string {
  return (x as { kind: string }).kind;
}
