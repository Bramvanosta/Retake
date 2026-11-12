/** The Record screen's browser (Shoot's, with the Recordings group). */
import { useSyncExternalStore } from 'react';
import { useProjectView } from '../project-data.js';
import { useRunLocation } from '../run-location.js';
import { contextWatch, scenarioInContext } from '../shell/modes.js';
import { ShellSlot } from '../shell/slots.js';
import { useScenarioActions } from '../shoot-data.js';
import { ShootBrowser } from '../ShootBrowser.js';
import type { ShootRecordings } from '../ShootBrowser.js';

/** The scenario in context on a Record route (the project's last one opened in this tab), for Shoot's browser. */
function useContextScenario(slug: string): string | null {
  useSyncExternalStore(contextWatch.subscribe, contextWatch.version);
  const project = useProjectView(slug);
  const known = project.state === 'ready' ? project.data.scenarios : undefined;
  return scenarioInContext({ name: 'record', slug }, undefined, known)?.scenario ?? null;
}

/** Shoot's browser on a Record route: Prepare and the runs of the scenario in context (the status bar's shared read), the Recordings. */
export function RecordBrowser({ slug, recordings }: { slug: string; recordings: ShootRecordings }) {
  const name = useContextScenario(slug);
  const project = useProjectView(slug);
  const envs = project.state === 'ready' ? project.data.environments : null;
  const loc = useRunLocation(slug, name, envs);
  const read = useScenarioActions(name !== null && loc.ready ? slug : null, name, loc.sent);
  return (
    <ShellSlot name="browser">
      <ShootBrowser slug={slug} name={name} runs={read.state === 'ready' ? read.data.runs : null} current={null} recordings={recordings} />
    </ShellSlot>
  );
}
