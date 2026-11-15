/**
 * Which persona films which page (static plan): every page a run films bound to a persona the way the run walks the
 * scenario, the js hook tabs, and the personas its http hooks act as. Pure; shared by the validation and the runner.
 */
import { formatPath } from './issues.js';
import type { IssuePath } from './issues.js';
import { isAbsoluteUrl, scenePageEntries, splitPageOpen } from './pages.js';
import { isCaptureScene } from './types/language.js';
import type { Scenario } from './types/scenario.js';
import type { Scene } from './types/language.js';

/** `persona: none` — a page filmed without any persona (a fresh browser, never guarded). */
export const PERSONA_NONE = 'none';
/** The implicit persona of the legacy `auth.profile` / `auth.storage_state` form. */
export const LEGACY_PERSONA = 'default';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A binding problem found by the plan, positioned in the scenario. */
export interface PersonaIssue {
  path: IssuePath;
  message: string;
  /** unknown: a persona the environment does not declare; placement: `persona` where it does not belong; conflict: a page asked for two personas. */
  kind: 'unknown' | 'placement' | 'conflict';
}

/** Which persona each page of a run is signed in as (core planPersonas). */
export interface PersonaPlan {
  /** Capture page id → persona (null: no persona, the run's default browser). */
  pages: Map<string, string | null>;
  /** Pages written `persona: none` (never guarded). */
  none: Set<string>;
  /** js hook tabs (environment page key) → persona. */
  hookPages: Map<string, string | null>;
  /** The personas the run signs in (checked by the preflight), in declaration order. */
  used: string[];
  /** The personas its http hooks act as (`auth: {persona}`): signed in like the filmed ones, each in its own browser. */
  hookAuth: string[];
  /** Some page or hook tab runs without a persona (the default browser is needed). */
  needsDefault: boolean;
  issues: PersonaIssue[];
}

export interface PlanPersonasOptions {
  env: string;
  /** The environment's pages (page key → base URL). */
  envPages: Record<string, string>;
  /** The environment's personas (core ResolvedPersona: its name, pages and legacy flag). */
  personas: readonly { name: string; pages: string[]; legacy: boolean }[];
  /** The last step the run executes (`--until`): later scenes and steps are not walked. */
  until?: { sceneIndex: number; stepIndex: number } | null;
  /** Whether the setup / teardown hooks run (their js tabs need a persona too). */
  hooks: boolean;
  /** project.yaml's named hooks: the ones the scenario's `hook:` steps run may act as a persona (`auth: {persona}`). */
  projectHooks?: Record<string, unknown>;
}

/**
 * Bind every page a run films to a persona, the way the run walks the scenario: a single-page scene films `page`
 * (default: the previous scene's page, else the first environment page), `open: {page}` and `switch_page` move to a
 * page (`previous`: the page shown before, as the run's page history), `new_tab` opens a tab of the page it is on (same
 * persona — a tab of a `persona: none` page is never guarded either), a multi-page scene films each of its `pages`. A
 * page's persona is fixed the first time it is filmed: its `persona` (scene, or `pages.<id>.persona`), else the first
 * persona declared whose `pages` list its environment page (several may: one app, several roles), else the legacy `default` persona, else none; `persona: none` written later
 * on a page filmed without one leaves it unguarded. A page asked for another persona later is an error (it keeps one
 * for the whole run, like its viewport). A js hook tab takes the persona its page is filmed with, else its default.
 * Skipped scenes and what comes after `--until` are not walked. In an environment without personas nothing is bound
 * (`persona` keys are ignored).
 */
export function planPersonas(sc: Scenario, opts: PlanPersonasOptions): PersonaPlan {
  const b = new PersonaBinder(opts);
  const plan = b.plan;
  if (opts.personas.length === 0) {
    plan.needsDefault = true;
    return plan;
  }
  walkScenes(sc, opts.until, b);
  if (opts.hooks) planHookPages(sc, b);
  const hookAuth = opts.hooks ? planHookAuth(sc, opts, b) : new Set<string>();
  plan.hookAuth = opts.personas.map((p) => p.name).filter((n) => hookAuth.has(n));
  const used = new Set<string>(hookAuth);
  for (const p of [...plan.pages.values(), ...plan.hookPages.values()]) {
    if (p === null) plan.needsDefault = true;
    else used.add(p);
  }
  if (plan.pages.size === 0) plan.needsDefault = true;
  plan.used = opts.personas.map((p) => p.name).filter((n) => used.has(n));
  return plan;
}

