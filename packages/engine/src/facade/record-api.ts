/** The façade's `inspect` (submit, read) and `record` (a recording: submit, and the Studio's Record screen) (createEngine). */
import { EngineError } from '../errors.js';
import { readInspection, submitInspectJob } from '../jobs/inspect-job.js';
import { readRecording, submitRecordJob } from '../jobs/record-job.js';
import { recordAnnotate, recordDiscard, recordList, recordSave, recordScreenRefused, recordStop, recordView } from '../record-studio.js';
import { chainsRecordings } from '../caller.js';
import type { EngineContext } from './context.js';
import type { Engine } from './types.js';

/** engine.inspect. */
export function inspectApi(ctx: EngineContext): Engine['inspect'] {
  const { ws, submitCtx, startWorker } = ctx;
  return {
    submit: async (req) => {
      const r = await submitInspectJob(submitCtx, req);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    get: (slug, id) => readInspection(ws, slug, id),
  };
}

/** engine.record: the Record screen's operations are the Studio's (and tests'). */
export function recordApi(ctx: EngineContext): Engine['record'] {
  const { opts, caller, ws, scope, project, queue, submitCtx, startWorker } = ctx;
  // L4.8: the Record screen's operations are the Studio's (and tests'): an agent starts a recording, never arranges one.
  const recordCtx = { queue, client: opts.client, scope, files: ctx.files, reads: ctx.ws.reads };
  let recordChain: Promise<unknown> = Promise.resolve();
  // The operations hold the same rule as their `callers` (L7.18, operations/record.ts); this copy stays for the
  // façade's direct callers (the engine's tests; the CLI calls none of these).
  const studioOnly = (what: string) => {
    const refused = recordScreenRefused(caller, what);
    if (refused) throw refused;
  };
  return {
    submit: async (req) => {
      // The Studio opens one window at a time in the workspace: checked and queued in one chain, so two tabs cannot
      // both pass the check (record_start, the engine's operation since L7.18, relies on this chain: it declares no key).
      const once = async () => {
        const busy = (await queue.list({ kinds: ['record'], states: ['queued', 'running'], limit: 1 }))[0];
        if (busy && busy.input.kind === 'record') {
          throw new EngineError(
            'conflict',
            `a recording is already ${busy.state === 'queued' ? 'waiting' : 'open'} in this workspace (project ${busy.input.project}): stop it first — one window at a time`,
            {
              details: { job: busy.id, project: busy.input.project, rec_id: busy.input.rec_id },
            },
          );
        }
        return submitRecordJob(submitCtx, req);
      };
      let r: Awaited<ReturnType<typeof submitRecordJob>>;
      if (chainsRecordings(caller)) {
        const next = recordChain.catch(() => undefined).then(once);
        recordChain = next;
        r = await next;
      } else r = await submitRecordJob(submitCtx, req);
      const worker = await startWorker();
      return { ...r, ...(worker ? { worker } : {}) };
    },
    get: (slug, id) => readRecording(ws, slug, id),
    view: async (slug, id, o = {}) => {
      studioOnly('record_view');
      return recordView(recordCtx, await project(slug), id, o);
    },
    annotate: async (slug, id, req) => {
      studioOnly('record_annotate');
      return recordAnnotate(recordCtx, await project(slug), id, req);
    },
    save: async (slug, id, req) => {
      studioOnly('record_save');
      return recordSave(recordCtx, await project(slug), id, req);
    },
    discard: async (slug, id, o = {}) => {
      studioOnly('record_discard');
      const r = await recordDiscard(recordCtx, await project(slug), id, o);
      if (r.state === 'discarding') await startWorker();
      return r;
    },
    stop: async (slug, id, o = {}) => {
      studioOnly('record_stop');
      const r = await recordStop(recordCtx, await project(slug), id, o);
      if (r.action !== 'none') await startWorker();
      return r;
    },
    list: async (slug, o = {}) => {
      studioOnly('the recent recordings list');
      return recordList(recordCtx, await project(slug), o);
    },
  };
}
