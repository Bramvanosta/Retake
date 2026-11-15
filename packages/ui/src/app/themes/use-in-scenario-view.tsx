/**
 * The "Use in a scenario" section of the theme editor as it is drawn: the scenario select, its button and the line
 * that says what was written (with Open its timeline and Undo). Presentational: the writes are the editor's.
 */
import { Txt } from '../bits.js';
import { USE_SELECT } from './editor-chrome.js';
import { USE_IN_SCENARIO_WORDS } from '../words/theme-words.js';
import { Button, LinkButton, Select } from '../ui-kit/index.js';

export type UseState =
  | { s: 'idle' }
  | { s: 'busy' }
  | { s: 'done'; scenario: string; label: string; hash: string; previous: { text: string; hash: string } }
  | { s: 'already'; scenario: string }
  | { s: 'undone'; scenario: string }
  | { s: 'error'; message: string };

export function UseInScenarioView({
  slug,
  theme,
  scenarios,
  scenario,
  setScenario,
  st,
  onUse,
  onUndo,
}: {
  slug: string;
  theme: string;
  scenarios: string[];
  scenario: string;
  setScenario(s: string): void;
  st: UseState;
  onUse(): void;
  onUndo(d: Extract<UseState, { s: 'done' }>): void;
}) {
  return (
    <section className="tm-use" aria-labelledby="tm-use-h" data-testid="use-in-scenario">
      <h2 id="tm-use-h" className="tm-h2">
        Use in a scenario
      </h2>
      {scenarios.length === 0 ? (
        <p className="tm-quiet">This project has no scenario yet.</p>
      ) : (
        <>
          <div className="tm-use-line">
            <Select label="Scenario" layout="inline" id={USE_SELECT} value={scenario} onChange={setScenario} testId="use-scenario" options={scenarios.map((s) => ({ value: s, label: s }))} />
            <Button disabled={st.s === 'busy' || !scenario} onClick={onUse} data-testid="use-in-scenario-go">
              Use in this scenario
            </Button>
          </div>
          <p className="tm-quiet">
            <Txt text={`${USE_IN_SCENARIO_WORDS} The project's own theme stays as project.yaml names it.`} />
          </p>
        </>
      )}
      <div className="tm-line" role="status" aria-live="polite" data-testid="use-in-scenario-state">
        {st.s === 'busy' && 'Writing the scenario…'}
        {st.s === 'already' && (
          <>
            <Txt text={st.scenario} />
            {' already uses '}
            <Txt text={theme} />
            {'.'}
          </>
        )}
        {st.s === 'undone' && (
          <>
            {'Undone: '}
            <Txt text={st.scenario} />
            {' is back to the version before.'}
          </>
        )}
        {st.s === 'error' && (
          <span className="tm-failure">
            <Txt text={st.message} />
          </span>
        )}
        {st.s === 'done' && (
          <>
            <Txt text={st.label} />
            {'. '}
            <LinkButton size="sm" variant="ghost" to={{ name: 'timeline', slug, scenario: st.scenario }} testId="use-in-scenario-timeline">
              Open its timeline
            </LinkButton>{' '}
            <Button size="sm" onClick={() => onUndo(st)} data-testid="use-in-scenario-undo">
              Undo
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