/** `inherit`: a tab takes the persona (and the `none`) of the page it is opened from; any other page its default. */
type Inherit = { persona: string | null; none: boolean } | { envKey: string | undefined };

/** The plan being built: each page bound once (its first binding holds; another persona asked later is a conflict). */
class PersonaBinder {
  readonly plan: PersonaPlan = { pages: new Map(), none: new Set(), hookPages: new Map(), used: [], hookAuth: [], needsDefault: false, issues: [] };
  readonly envKeys: string[];
  readonly names: Set<string>;
  /** Environment page key of each multi-page scene page id. */
  readonly declaredEnv = new Map<string, string>();
  private readonly legacy: string | null;
  private readonly firstSite = new Map<string, IssuePath>();
  private tabSeq = 1;

  constructor(private readonly opts: PlanPersonasOptions) {
    this.envKeys = Object.keys(opts.envPages);
    this.names = new Set(opts.personas.map((p) => p.name));
    this.legacy = opts.personas.some((p) => p.legacy) ? LEGACY_PERSONA : null;
  }

  defaultOf(envKey: string | undefined): string | null {
    if (envKey !== undefined) {
      const p = this.opts.personas.find((x) => !x.legacy && x.pages.includes(envKey));
      if (p) return p.name;
    }
    return this.legacy;
  }

  private valid(persona: string, path: IssuePath): boolean {
    if (persona === PERSONA_NONE || this.names.has(persona)) return true;
    this.plan.issues.push({
      path,
      kind: 'unknown',
      message: `persona "${persona}" is not declared for environment "${this.opts.env}" (personas: ${[...this.names].join(', ')}; or ${PERSONA_NONE})`,
    });
    return false;
  }

  bind(id: string, explicit: string | undefined, inherit: Inherit, path: IssuePath): void {
    const plan = this.plan;
    if (explicit !== undefined && !this.valid(explicit, path)) return;
    const want = explicit === undefined ? undefined : explicit === PERSONA_NONE ? null : explicit;
    if (plan.pages.has(id)) {
      const have = plan.pages.get(id) ?? null;
      if (want !== undefined && want !== have) {
        const where = this.firstSite.get(id);
        plan.issues.push({
          path,
          kind: 'conflict',
          message:
            `page "${id}" is filmed ${have === null ? 'without a persona' : `as ${have}`}${where ? ` since ${formatPath(where)}` : ''} and ` +
            `${want === null ? 'without one' : `as ${want}`} here: a page keeps one persona for the whole run — film the other account on a page id of its own (a multi-page scene's \`pages\`)`,
        });
      } else if (explicit === PERSONA_NONE) {
        // Filmed without a persona so far, written `persona: none` now: never guarded (a page keeps one binding).
        plan.none.add(id);
      }
      return;
    }
    const persona = want !== undefined ? want : 'persona' in inherit ? inherit.persona : this.defaultOf(inherit.envKey);
    plan.pages.set(id, persona);
    this.firstSite.set(id, path);
    if (explicit === PERSONA_NONE || (want === undefined && 'none' in inherit && inherit.none)) plan.none.add(id);
  }

  envKeyOf(id: string): string | undefined {
    return this.envKeys.includes(id) ? id : this.declaredEnv.get(id);
  }

  originKey(url: string): string | undefined {
    try {
      const o = new URL(url).origin;
      return this.envKeys.find((k) => {
        try {
          return new URL(this.opts.envPages[k]).origin === o;
        } catch {
          return false;
        }
      });
    } catch {
      return undefined;
    }
  }

