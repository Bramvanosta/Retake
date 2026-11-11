/**
 * What a job closed as interrupted says: why it stopped, what it left and the command that does it again (its `fix`,
 * starting with the queue's `cli`). Derived by the queue for a dead worker (queue-core.ts), written by the worker that
 * saw its job process die (worker.ts) and by a job process whose worker stopped (run-job-record.ts).
 */
import { stateRef } from '@retake/core';
import { submittedInStudio } from '../caller.js';
import type { JobRecord } from './types.js';

function shellWord(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A job closed as interrupted (derived for a dead worker; written by the worker that saw its job process die). */
export function interrupted(rec: JobRecord, cli: string, why: string): JobRecord {
  const i = rec.input;
  if (i.kind === 'site') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The site extraction stopped with its browser (files written before stay in .retake/site/${i.site_id}/); nothing else was touched`,
        fix: `${cli} theme from-site ${shellWord(i.url)}`,
      },
    };
  }
  if (i.kind === 'render') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The render stopped: nothing was written under ${i.render_id} (the next worker removes its temporary files and its browser)`,
        fix: `${cli} render ${i.project} ${i.scenario} --run ${i.run_id}${i.template ? ` --theme ${i.template}` : ''}`,
      },
    };
  }
  if (i.kind === 'review' || i.kind === 'export') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message:
          i.kind === 'review'
            ? `interrupted: ${why}. The review stopped: the previous review of ${i.render_id} is kept (the next worker puts it back and removes the temporary folder)`
            : `interrupted: ${why}. The export stopped: formats written before stay in exports/${i.render_id}/ (the next worker removes partial files and a re-render's browser)`,
        fix: i.kind === 'review' ? `${cli} review ${i.project} ${i.render_id}` : `${cli} export ${i.project} ${i.render_id} --formats ${i.formats.join(',')}`,
      },
    };
  }
  if (i.kind === 'preview') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The preview stopped: images written before stay in .retake/previews/${i.preview_id}/ (the next worker kills its browser)`,
        ...(i.target.kind === 'component' ? { fix: `${cli} components preview ${i.target.component}${i.template ? ` --theme ${i.template}` : ''} --out <folder>` } : {}),
      },
    };
  }
  if (i.kind === 'inspect') {
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message: `interrupted: ${why}. The inspection stopped: it ran a dry replay only (no hook); submit it again`,
        fix: `${cli} inspect ${i.project} ${i.source.kind === 'page' ? i.source.page : i.source.scenario}${i.env ? ` --env ${i.env}` : ''}`,
      },
    };
  }
  if (i.kind === 'record') {
    // Where it was (the job's last progress): from the draft on, the recording had ended and its draft was written.
    const phase = rec.progress?.phase ?? '';
    const folder = stateRef('records', i.rec_id);
    // A recording the Studio started is never saved by its job: the person saves it from the Record screen.
    const studio = submittedInStudio(i);
    const message = studio
      ? phase === 'check' || phase === 'draft'
        ? `interrupted: ${why}. The recording had ended: open it in the Studio's Record screen to look at its draft and save it`
        : `interrupted: ${why}. The recording stopped with it: what was recorded up to then is kept — open it in the Studio's Record screen to save it, or record again`
      : phase === 'check'
        ? `interrupted: ${why}. The recording had ended and its draft was made: ${folder}/draft.yaml (saved under scenarios/ too when its name was free); only its check replay was cut — dry-run the draft`
        : phase === 'draft'
          ? `interrupted: ${why}. The recording had ended; its draft was being made: ${folder}/draft.yaml if it was written (${folder}/events.jsonl holds what was recorded); record again if it is missing`
          : `interrupted: ${why}. The recording stopped with it: no draft was made (what was recorded up to then is in ${folder}/events.jsonl, if the window had opened); record again`;
    return {
      ...rec,
      state: 'interrupted',
      derived: true,
      error: {
        code: 'cancelled',
        message,
        fix: `${cli} record ${i.project}${i.scenario ? ` ${i.scenario}` : ''}${i.env ? ` --env ${i.env}` : ''}${i.persona ? ` --persona ${i.persona}` : ''} --page ${i.source.page}${i.source.path !== '/' ? ` --path ${shellWord(i.source.path)}` : ''}`,
      },
    };
  }
  const env = i.env ? ` --env ${i.env}` : '';
  const error: JobRecord['error'] =
    i.kind === 'auth_login'
      ? { code: 'cancelled', message: `interrupted: ${why}. The sign-in stopped with it: its session may not have been saved`, fix: `${cli} login ${i.project}${env}${i.persona ? ` --persona ${i.persona}` : ''}${i.mode === 'auto' ? ' --auto' : ''}` }
      : i.kind === 'sandbox_up' || i.kind === 'sandbox_reset'
        ? {
            code: 'cancelled',
            message: `interrupted: ${why}. Services it started may still run, and a seed it began is not recorded: the next sandbox up seeds again`,
            fix: `${cli} sandbox up ${i.project}${env}`,
          }
        : {
            code: 'cancelled',
            message: `interrupted: ${why}. ${i.kind === 'run' ? 'Its run' : 'It'} stopped where it was; rollbacks it left pending are replayed by an environment reset`,
            fix: `${cli} env reset ${i.project}${env}`,
          };
  return { ...rec, state: 'interrupted', derived: true, error };
}
