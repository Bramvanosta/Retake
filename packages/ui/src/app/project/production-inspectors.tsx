/**
 * The Project screen's inspector (ProductionsScreen.tsx picks one): the project with nothing selected (its facts, the
 * README's first lines, recent runs, Lately), a selected production (its facts, Open and Render, its Lately) or a
 * location (its pages, display URLs, flags and personas); and a production's poster, which the grid shows too.
 * Every value from data is text.
 */
import type { BoardScenario, ProjectView, RunListItem, RunStatusWithJob } from '@retake/engine';
import { useRunList } from '../data/projects.js';
import { Lately } from './Activity.js';
import { Txt, When, plural, shown } from '../bits.js';
import { APP_NAME } from '../brand.js';
import { contentWords, envFlagWords, lastTakeWords, lengthWords, posterTitle, productionState, reviewState } from '../words/board-words.js';
import { useProjectEvents } from '../events.js';
import { runShellCommand } from '../shell/command-bus.js';
import { NoThumb, Thumb } from '../Thumb.js';
import { Button, Facts, InspectorSection, LinkButton, Progress, StatusMark } from '../ui-kit/index.js';

const README_PREVIEW_LINES = 40;

/** What `run_status` said of the takes the board shows running (the screen's useRunning). */
export type LiveRuns = Map<string, Pick<RunStatusWithJob, 'status' | 'steps_done' | 'steps_total'>>;

export function Poster({ s, size }: { s: BoardScenario; size: 'poster' | 'inspector' }) {
  if (!s.poster) return <NoThumb size={size}>{s.last_run || s.running ? 'No picture yet' : 'Not shot yet'}</NoThumb>;
  return <Thumb run={s.poster.run} runKey={s.poster.key} size={size} alt={`The last pictured step of ${s.name}`} />;
}

function RunMark({ r }: { r: RunListItem }) {
  const w = lastTakeWords({ id: r.id, mode: r.mode === 'dry' ? 'dry' : 'capture', status: r.status, started_at: r.started_at, steps_done: r.steps_done, steps_total: r.steps_total });
  return <StatusMark state={w.state} word={w.words} />;
}

function RecentRuns({ slug }: { slug: string }) {
  const [runs, reload] = useRunList({ project: slug, limit: 5 }, slug);
  useProjectEvents(slug, reload);
  if (runs.state === 'loading') return <p className="sc-quiet">Loading the runs…</p>;
  if (runs.state === 'error') return <Txt className="sc-quiet" text={runs.error} />;
  if (runs.data.runs.length === 0) return <p className="sc-quiet">No run yet.</p>;
  return <RunRows runs={runs.data.runs} />;
}

/**
 * The rows of a list of runs. A row that is no run of the list — its run.json was written by a newer version, or does
 * not read as a record — shows its id and fixed words, never a field of a file that says nothing.
 */
