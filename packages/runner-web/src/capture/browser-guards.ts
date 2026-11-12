/**
 * The browser driver's guards and persona rules (L1.6, L1.7): the read-only write guard, the sign-in guard, the
 * persona a page is filmed as, an http hook's persona session, a js hook tab's landing, and the session check after a
 * step failed.
 */
import type { Page } from 'playwright-core';
import { loginMatchers, networkHost } from '@retake/core/environment';
import { personaPageOrigins } from '@retake/core/scenario';
import type { LoadedProject, TimelineWrite } from '@retake/core/model';
import type { PersonaPlan, ResolvedPersona, WritePolicy } from '@retake/core/environment';
import type { HookContext } from '@retake/core/hooks';
import { LoginGuard, checkPersona, signInMatchers } from '../auth.js';
import type { PreparedSession } from '../auth.js';
import { LoginPageError, RunnerError } from '../errors.js';
import { personaAuthReader } from '../persona-auth.js';
import type { PersonaRequestAuth } from '../persona-auth.js';
import type { Runtime } from '../runtime.js';
import type { LogLevel } from '../runtime.js';
import { StepFailure } from '../scenes.js';
import type { RunSecrets } from '../secrets.js';
import type { BrowserSession } from '../session.js';
import type { TimelineBuilder } from '../timeline.js';
import type { WriteGuardOptions } from '../write-guard.js';

/**
 * The write guard of a run (L1.7): each write it sees goes to `timeline.environment.writes` (capture time from capture
 * time 0 on); a stopped write warns once per request (`POST shop:/api/x`), a write to a host it does not watch once per
 * host, a WebSocket to a guarded host once per host; mocked / allowed writes and the sign-in's exempt ones are logged.
 * A read-write run's guard only stops writes to the hosts of the project's read-only environments.
 */
export function readOnlyGuard(
  policy: WritePolicy,
  o: {
    timeline: TimelineBuilder;
    log: (level: LogLevel, message: string) => void;
    captureStarted: () => boolean;
    /** Where the run is (capture time, scene / step): for messages from capture time 0 on. */
    where: () => string;
    pageId: (page: Page) => string | undefined;
  },
): WriteGuardOptions {
  const writes: TimelineWrite[] = [];
  if (o.timeline.environment) o.timeline.environment.writes = writes;
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    o.timeline.warn(message);
    o.log('warn', message);
  };
  const rules = [
    ...(policy.mocks.length ? [`${policy.mocks.length} mock${policy.mocks.length === 1 ? '' : 's'}`] : []),
    ...(policy.allow.length ? [`${policy.allow.length} allow entr${policy.allow.length === 1 ? 'y' : 'ies'}`] : []),
  ];
  const foreign = [...new Set(policy.protected.map((p) => p.env))].map((e) => `${e} (${policy.protected.filter((p) => p.env === e).map((p) => p.host).join(', ')})`);
  if (policy.readOnly) {
    o.log('info', `read-only run: writes to ${policy.hosts.includes('*') ? 'every host' : policy.hosts.join(', ')} are stopped${rules.length ? ` (${rules.join(', ')})` : ''}`);
  }
  if (foreign.length) o.log('info', `writes to the hosts of read-only environment${foreign.length > 1 ? 's' : ''} ${foreign.join(', ')} are stopped`);
  return {
    policy,
    onWrite: (w) => {
      const started = o.captureStarted();
      writes.push({
        ...(started ? { t: o.timeline.clock.now() } : {}),
        method: w.method,
        url: w.url,
        ...(w.operation ? { operation: w.operation } : {}),
        outcome: w.outcome,
        ...(w.rule ? { rule: w.rule } : {}),
        ...(w.status !== undefined ? { status: w.status } : {}),
        via: w.via,
        ...(w.protectedBy ? { protected_by: w.protectedBy } : {}),
      });
      const where = started ? o.where() : w.via === 'sign-in' ? 'the automated sign-in, before the capture started' : 'before the capture started';
      // A js hook tab says what it stopped itself (the hook is refused, or warned about).
      if (w.via === 'hook') return;
      if (w.outcome === 'exempt') {
        o.log('debug', `the automated sign-in sent ${w.label} (${where}) from its sign-in page: exempt from the write guard`);
        return;
      }
      if (w.outcome === 'blocked') {
        warnOnce(
          `blocked ${w.label}`,
          w.protectedBy
            ? `a write was stopped (${w.label}, ${where}): ${networkHost(w.url) ?? '?'} is a host of read-only environment ${w.protectedBy}, and this run is on environment ${policy.env} — the app may show an error`
            : `a write was stopped (${w.label}, ${where}): environment ${policy.env} is read-only — the app may show an error; answer it with a mock (\`mocks:\` of the scenario)`,
        );
      } else if (w.outcome === 'passed') {
        const host = networkHost(w.url) ?? '?';
        warnOnce(
          `passed ${host}`,
          `a write went to ${host} (${w.label}, ${where}), a host the read-only guard does not watch: it was sent — list ${host} in read_only.hosts of environment ${policy.env} if it writes your data`,
        );
      } else if (w.outcome === 'mocked') {
        o.log('info', `${w.label} (${where}): answered by the mock "${w.rule}" (HTTP ${w.status})`);
      } else {
        o.log('info', `${w.label} (${where}): let through by read_only.allow "${w.rule}"`);
      }
    },
    onWebSocket: (host, page) => {
      const id = o.pageId(page);
      warnOnce(
        `ws ${host}`,
        `${id ? `page ${id}: ` : ''}a WebSocket to ${host} is open — the read-only guard does not check its messages: writes sent over it are NOT stopped`,
      );
    },
  };
}

