/**
 * Prepare's checks (ShootPrepare.tsx): the title bar's Location choice, what does not load, and the Location, Sessions
 * and live picture items of the checklist; the reads' types the screen's parts share.
 */
import type { Loaded, OpResult } from '../api.js';
import { Txt, shown } from '../bits.js';
import { envFlagWords } from '../words/board-words.js';
import { reloadProject } from '../project-data.js';
import type { useProjectView } from '../project-data.js';
import { chooseLocation } from './run-location.js';
import { SessionRows } from '../project/Sessions.js';
import type { useScenarioActions } from './shoot-data.js';
import { Callout, ChecklistItem, Select, Switch } from '../ui-kit/index.js';

export type ProjectRead = ReturnType<typeof useProjectView>;
export type ActionsRead = ReturnType<typeof useScenarioActions>;
export type ActionsData = Extract<ActionsRead, { state: 'ready' }>['data'];
export type Running = NonNullable<ActionsData['running']>;
export type Env = Extract<ProjectRead, { state: 'ready' }>['data']['environments'][number];
export type SessionsRead = Loaded<OpResult<'scenario_sessions'>>;
export type ToConfirm = Extract<SessionsRead, { state: 'ready' }>['data']['confirm'];
export type Mode = 'dry' | 'capture';
export const TERMINAL_WHY = 'Started in a terminal: press Ctrl-C there to stop it.';

/** The Sessions item's state and word. */
function sessionsStep(sessions: SessionsRead, toConfirm: ToConfirm): { state: 'ok' | 'attention' | 'idle'; word: string } {
  return sessions.state !== 'ready'
    ? { state: 'idle', word: 'Pending' }
    : sessions.data.personas.length === 0
      ? { state: 'ok', word: 'Ready: none needed' }
      : toConfirm.length > 0 || sessions.data.issues.length > 0
        ? { state: 'attention', word: 'Pending: a capture asks first' }
        : { state: 'ok', word: 'Ready' };
}

/** The title bar's Location choice: one per scenario in this tab, sent only when it is not the file's own. */
export function LocationSelect({ slug, name, environments, value, fileDefault }: { slug: string; name: string; environments: Env[]; value: string; fileDefault: string | undefined }) {
  return (
    <Select
      layout="inline"
      label="Location"
      testId="location-select"
      value={value}
      options={environments.map((e) => {
        const flags = envFlagWords(e, e.name === fileDefault, e.name);
        return { value: e.name, label: `${e.name}${flags ? ` · ${flags}` : ''}` };
      })}
      onChange={(next) => chooseLocation(slug, name, next === fileDefault ? undefined : next)}
    />
  );
}

/** What does not load, or a location chosen earlier that is gone. */
export function LoadNotices({ dropped, fileDefault, project, actions }: { dropped: string | undefined; fileDefault: string | undefined; project: ProjectRead; actions: ActionsRead }) {
  return (
    <>
      {dropped !== undefined && (
        <Callout state="warn" title="A location chosen earlier is gone" testId="location-dropped">
          <Txt text={`The location ${dropped} chosen earlier is no longer in project.yaml: the runs use the file's own${fileDefault ? `, ${fileDefault}` : ''}.`} />
        </Callout>
      )}
      {project.state === 'error' && (
        <Callout state="fail" role="alert" title="This project cannot be read" testId="prepare-failed">
          <p className="sb-pre">
            <Txt text={project.error} />
          </p>
        </Callout>
      )}
      {project.state !== 'error' && actions.state === 'error' && (
        <Callout state="fail" role="alert" title="This scenario cannot be read" testId="prepare-failed">
          <p className="sb-pre">
            <Txt text={actions.error} />
          </p>
        </Callout>
      )}
    </>
  );
}

