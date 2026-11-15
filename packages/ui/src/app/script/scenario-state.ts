/**
 * The scenario screen's state: the one resolved selection, the lines a browser row stands for, what the status bar is
 * fed, the step moves of the board and the inspector, and the location (ScenarioScreen.tsx calls these in its order).
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import type { EntryBlock, SceneBlock } from '@retake/core/scenario';
import { envFlagWords } from '../words/board-words.js';
import type { useProjectView } from '../project-data.js';
import type { RendersState } from '../review/Renders.js';
import { useFeedActions, useShownFile } from '../shoot/shoot-data.js';
import type { FedActions } from '../shoot/shoot-data.js';
import { keyboardMove } from './step-edit.js';
import type { SceneSlots } from './step-edit.js';
import type { useStepEditor } from './StepEditing.js';
import type { Selected, StepMoves } from './ScenarioInspector.js';
import type { BoardMoves, Subject } from './board-state.js';
import type { RunLocation } from '../shoot/TakeStrip.js';
import type { View } from '../words/scenario-words.js';

/**
 * What the board's selection is, resolved against the view — ONE value drives the board's marks, the browser's row and
 * the inspector. Nothing picked yet: the first step. A picked step, scene or card that is no longer in the
 * file is never replaced by another step (whose Delete the person would not expect): a gone step leaves its scene
 * selected, else the video; a gone scene or card, the video. `subject` is the resolved selection as a Subject.
 */
export function resolveSelection(v: View, subject: Subject | null): { sel: Selected; subject: Subject } {
  const scenes = v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene');
  const no = (s: SceneBlock) => scenes.indexOf(s) + 1;
  const video = { sel: { kind: 'video' } as Selected, subject: { kind: 'video' } as Subject };
  const sceneOf = (s: SceneBlock) => ({ sel: { kind: 'scene', scene: s, sceneNo: no(s) } as Selected, subject: { kind: 'scene', id: s.id } as Subject });
  if (subject === null) {
    const s = scenes.find((x) => x.steps.length > 0);
    return s ? { sel: { kind: 'step', scene: s, step: s.steps[0], sceneNo: no(s) }, subject: { kind: 'step', key: s.steps[0].key } } : video;
  }
  switch (subject.kind) {
    case 'step': {
      for (const s of scenes) {
        const st = s.steps.find((x) => x.key === subject.key);
        if (st) return { sel: { kind: 'step', scene: s, step: st, sceneNo: no(s) }, subject };
      }
      // The step's key is "<scene>.<index>": its scene, when it is still there.
      const gone = scenes.find((s) => subject.key.startsWith(`${s.id}.`) && /^\d+$/.test(subject.key.slice(s.id.length + 1)));
      return gone ? sceneOf(gone) : video;
    }
    case 'scene': {
      const s = scenes.find((x) => x.id === subject.id);
      return s ? { ...sceneOf(s), subject } : video;
    }
    case 'entry': {
      const e = v.blocks.entries.find((x): x is Exclude<EntryBlock, SceneBlock> => x.index === subject.index && x.type !== 'scene');
      return e ? { sel: { kind: 'entry', entry: e }, subject } : video;
    }
    default:
      return { sel: { kind: subject.kind }, subject };
  }
}