export function formatIssuePath(path: ReadonlyArray<string | number>): string {
  return path.reduce<string>((s, seg) => (typeof seg === 'number' ? `${s}[${seg}]` : s ? `${s}.${seg}` : seg), '');
}

/** The persona whose `pages` list an environment page (else the legacy one), or null. */
export function personaOfKey(personas: readonly ResolvedPersona[], key: string | undefined): string | null {
  if (key !== undefined) {
    const p = personas.find((x) => !x.legacy && x.pages.includes(key));
    if (p) return p.name;
  }
  return personas.find((x) => x.legacy)?.name ?? null;
}

/**
 * The persona a capture page id is created in: the static plan's, else (a page the plan did not foresee) its
 * environment page's persona, else none. Tabs are created in the realm of the page that opens them (session.newPage).
 */
export function personaOf(plan: PersonaPlan, personas: readonly ResolvedPersona[], env: { pages: Record<string, string> }, rt: () => Runtime | null): (id: string) => string | null {
  return (id) => {
    if (plan.pages.has(id)) return plan.pages.get(id) ?? null;
    const key = Object.hasOwn(env.pages, id) ? id : rt()?.declaredPages.get(id)?.page;
    return personaOfKey(personas, key);
  };
}

/** The persona an environment page is filmed as: the plan's binding of that page, else its default. */
function ownerOfKey(key: string, personas: readonly ResolvedPersona[], plan: PersonaPlan | null): string | null {
  return plan?.pages.has(key) ? (plan.pages.get(key) ?? null) : personaOfKey(personas, key);
}

/**
 * The environment page whose sign-in page a page of `persona` reached when that is another persona's app (a tab or a
 * link that left this persona's pages): its key and the persona it is filmed as. Null when the URL is on one of this
 * persona's pages (its own sign-in page: its session expired) or on no environment page.
 */
export function foreignSignIn(
  url: string,
  persona: string,
  envPages: Record<string, string>,
  personas: readonly ResolvedPersona[],
  plan: PersonaPlan | null,
): { key: string; owner: string | null } | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const keys = Object.keys(envPages).filter((k) => {
    try {
      return new URL(envPages[k]).origin === origin;
    } catch {
      return false;
    }
  });
  if (keys.length === 0 || keys.some((k) => ownerOfKey(k, personas, plan) === persona)) return null;
  return { key: keys[0], owner: ownerOfKey(keys[0], personas, plan) };
}

/**
 * The sign-in guard of a run (L1.6): a page filmed as a persona is guarded with that persona's sign-in patterns; a page
 * without one with the environment's (auth.login_url) unless written `persona: none` — or opened (new_tab) from such a
 * page. Null when there is nothing to watch.
 */
export function signInGuard(
  project: LoadedProject,
  env: { name: string; pages: Record<string, string> },
  personas: readonly ResolvedPersona[],
  plan: PersonaPlan,
  session: () => BrowserSession | null,
  o: { command: (persona: string) => string; hooksJustRan: () => boolean; redact: (t: string) => string; abort: (e: LoginPageError) => void },
): LoginGuard | null {
  const byPersona = new Map(personas.map((p) => [p.name, signInMatchers(project, env, p)]));
  const envMatchers = signInMatchers(project, env, null);
  if (envMatchers.length === 0 && [...byPersona.values()].every((m) => m.length === 0)) return null;
  // Pages seen as `persona: none` (a tab keeps it after its opener closed).
  const none = new WeakSet<Page>();
  const isNone = (id: string | undefined, page: Page, depth = 0): boolean => {
    if (none.has(page)) return true;
    const s = session();
    const opener = s?.openerOf(page);
    if ((id !== undefined && plan.none.has(id)) || (opener !== undefined && depth < 32 && s?.realmName(opener) === '' && isNone(s.idOf(opener), opener, depth + 1))) {
      none.add(page);
      return true;
    }
    return false;
  };
  return new LoginGuard({
    targetOf: (id, page) => {
      const realm = session()?.realmName(page);
      if (realm) return { persona: realm, matchers: byPersona.get(realm) ?? envMatchers };
      if (isNone(id, page)) return null;
      return { persona: null, matchers: envMatchers };
    },
    describe: ({ pageId, page, persona, url, what }) => {
      const s = session();
      const opener = s?.openerOf(page);
      const from = opener ? s?.idOf(opener) : undefined;
      const who = `${what ? `${what} on ` : ''}page "${pageId}"${persona ? ` (persona ${persona}${from ? `, opened from page "${from}"` : ''})` : from ? ` (opened from page "${from}")` : ''}`;
      const foreign = persona ? foreignSignIn(url, persona, env.pages, personas, plan) : null;
      return o.redact(
        `${who} landed on the sign-in page (${url}) — ` +
          (foreign
            ? `that is page "${foreign.key}", filmed ${foreign.owner ? `as persona ${foreign.owner}` : 'without a persona'}: a ${from ? 'tab keeps the persona of the page it is opened from' : 'page keeps one persona for the whole run'} — film "${foreign.key}" on its own page (\`page: ${foreign.key}\`, or \`switch_page: ${foreign.key}\`); nothing of the capture was kept`
            : persona
              ? `the session expired during the run${o.hooksJustRan() ? ' (a setup hook ran just before: it may have reset the sessions)' : ''}; nothing of the capture was kept. Sign in again: ${o.command(persona)}`
              : `this page has no persona: bind it to one (auth.personas.<name>.pages, or \`persona:\` on the scene); nothing of the capture was kept`),
      );
    },
    onLanding: (e) => o.abort(e),
  });
}