/** The Location check: its flags in words, its pages and what the video shows instead. */
export function LocationItem({ env, fileDefault, sent, projectFailed }: { env: Env | undefined; fileDefault: string | undefined; sent: string | undefined; projectFailed: boolean }) {
  return (
    <ChecklistItem
      state={env ? (env.production || env.access === 'read-only' ? 'warn' : 'ok') : projectFailed ? 'fail' : 'idle'}
      word={env ? (env.access === 'read-only' ? 'Ready · read-only' : env.production ? 'Ready · production' : 'Ready') : projectFailed ? 'Cannot be read' : 'Pending'}
      title="Location"
      testId="preflight-location"
      level={2}
    >
      {env ? (
        <>
          <p>
            <Txt text={`${env.name}${envFlagWords(env, env.name === fileDefault, env.name) ? ` · ${envFlagWords(env, env.name === fileDefault, env.name)}` : ''}`} />
            {sent ? <Txt text=" — chosen in this tab (the file's own is " /> : null}
            {sent && fileDefault ? <Txt text={`${fileDefault}).`} /> : null}
          </p>
          <ul className="sp-pages">
            {Object.entries(env.pages).map(([k, url]) => (
              <li key={k}>
                <Txt className="k-mono" text={k} />
                {' · '}
                <Txt className="k-mono" text={url} />
                {env.display?.[k] && <Txt className="sc-quiet" text={` · shown as ${env.display[k]}`} />}
              </li>
            ))}
          </ul>
          <p className="sc-quiet">Change it in the title bar.</p>
        </>
      ) : projectFailed ? (
        <p className="sc-quiet">The project does not load: see above.</p>
      ) : (
        <p className="sc-quiet">Reading the project…</p>
      )}
    </ChecklistItem>
  );
}

/** The Sessions check: each persona's last known state with Sign in…, the issues, and "a capture asks first". */
export function SessionsItem({ slug, name, sessions, toConfirm, reloadSessions }: { slug: string; name: string; sessions: SessionsRead; toConfirm: ToConfirm; reloadSessions: () => void }) {
  const sessionsState = sessionsStep(sessions, toConfirm);
  return (
    <ChecklistItem state={sessionsState.state} word={sessionsState.word} title="Sessions this run signs in with" testId="preflight-sessions" level={2}>
      {sessions.state === 'loading' && <p className="sc-quiet">Reading the sessions…</p>}
      {sessions.state === 'error' && <Txt text={sessions.error} />}
      {sessions.state === 'ready' && (
        <>
          {sessions.data.personas.length === 0 ? (
            <p>
              <Txt text={`None needed on ${sessions.data.env}: the run opens the pages signed out.`} />
            </p>
          ) : (
            <>
              <p className="sc-quiet">The last known state of each (no browser is opened to read it). Before it films, every run checks again each session that has a check.</p>
              <SessionRows
                slug={slug}
                rows={sessions.data.personas}
                showEnv={false}
                issues={sessions.data.issues}
                onChanged={() => {
                  reloadSessions();
                  reloadProject('auth_status', slug);
                }}
                caption={`Sessions ${name} signs in`}
              />
            </>
          )}
          {sessions.data.issues.map((i, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the sessions read's issues, replaced whole on each read, text only: the index is the identity
            <Callout key={n} state="warn" role="note" title="A page has no persona a run could use">
              <p className="sb-pre">
                <Txt text={i} />
              </p>
            </Callout>
          ))}
          {toConfirm.length > 0 && (
            <p data-testid="preflight-confirm-note">
              {shown(`A capture asks first: ${toConfirm.length === 1 ? 'one persona has' : `${toConfirm.length} personas have`} no valid session that a run could renew by itself.`)}
            </p>
          )}
        </>
      )}
    </ChecklistItem>
  );
}

/** The live picture check: a per-tab switch, off by default. */
export function PictureItem({ picture, setPicture }: { picture: boolean; setPicture: (on: boolean) => void }) {
  return (
    <ChecklistItem state={picture ? 'ok' : 'idle'} word={picture ? 'On · ready' : 'Off'} title="Live picture during a capture" level={2}>
      <Switch
        label="Show the live picture from the capture's start"
        hint="Off by default: drawing it costs Chromium CPU during the take (about 15 % more)."
        checked={picture}
        onChange={setPicture}
        testId="prep-picture"
      />
    </ChecklistItem>
  );
}