/** Two selections are the same. */
function sameSubject(a: Subject, b: Subject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The lines a browser row stands for in the YAML view. */
export function rangeOf(v: View, s: Subject): { line: number; end_line: number } | null {
  if (s.kind === 'video') return { line: 1, end_line: 1 };
  if (s.kind === 'before' || s.kind === 'after') {
    const hs = s.kind === 'before' ? v.blocks.hooks.setup : v.blocks.hooks.teardown;
    const first = hs.find((h) => h.range)?.range;
    const last = [...hs].reverse().find((h) => h.range)?.range;
    return first && last ? { line: first.line, end_line: last.end_line } : null;
  }
  const e = s.kind === 'scene' ? v.blocks.entries.find((x) => x.type === 'scene' && x.id === s.id) : s.kind === 'entry' ? v.blocks.entries.find((x) => x.index === s.index) : undefined;
  return e?.range ? { line: e.range.line, end_line: e.range.end_line } : null;
}

/** What the status bar acts on, fed from this screen's reads, and the file it shows. */
export function useFeed({ slug, name, vNow, renders, sentEnv, live }: { slug: string; name: string; vNow: View | null; renders: RendersState; sentEnv: string | undefined; live: FedActions['live'] }) {
  const renderJob = renders.loaded.state === 'ready' ? renders.loaded.data.jobs[0] : undefined;
  const fedData = useMemo<FedActions | null>(() => {
    if (!vNow) return null;
    const cap = vNow.capture;
    return {
      hash: vNow.hash,
      ok: vNow.ok,
      environment: vNow.environment,
      run_blockers: vNow.run_blockers,
      runs: vNow.runs,
      running: vNow.running,
      ...(cap ? { capture: cap } : {}),
      ...(renderJob ? { render_job: { job: renderJob.id, state: renderJob.state, ...(renderJob.fraction !== undefined ? { fraction: renderJob.fraction } : {}) } } : {}),
      env: sentEnv,
      live,
    };
  }, [vNow, renderJob, sentEnv, live]);
  useFeedActions(slug, name, fedData);
  useShownFile(slug, name, vNow?.hash ?? null);
}

/**
 * The one resolved selection: what the board marks and the inspector shows. A picked subject that went
 * away is replaced by its resolution in the state too — unless something else was picked meanwhile.
 */
export function useResolvedSelection(v: View | null, subject: Subject | null, setSubject: (s: (cur: Subject | null) => Subject | null) => void) {
  const resolved = useMemo(() => (v ? resolveSelection(v, subject) : null), [v, subject]);
  const effective = resolved?.subject ?? null;
  useEffect(() => {
    if (subject === null || effective === null || sameSubject(subject, effective)) return;
    setSubject((cur) => (cur === subject ? effective : cur));
  }, [subject, effective, setSubject]);
  return { resolved, effective };
}

/** The step edits the keys, drag & drop and the inspector's buttons send (one place: the verified write path). */
export function useBoardMoves(v: View | null, edRef: MutableRefObject<ReturnType<typeof useStepEditor>>) {
  const scenes = useMemo(() => (v ? v.blocks.entries.filter((e): e is SceneBlock => e.type === 'scene') : []), [v]);
  const slots: SceneSlots[] = useMemo(() => scenes.map((s) => ({ id: s.id, count: s.steps.length, locked: s.steps_locked !== undefined })), [scenes]);
  const refOf = useCallback(
    (k: string) => {
      for (const s of scenes) {
        const st = s.steps.find((x) => x.key === k);
        if (st) return st.guard !== undefined ? { scene: s.id, index: st.index, guard: st.guard, locked: st.locked !== undefined } : null;
      }
      return null;
    },
    [scenes],
  );
  const boardMoves: BoardMoves = useMemo(
    () => ({
      move: (k, dir) => {
        const at = refOf(k);
        if (!at || at.locked) return;
        const to = keyboardMove(slots, at, dir);
        if (to) edRef.current.send({ kind: 'move_step', from: { scene: at.scene, index: at.index, guard: at.guard }, to });
        // A key that moves nothing says so (the live region kept the last edit's words).
        else edRef.current.say(`Step ${at.index + 1} of ${at.scene} is already the ${dir < 0 ? 'first' : 'last'} step: it cannot move ${dir < 0 ? 'up' : 'down'}.`);
      },
      act: (k, kind) => {
        const at = refOf(k);
        if (at && !at.locked) edRef.current.send({ kind, at: { scene: at.scene, index: at.index, guard: at.guard } });
      },
    }),
    [refOf, slots, edRef],
  );
  return { scenes, slots, boardMoves };
}

/** The inspector's Move up / Move down / Duplicate / Delete for the selected step (each remembers its button). */
export function stepMovesOf(sel: Selected, slots: SceneSlots[], boardMoves: BoardMoves, editFrom: MutableRefObject<string | null>): StepMoves {
  return sel.kind === 'step'
    ? {
        up: keyboardMove(slots, { scene: sel.scene.id, index: sel.step.index }, -1) !== null,
        down: keyboardMove(slots, { scene: sel.scene.id, index: sel.step.index }, 1) !== null,
        move: (dir) => {
          editFrom.current = dir < 0 ? 'up' : 'down';
          boardMoves.move(sel.step.key, dir);
        },
        act: (kind) => {
          editFrom.current = kind === 'delete_step' ? 'delete' : 'duplicate';
          boardMoves.act(sel.step.key, kind);
        },
      }
    : { up: false, down: false, move: () => undefined, act: () => undefined };
}

export type ProjectData = Extract<ReturnType<typeof useProjectView>, { state: 'ready' }>['data'];

/**
 * The location: the file's own, else the project's default; a choice is sent only when it differs. Only a
 * location project.yaml has is ever shown or sent: the select and the strip say the same one.
 */
export function locationOf(v: View, p: ProjectData | null, envs: ProjectData['environments'] | null, sentEnv: string | undefined) {
  // A project without default_env runs on its first environment (core resolveEnvironment): that is the file's own then.
  const fileDefault = v.blocks.video.env ?? p?.default_env ?? p?.environments[0]?.name;
  const envList = envs ?? [];
  const known = (n: string | undefined): n is string => n !== undefined && (envList.length === 0 || envList.some((e) => e.name === n));
  const current = [sentEnv, v.environment?.name, fileDefault].find(known);
  const currentEnv = envList.find((e) => e.name === current);
  const chosen = sentEnv !== undefined && sentEnv !== fileDefault;
  const runLocation: RunLocation | null = current ? { name: current, flags: currentEnv ? envFlagWords(currentEnv, false, current) : '', chosen, ...(fileDefault ? { fileDefault } : {}) } : null;
  // The Video inspector's Location row: the file's own, and the tab's choice beside it when it differs.
  const fileEnv = fileDefault ?? (sentEnv === undefined ? v.environment?.name : undefined);
  const fileEnvFlags = envList.find((e) => e.name === fileEnv);
  const videoLocation = { file: fileEnv, fileFlags: fileEnvFlags ? envFlagWords(fileEnvFlags, false, fileEnv) : '', ...(chosen && current ? { chosen: current } : {}) };
  return { fileDefault, envList, current, runLocation, videoLocation };
}