/**
 * `auth: {persona}` of an http hook: what the persona's browser of this run sends (persona-auth.ts). The plan signs in
 * every persona an http hook acts as (core planPersonas `hookAuth`), so its browser is there.
 */
export function hookPersonaAuth(
  personas: readonly ResolvedPersona[],
  env: { name: string; pages: Record<string, string> },
  session: BrowserSession,
  command: (persona: string) => string,
  /** Trust `mcp`: the session is read only for the persona's own pages' origins (persona-auth.ts `origins`). */
  ownPagesOnly = false,
): NonNullable<HookContext['personaAuth']> {
  const readers = new Map<string, (url: string) => Promise<PersonaRequestAuth>>();
  return async (name, url) => {
    const persona = personas.find((p) => p.name === name);
    if (!persona) throw new RunnerError(`persona "${name}" is not declared for environment "${env.name}" (personas: ${personas.map((p) => p.name).join(', ') || 'none'})`);
    if (!session.hasRealm(name)) throw new RunnerError(`persona ${name}: this run has no browser signed in as it (its hook is not one the run planned)`);
    let read = readers.get(name);
    if (!read) {
      read = personaAuthReader({ persona, context: () => session.contextOf(name), envPages: env.pages, relogin: command(name), ...(ownPagesOnly ? { origins: personaPageOrigins(persona.pages, env.pages) } : {}) });
      readers.set(name, read);
    }
    return read(url);
  };
}

/** A js hook tab's landing check: its persona's sign-in patterns (the guard's), or null when not guarded. */
export function hookLanding(
  guard: LoginGuard | null,
  personas: readonly ResolvedPersona[],
  env: { name: string; pages: Record<string, string> },
  session: BrowserSession,
  command: (persona: string) => string,
  expire: (persona: string, at: string, detail: string) => void,
): ((key: string, url: string) => string | null) | undefined {
  if (!guard) return undefined;
  return (key, url) => {
    const tab = session.hookPages.get(key);
    const persona = tab ? session.realmName(tab) : undefined;
    const p = personas.find((x) => x.name === persona);
    if (!p) return null;
    const m = loginMatchers(p.loginPatterns, env.pages).find((x) => x.test(url));
    if (!m) return null;
    const at = url.split(/[?#]/)[0];
    expire(p.name, at, `js hook page ${key} landed on the sign-in page`);
    return `js hook page "${key}" (persona ${p.name}) landed on the sign-in page (${at}): its session expired — sign in again: ${command(p.name)}`;
  };
}

/**
 * After a step failure on a persona's page, check that persona once (off camera, in its own browser; a cancel stops
 * it): when its session is no longer valid, the failure says so and how to fix it.
 */
export async function diagnoseSession(
  failure: StepFailure,
  session: BrowserSession,
  rt: Runtime | null,
  prepared: readonly PreparedSession[],
  envPages: Record<string, string>,
  secrets: RunSecrets,
  command: (persona: string) => string,
  signal: AbortSignal,
  expire: (persona: string, at: string, detail: string) => void,
): Promise<StepFailure> {
  const id = rt?.activeId;
  const page = id ? session.pages.get(id) : undefined;
  const realm = page && !page.isClosed() ? session.realmName(page) : undefined;
  const p = prepared.find((x) => x.persona.name === realm);
  if (!p?.persona.check) return failure;
  const r = await checkPersona(await session.contextOf(p.persona.name), p.persona, { envPages, kitSource: session.source, signal }).catch(() => null);
  if (!r || r.status !== 'expired') return failure;
  expire(p.persona.name, r.at ?? '', `${r.detail} (checked after step ${failure.scene}.${failure.step} failed)`);
  const message = `${failure.message} — the session of persona ${p.persona.name} is no longer valid (${secrets.redactText(r.detail)}): sign in again: ${command(p.persona.name)}`;
  return new StepFailure(message, failure.scene, failure.step, failure.action, failure.screenshot, failure.dom, failure.missing);
}