  /** The id of a `new_tab` written without `as`: the next `tab<n>` not filmed yet. */
  nextTab(): string {
    let tab: string;
    do tab = `tab${++this.tabSeq}`;
    while (this.plan.pages.has(tab));
    return tab;
  }
}

/** The page shown and the pages shown before it (the run's page history: `switch_page: previous`), closed ones aside. */
class PageHistory {
  shown: string | undefined;
  readonly closed = new Set<string>();
  private readonly history: string[] = [];

  show(id: string): void {
    if (this.shown !== undefined && this.shown !== id) this.history.push(this.shown);
    this.shown = id;
    this.closed.delete(id);
  }

  previous(): string | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i] !== this.shown && !this.closed.has(this.history[i])) return this.history[i];
    return undefined;
  }
}

/** The scenes the run walks (skipped ones and what comes after `--until` aside), binding the pages they film. */
function walkScenes(sc: Scenario, until: PlanPersonasOptions['until'], b: PersonaBinder): void {
  const h = new PageHistory();
  let current: string | undefined;
  const last = until ? until.sceneIndex : sc.scenes.length - 1;
  for (let si = 0; si <= last && si < sc.scenes.length; si++) {
    const entry = sc.scenes[si];
    if (!isCaptureScene(entry) || entry.skip) continue;
    const scene = entry as Scene;
    const base: IssuePath = ['scenes', si];
    const steps = (scene.steps ?? []).slice(0, until && until.sceneIndex === si ? until.stepIndex + 1 : (scene.steps ?? []).length);
    if (scene.pages !== undefined) {
      current = walkMultiPageScene(scene, base, steps, b, h) ?? current;
      continue;
    }
    const id = scene.page ?? current ?? b.envKeys[0];
    if (id === undefined) continue;
    b.bind(id, scene.persona, { envKey: b.envKeyOf(id) }, [...base, scene.persona !== undefined ? 'persona' : 'page']);
    current = id;
    h.show(id);
    steps.forEach((raw, j) => walkStep(raw, [...base, 'steps', j], b, h));
  }
}

/** A multi-page scene: each of its `pages` bound, its steps' `on` shown. Returns its first page id. */
function walkMultiPageScene(scene: Scene, base: IssuePath, steps: readonly unknown[], b: PersonaBinder, h: PageHistory): string | undefined {
  if (scene.persona !== undefined) {
    b.plan.issues.push({ path: [...base, 'persona'], kind: 'placement', message: 'a multi-page scene binds each page: write `persona` on the page (`pages.<id>.persona`)' });
  }
  const entries = scenePageEntries(scene.pages!);
  for (const e of entries) {
    const s = e.spec;
    const split = typeof s.open === 'string' ? splitPageOpen(s.open, b.envKeys) : null;
    let envKey = s.page ?? (split ? split.page : (b.declaredEnv.get(e.id) ?? (b.envKeys.includes(e.id) ? e.id : undefined)));
    if (envKey === undefined && typeof s.open === 'string' && isAbsoluteUrl(s.open)) envKey = b.originKey(s.open);
    if (envKey !== undefined) b.declaredEnv.set(e.id, envKey);
    b.bind(e.id, s.persona, { envKey }, [...base, ...e.path, 'persona']);
  }
  if (entries[0]) h.show(entries[0].id);
  for (const raw of steps) {
    if (isObject(raw) && typeof raw.on === 'string' && entries.some((e) => e.id === raw.on)) h.show(raw.on);
  }
  return entries[0]?.id;
}

