/**
 * A scenario's Hooks view (`#/p/<slug>/s/<name>/hooks`, the Script mode's third view beside Board and YAML) — what
 * the hooks do to the product around the take, on a page of its own, read from the scenario's blocks (scenario_blocks:
 * the same view as the board's): **Before filming** (the setup hooks in their order), **During the take, off camera**
 * (the named hooks a `hook:` step runs, each with the steps that call it), **After filming** (the teardown hooks, then
 * the rollbacks of what was done). Each hook: its kind, name, flags, what it does and its rollback in one line (core's
 * words: never a header or a body), "needs a person" when the Studio cannot run it — a capture of the scenario is then
 * refused here and the terminal asks (Prepare says how). The outcome of the run the board pictures, per phase. A
 * rehearsal skips every hook. Edited in the YAML view. Every value from data is text (Txt).
 */
import type { HookBlock } from '@retake/core/scenario';
import { Txt, plural, shown } from '../bits.js';
import { hrefTo } from '../route.js';
import type { View } from '../words/scenario-words.js';
import { Callout, LinkButton, StatusMark } from '../ui-kit/index.js';

function HookCard({ h, n }: { h: HookBlock; n?: number }) {
  return (
    <li className="cf-hook" data-testid="hook-card">
      <div className="cf-hook-head">
        {n !== undefined && <span className="cf-hook-n">{shown(String(n))}</span>}
        {h.name !== undefined ? <Txt className="cf-row-name" text={h.name} /> : <span className="sc-quiet">{shown(`hook ${h.index + 1}`)}</span>}
        <Txt className="cf-tag" text={h.kind ?? 'unknown'} />
        {h.flags.map((f) => (
          <Txt key={f.kind} className="cf-tag" text={f.label} />
        ))}
      </div>
      <Txt className="cf-code k-mono" text={h.summary} />
      {h.rollback && <Txt className="cf-code k-mono sc-quiet" text={`Rollback: ${h.rollback}`} />}
      {h.comment && <Txt className="sc-quiet" text={h.comment} />}
      {h.needs_person && (
        <p className="cf-needs">
          <strong className="sb-strong">Needs a person</strong>
          {': '}
          <Txt text={h.needs_person} />
        </p>
      )}
      {h.issues.map((i) => (
        <Txt key={`${i.path}:${i.message}`} className="sc-quiet" text={i.message} />
      ))}
    </li>
  );
}

/** The steps that run a named hook: "step 3 · scene 2" (the scene's number among the scenes). */
function callers(v: View, hook: string | undefined): string[] {
  if (hook === undefined) return [];
  const out: string[] = [];
  let n = 0;
  for (const e of v.blocks.entries) {
    if (e.type !== 'scene') continue;
    n += 1;
    for (const s of e.steps) {
      const args = s.args as { name?: unknown } | undefined;
      if (s.action === 'hook' && args?.name === hook) out.push(`step ${s.index + 1} · scene ${n}`);
    }
  }
  return out;
}