export function RunRows({ runs }: { runs: readonly RunListItem[] }) {
  return (
    <ul className="pr-runs">
      {runs.map((r) =>
        r.newer ? (
          <li key={r.id} className="sc-quiet">
            <Txt className="k-mono" text={r.id} />
            {shown(`: written by a newer ${APP_NAME}`)}
          </li>
        ) : r.unread ? (
          <li key={r.id} className="sc-quiet">
            <Txt className="k-mono" text={r.id} />
            {shown(': its run.json does not read as a record')}
          </li>
        ) : (
          <li key={r.id} className="pr-run">
            <RunMark r={r} />
            <span className="sc-quiet">
              <Txt text={r.scenario} /> · <Txt text={r.env} /> · {shown(`${r.steps_done}/${r.steps_total} steps`)} · <When iso={r.started_at} /> · <Txt className="k-mono" text={r.id} />
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

/** The inspector with nothing selected: the project. */
export function ProjectInspector({ p }: { p: ProjectView }) {
  const lines = p.readme?.split('\n') ?? [];
  return (
    <>
      <InspectorSection title="Project">
        <Facts
          rows={[
            { key: 'name', label: 'Name', value: <Txt text={p.name} /> },
            { key: 'slug', label: 'Slug', value: <Txt className="k-mono" text={p.slug} /> },
            { key: 'folder', label: 'Folder', value: <Txt className="k-mono pr-path" text={p.dir} title={p.dir} /> },
            { key: 'scenarios', label: 'Productions', value: plural(p.scenarios.length, 'scenario') },
            { key: 'env', label: 'Location', value: p.default_env ? <Txt text={p.default_env} /> : 'none' },
          ]}
        />
      </InspectorSection>
      <InspectorSection title="README">
        {p.readme_error && (
          <div className="pr-alert" role="note">
            <StatusMark state="warn" word="Locked: README.md cannot be edited here" />
            <p className="pr-alert-text">
              <Txt text={p.readme_error} />
            </p>
          </div>
        )}
        {p.readme === null ? (
          !p.readme_error && <p className="sc-quiet">No README.md yet. It tells Claude the product, the audience, the goals and the tone.</p>
        ) : (
          <>
            {/* A scroller with a tab stop of its own (older engines do not focus scrollers). */}
            {/* biome-ignore lint/a11y/useSemanticElements: a scrolling <pre> (whitespace kept) needs its own tab stop to scroll by keyboard, and role=region names it */}
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling <pre> (whitespace kept) needs its own tab stop to scroll by keyboard, and role=region names it */}
            <pre className="pr-readme k-mono" data-testid="readme-preview" tabIndex={0} role="region" aria-label="README.md, the first lines">
              {shown(lines.slice(0, README_PREVIEW_LINES).join('\n'))}
            </pre>
            {lines.length > README_PREVIEW_LINES && <p className="sc-quiet">{shown(`${plural(lines.length - README_PREVIEW_LINES, 'more line')} in the editor.`)}</p>}
          </>
        )}
        <div>
          <LinkButton to={{ name: 'readme', slug: p.slug }} size="sm">
            {p.readme_error ? 'Open the README' : p.readme === null ? 'Write the README' : 'Edit the README'}
          </LinkButton>
        </div>
      </InspectorSection>
      <InspectorSection title="Recent runs">
        <RecentRuns slug={p.slug} />
      </InspectorSection>
      <InspectorSection title="Lately">
        <Lately project={p.slug} limit={6} label="Recent activity of the project" />
      </InspectorSection>
    </>
  );
}

/** The inspector of a selected production. */
export function ProductionInspector({ s, p, live, imported }: { s: BoardScenario; p: ProjectView; live: LiveRuns; imported?: string }) {
  const st = productionState(s);
  const running = s.running ? { ...s.running, ...(live.get(s.running.id) ?? {}) } : null;
  return (
    <>
      <InspectorSection title="Production">
        <div className="pr-poster-large">
          <Poster s={s} size="inspector" />
        </div>
        <div className="pr-title">
          <h3 className="sc-h3">
            <Txt text={posterTitle(s)} />
          </h3>
          <Txt className="k-mono sc-quiet" text={`${s.name}.yaml`} />
        </div>
        <StatusMark state={st.state} word={st.word} />
        {running && (
          <>
            <Progress
              label={running.mode === 'dry' ? 'Rehearsal' : 'Capture'}
              value={running.steps_done}
              max={Math.max(1, running.steps_total)}
              valueText={`${running.steps_done} of ${running.steps_total} steps`}
            />
            <div>
              <LinkButton to={{ name: 'run', slug: p.slug, scenario: s.name, run: running.id }} size="sm">
                Watch live
              </LinkButton>
            </div>
          </>
        )}
        <ProductionFacts s={s} p={p} />
        <div className="pr-actions">
          <LinkButton to={{ name: 'scenario', slug: p.slug, scenario: s.name, tab: 'blocks' }} variant="primary" testId="scenario-link">
            Open
          </LinkButton>
          {imported !== undefined ? (
            // An import not trusted: the server refuses its renders; the reason is the banner's (its command).
            <Button disabled why={`Imported, not trusted: a person runs ${imported} in a terminal first.`} data-testid="production-render">
              Render
            </Button>
          ) : s.capture ? (
            // (BL-128) Render acts — the status bar's own action on this production (the scenario in context).
            <Button data-testid="production-render" onClick={() => runShellCommand('render')}>
              Render
            </Button>
          ) : (
            <Button disabled why="No capture yet: a capture films the take a render edits.">
              Render
            </Button>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title="Lately">
        <Lately project={p.slug} scenario={s.name} limit={5} label={`Recent activity of ${s.name}`} />
      </InspectorSection>
    </>
  );
}

/** A production's facts: length, content, the file's issues, last take, capture, render, review and location. */
function ProductionFacts({ s, p }: { s: BoardScenario; p: ProjectView }) {
  const env = p.environments.find((e) => e.name === s.env);
  const last = s.last_run ? lastTakeWords(s.last_run) : null;
  const review = s.render ? reviewState(s.render.review) : null;
  return (
    <Facts
      rows={[
        { key: 'length', label: 'Length', value: s.length ? <span className="k-mono">{shown(lengthWords(s.length.seconds))}</span> : 'not shot yet' },
        { key: 'content', label: 'Content', value: contentWords(s.content) },
        ...(s.file.errors + s.file.warnings > 0 || !s.file.parsed
          ? [{ key: 'file', label: 'File', value: s.file.parsed ? `${plural(s.file.errors, 'error')}, ${plural(s.file.warnings, 'warning')}` : 'not valid YAML' }]
          : []),
        {
          key: 'take',
          label: 'Last take',
          value:
            last && s.last_run ? (
              <span>
                <StatusMark state={last.state} word={last.words} />
                {' · '}
                <When iso={s.last_run.finished_at ?? s.last_run.started_at} />
              </span>
            ) : (
              'none yet'
            ),
        },
        {
          key: 'capture',
          label: 'Capture',
          value: s.capture ? (
            <span>
              {shown(s.capture.current === true ? 'current' : s.capture.current === false ? 'the file changed since' : 'cannot tell')}
              {' · '}
              <When iso={s.capture.finished_at} />
            </span>
          ) : (
            'none yet'
          ),
        },
        {
          key: 'render',
          label: 'Render',
          value: s.render ? (
            <span>
              <When iso={s.render.created_at} />
              {' · '}
              <Txt text={s.render.theme} />
            </span>
          ) : s.render_failed ? (
            'the last one failed'
          ) : (
            'none yet'
          ),
        },
        { key: 'review', label: 'Review', value: review ? <StatusMark state={review.state} word={review.words} /> : 'none yet' },
        {
          key: 'location',
          label: 'Location',
          value: s.env ? (
            <span>
              <Txt text={s.env} />
              {env && envFlagWords(env, false) ? <span className="sc-quiet">{shown(` · ${envFlagWords(env, false)}`)}</span> : null}
            </span>
          ) : s.untrusted.env !== undefined ? (
            // The file names an environment the project does not have (as written, capped, said so).
            <span>
              <Txt text={s.untrusted.env} />
              <span className="sc-quiet">{' · not a location of this project'}</span>
            </span>
          ) : (
            'none'
          ),
        },
      ]}
    />
  );
}