/** A step of a single-page scene: `open: {page}`, `switch_page` and `new_tab` move to a page, bound on the way. */
function walkStep(raw: unknown, sp: IssuePath, b: PersonaBinder, h: PageHistory): void {
  if (!isObject(raw)) return;
  if (raw.open !== undefined && isObject(raw.open) && typeof raw.open.page === 'string') {
    h.show(raw.open.page);
    b.bind(raw.open.page, undefined, { envKey: b.envKeyOf(raw.open.page) }, sp);
  } else if (raw.switch_page !== undefined) {
    const sw = raw.switch_page;
    const to = typeof sw === 'string' ? sw : isObject(sw) && typeof sw.to === 'string' ? sw.to : undefined;
    const target = to === 'previous' ? h.previous() : to === 'main' ? (b.envKeys[0] ?? to) : to;
    if (target === undefined) return;
    const from = h.shown;
    h.show(target);
    if (isObject(sw) && sw.close_current === true && from !== undefined && from !== target) h.closed.add(from);
    b.bind(target, undefined, { envKey: b.envKeyOf(target) }, sp);
  } else if (raw.new_tab !== undefined && h.shown !== undefined) {
    const as = isObject(raw.new_tab) && typeof raw.new_tab.as === 'string' ? raw.new_tab.as : undefined;
    const tab = as ?? b.nextTab();
    b.bind(tab, undefined, { persona: b.plan.pages.get(h.shown) ?? null, none: b.plan.none.has(h.shown) }, sp);
    h.show(tab);
  }
}

/** The js hook tabs: each takes the persona its page is filmed with, else its default. */
function planHookPages(sc: Scenario, b: PersonaBinder): void {
  const plan = b.plan;
  // Named hooks too: a js one runs in the same kind of tab (a project.yaml hook's page takes its default).
  const named = Object.values(isObject(sc.hooks) ? sc.hooks : {}).flatMap((v) => (Array.isArray(v) ? v : [v]));
  for (const list of [sc.setup ?? [], sc.teardown ?? [], named]) {
    for (const h of list) {
      if (!isObject(h) || h.js === undefined) continue;
      const spec = h.js as unknown;
      const key = (isObject(spec) && typeof spec.page === 'string' ? spec.page : undefined) ?? b.envKeys[0];
      if (key === undefined || plan.hookPages.has(key)) continue;
      // The persona the scenes film that page with (none included), else its default: the hook sees what is filmed.
      plan.hookPages.set(key, plan.pages.has(key) ? (plan.pages.get(key) ?? null) : b.defaultOf(key));
    }
  }
}

/**
 * The personas http hooks act as (`auth: {persona}`, their rollback's too): the scenario's, and project.yaml's named
 * hooks its `hook:` steps run. An undeclared one is an issue.
 */
function planHookAuth(sc: Scenario, opts: PlanPersonasOptions, b: PersonaBinder): Set<string> {
  const hookAuth = new Set<string>();
  const names = b.names;
  const scan = (list: unknown, path: IssuePath): void => {
    (Array.isArray(list) ? list : [list]).forEach((h, i) => {
      if (!isObject(h) || !isObject(h.http)) return;
      const at: IssuePath = Array.isArray(list) ? [...path, i, 'http'] : [...path, 'http'];
      for (const [req, rp] of [
        [h.http, at],
        [h.http.rollback, [...at, 'rollback']],
      ] as Array<[unknown, IssuePath]>) {
        const persona = isObject(req) && isObject(req.auth) ? req.auth.persona : undefined;
        if (typeof persona !== 'string') continue;
        if (names.has(persona)) hookAuth.add(persona);
        else
          b.plan.issues.push({ path: [...rp, 'auth', 'persona'], kind: 'unknown', message: `persona "${persona}" is not declared for environment "${opts.env}" (personas: ${[...names].join(', ')})` });
      }
    });
  };
  scan(sc.setup ?? [], ['setup']);
  scan(sc.teardown ?? [], ['teardown']);
  const own = isObject(sc.hooks) ? sc.hooks : {};
  for (const [name, v] of Object.entries(own)) scan(v, ['hooks', name]);
  if (opts.projectHooks) {
    const ran = new Set<string>();
    for (const entry of sc.scenes) {
      if (!isCaptureScene(entry) || entry.skip) continue;
      for (const raw of (entry as Scene).steps ?? []) if (isObject(raw) && typeof raw.hook === 'string') ran.add(raw.hook);
    }
    for (const name of ran) if (!Object.hasOwn(own, name) && Object.hasOwn(opts.projectHooks, name)) scan(opts.projectHooks[name], ['hooks', name]);
  }
  return hookAuth;
}