export function HooksView({ v, slug, name }: { v: View; slug: string; name: string }) {
  const { setup, teardown, named } = v.blocks.hooks;
  const outcome = v.source?.hooks;
  const needing = [...setup, ...named, ...teardown].filter((h) => h.needs_person);
  const rollbacks = [...setup, ...named].filter((h) => h.rollback);
  const none = setup.length + named.length + teardown.length === 0;
  // Named hooks grouped by their name (a name may run a list of hooks in order).
  const names = [...new Set(named.map((h) => h.hook))];
  return (
    <div className="cf" data-testid="hooks-view">
      <header className="cf-head">
        <h2 className="sc-h1">Hooks</h2>
        <p className="sc-quiet">What happens to the product around the take, in this order. A rehearsal skips all of it; a capture runs it. Edited in the YAML view.</p>
      </header>
      {needing.length > 0 && (
        <Callout state="attention" title={`${plural(needing.length, 'hook')} need${needing.length === 1 ? 's' : ''} a person`}>
          <p>A capture of this scenario is refused in the Studio until you run it from a terminal, which asks you first.</p>
          <LinkButton to={{ name: 'run', slug, scenario: name }} size="sm">
            See in Prepare
          </LinkButton>
        </Callout>
      )}
      {none ? (
        <p className="sc-quiet">No hook: the take films the product as it is.</p>
      ) : (
        <div className="cf-grid">
          <section className="cf-panel" aria-labelledby="hk-before" data-testid="hooks-before">
            <div className="cf-panel-head">
              <h3 id="hk-before" className="sc-h2">
                Before filming
              </h3>
              {outcome && <Txt className="sc-quiet" text={`in this run: ${outcome.setup}`} />}
            </div>
            {setup.length === 0 ? (
              <p className="sc-quiet">None: the camera starts on the product as it is.</p>
            ) : (
              <ol className="cf-hooks">
                {setup.map((h, i) => (
                  <HookCard key={h.index} h={h} n={i + 1} />
                ))}
              </ol>
            )}
          </section>
          <section className="cf-panel" aria-labelledby="hk-after" data-testid="hooks-after">
            <div className="cf-panel-head">
              <h3 id="hk-after" className="sc-h2">
                After filming
              </h3>
              {outcome && <Txt className="sc-quiet" text={`in this run: ${outcome.teardown}`} />}
            </div>
            {teardown.length === 0 ? (
              <p className="sc-quiet">No teardown hook.</p>
            ) : (
              <ol className="cf-hooks">
                {teardown.map((h, i) => (
                  <HookCard key={h.index} h={h} n={i + 1} />
                ))}
              </ol>
            )}
            {rollbacks.length > 0 && (
              <p className="sc-quiet">
                <Txt
                  text={`Then the rollbacks, in reverse order: ${rollbacks
                    .map((h) => h.name ?? h.hook ?? `hook ${h.index + 1}`)
                    .reverse()
                    .join(', ')}.`}
                />
              </p>
            )}
          </section>
          {named.length > 0 && <NamedHooks v={v} named={named} names={names.length} steps={outcome?.steps} />}
        </div>
      )}
      <p className="sc-quiet">
        {'Project-wide reset hooks and named hooks are in the project’s '}
        <a href={hrefTo({ name: 'settings', slug })}>Settings</a>
        {'.'}
      </p>
    </div>
  );
}

/** During the take, off camera: the named hooks as a table, each with the steps that call it. */
function NamedHooks({ v, named, names, steps }: { v: View; named: HookBlock[]; names: number; steps: string | undefined }) {
  return (
    <section className="cf-panel is-wide" aria-labelledby="hk-during" data-testid="hooks-during">
      <div className="cf-panel-head">
        <h3 id="hk-during" className="sc-h2">
          During the take, off camera
        </h3>
        <Txt className="sc-quiet" text={`${plural(names, 'named hook')}${steps ? ` · in this run: ${steps}` : ''}`} />
      </div>
      <table className="hk-table">
        <caption className="k-sr">Named hooks</caption>
        <thead>
          <tr>
            <th scope="col">Hook</th>
            <th scope="col">Kind</th>
            <th scope="col">What it does (variables as written)</th>
            <th scope="col">Called by</th>
          </tr>
        </thead>
        <tbody>
          {named.map((h) => {
            const by = callers(v, h.hook);
            return (
              <tr key={`${h.hook}-${h.index}`} data-testid="named-hook">
                <th scope="row" className="cf-row-name">
                  <Txt text={h.hook ?? h.name ?? ''} />
                </th>
                <td>
                  <Txt text={h.kind ?? 'unknown'} />
                </td>
                <td className="k-mono hk-what">
                  <Txt text={h.summary} />
                  {h.rollback && <Txt className="sc-quiet" text={` · rollback: ${h.rollback}`} />}
                  {h.needs_person && (
                    <span className="hk-needs">
                      <StatusMark state="attention" word="Needs a person" />
                      <Txt className="sc-quiet" text={` ${h.needs_person}`} />
                    </span>
                  )}
                </td>
                <td className="sc-quiet">
                  <Txt text={by.length > 0 ? by.join(', ') : 'no step calls it'} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
