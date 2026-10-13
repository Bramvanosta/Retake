import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { PERSONA_NONE, planPersonas, projectPersonaNames, resolvePersonas } from '../auth.js';
import { formatPath } from '../issues.js';
import type { IssuePath } from '../issues.js';
import { isEditTextPath, isLiteralPath } from '../scenario-template.js';
import { normalizeStep, resolveStepRef } from '../steps.js';
import { isDesktopViewport, resolveViewport, scenePageEntries, splitPageOpen } from '../pages.js';
import type { ResolvedViewport } from '../pages.js';
import { DEFAULT_CAPTURE, MAX_SCENE_PAGES } from '../types.js';
import { isPoint } from '../targets.js';
import { BADGE_ACTIONS, IMAGE_FILE_EXTENSIONS, LOUPE_ACTIONS, SHORTCUT_ACTIONS, SPOTLIGHT_ACTIONS, isImagePath, parseFrameRef, tutorialFeaturesNamed } from '../tutorial.js';
import type { TutorialLevel } from '../tutorial.js';
import { DEFAULT_TEMPLATE } from '../template-defaults.js';
import type { LoadedProject, NormalizedStep, Scenario, Template } from '../types.js';
import type { LocatedIssue } from '../validation/located.js';
import { suggestion } from '../validation/suggest.js';
import { checkActionArgs, checkTarget } from './actions.js';
import { CheckContext, isObj } from './context.js';
import { checkHooks } from './hooks.js';
import { checkMediaFields } from './media.js';
import { checkTokens, checkVarsValues } from './tokens.js';
import type { TokenRules } from './tokens.js';

export interface ScenarioCheckOptions {
  project?: LoadedProject;
  /** Scenario file (enables the video-name check and project inference from projects/<p>/scenarios/x.yaml). */
  file?: string;
  /** Template used for the camera max_zoom warning (default: DEFAULT_TEMPLATE). */
  template?: Template;
  /** Environment overriding the scenario's `env` (e.g. `--env`). */
  env?: string;
  /** A `--until` step reference that must resolve. */
  until?: string;
}

const STATIC_PAGE_IDS = ['main', 'previous'];

/** Slots whose value names a captured artefact (or, for documents, a project file); `capture` names a capture_text. */
export const ARTEFACT_SLOTS = ['email', 'document', 'notification', 'capture'] as const;
/** Slots whose value is a frame reference (a marker, `start:` / `end:` a scene, `<n>s`, or an image file): before/after cards. */
export const FRAME_REF_SLOTS = ['before', 'after'] as const;
/** Slots whose value is a data file of the project (CSV / TSV): chart cards. */
export const DATA_FILE_SLOTS = ['data'] as const;
/** Data files a `data:` slot accepts. */
export const DATA_FILE_EXTENSIONS = ['.csv', '.tsv'];
/** Slots whose value is an image: a project file (checked) or a URL. */
export const IMAGE_FILE_SLOTS = ['logo', 'avatar', 'image'] as const;
type ArtefactRefKind = (typeof ARTEFACT_SLOTS)[number];
/** Project files a `document:` slot accepts (PDFs are rasterised by the run; images are shown as one page). */
export const DOCUMENT_FILE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg'];

/** A `document:` slot value that names a project file rather than a `download` artefact. */
export function isDocumentPath(value: string): boolean {
  return value.includes('/') || /\.[A-Za-z0-9]{2,5}$/.test(value);
}

/** projects/<p>/scenarios/x.yaml → projects/<p> (when it holds a project.yaml). */
function inferProjectDir(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const dir = dirname(file);
  if (basename(dir) !== 'scenarios') return undefined;
  const projectDir = dirname(dir);
  return existsSync(join(projectDir, 'project.yaml')) ? projectDir : undefined;
}

class ScenarioChecker {
  private readonly ctx: CheckContext;
  private pages?: Record<string, string>;
  private envName?: string;
  private readonly maxZoom: number;
  private readonly stepIds = new Map<string, IssuePath>();
  private readonly marks = new Map<string, IssuePath>();
  private readonly tabIds = new Set<string>();
  /** Page ids declared by the `pages` of multi-page scenes so far (a later scene may continue on them), with their environment page. */
  private readonly scenePageIds = new Set<string>();
  private readonly scenePageEnv = new Map<string, string>();
  /** The viewport each page id of a (captured) multi-page scene was first declared with, and where. */
  private readonly scenePageViewport = new Map<string, { viewport: ResolvedViewport; path: IssuePath }>();
  private readonly switches: Array<{ to: string; path: IssuePath }> = [];
  /** Artefacts declared by wait_for_email / download / capture_text (`as`), per kind. */
  private readonly artefacts = { email: new Map<string, IssuePath>(), document: new Map<string, IssuePath>(), text: new Map<string, IssuePath>() };
  /** Frame references of card / overlay slots (`before: mark:x`…), checked once every mark and scene is known. */
  private readonly frameRefs: Array<{ value: string; path: IssuePath }> = [];
  private readonly sceneIdSet = new Set<string>();
  /** Artefact references in card / overlay slots (`email: <name>`…), checked once every step is known. */
  private readonly artefactRefs: Array<{ kind: ArtefactRefKind; value: string; path: IssuePath }> = [];
  /** Overlays starting at a mark (`at: mark:<name>`, L2.12), checked once every mark is known. */
  private readonly atMarks: Array<{ name: string; path: IssuePath }> = [];

  constructor(
    private readonly s: Record<string, unknown>,
    structural: readonly LocatedIssue[],
    private readonly opts: ScenarioCheckOptions,
  ) {
    this.ctx = new CheckContext(structural, opts.project?.dir ?? inferProjectDir(opts.file));
    this.maxZoom = opts.template?.motion.max_zoom ?? DEFAULT_TEMPLATE.motion.max_zoom;
  }

  run(): LocatedIssue[] {
    this.environment();
    this.scenes();
    const saved = new Set<string>();
    const pageKeys = this.pages ? Object.keys(this.pages) : undefined;
    const project = this.opts.project;
    checkHooks(this.s.setup, ['setup'], this.ctx, { pages: pageKeys, saved, project });
    checkHooks(this.s.teardown, ['teardown'], this.ctx, { pages: pageKeys, saved, project });
    this.tokens(saved);
    this.misc();
    this.personas();
    return this.ctx.out;
  }

  private environment(): void {
    const project = this.opts.project;
    if (!project) return;
    const envs = project.config.environments ?? {};
    const names = Object.keys(envs);
    const declared = typeof this.s.env === 'string' ? this.s.env : undefined;
    const requested = this.opts.env ?? declared;
    if (requested !== undefined && !Object.hasOwn(envs, requested)) {
      this.ctx.error(
        this.opts.env !== undefined ? [] : ['env'],
        `unknown environment "${requested}"${suggestion(requested, names)} (available: ${names.join(', ') || 'none'})`,
      );
      return;
    }
    this.envName = requested ?? project.config.default_env ?? names[0];
    if (this.envName === undefined) {
      this.ctx.warning([], `project "${project.slug}" has no environments: pages and relative URLs cannot be resolved`);
      this.pages = {};
      return;
    }
    this.pages = envs[this.envName] ?? {};
  }

  private unknownPage(page: string, path: IssuePath): void {
    const keys = Object.keys(this.pages ?? {});
    this.ctx.error(
      path,
      `unknown page "${page}" in environment "${this.envName}"${suggestion(page, keys)} (available: ${keys.join(', ') || 'none'})`,
    );
  }

  private scenes(): void {
    const scenes = Array.isArray(this.s.scenes) ? this.s.scenes : [];
    const sceneIds = new Map<string, number>();
    const visited = new Set<string>();
    let current = this.pages ? Object.keys(this.pages)[0] : undefined;
    let capturable = 0;

    // Ids are unique across scenes, cards and interstitials (explicit ids first, then the default ids of unnamed
    // cards and interstitials, which must not collide with an explicit one).
    scenes.forEach((entry, i) => {
      if (!isObj(entry) || typeof entry.id !== 'string') return;
      this.sceneIdSet.add(entry.id);
      const prev = sceneIds.get(entry.id);
      if (prev !== undefined) this.ctx.error(['scenes', i, 'id'], `duplicate scene id "${entry.id}" (already used by scenes[${prev}])`);
      else sceneIds.set(entry.id, i);
    });
    scenes.forEach((entry, i) => {
      if (!isObj(entry) || entry.id !== undefined) return;
      const kind = 'card' in entry ? 'card' : 'interstitial' in entry ? 'interstitial' : undefined;
      if (!kind) return;
      const auto = `${kind}-${i}`;
      const prev = sceneIds.get(auto);
      if (prev !== undefined) {
        this.ctx.error(
          ['scenes', i],
          `the default id "${auto}" of this ${kind} is already used by scenes[${prev}]: give the ${kind} an \`id\``,
        );
      }
    });

    scenes.forEach((entry, i) => {
      const p: IssuePath = ['scenes', i];
      if (!isObj(entry)) return;
      if ('interstitial' in entry) {
        this.interstitial(entry.interstitial, [...p, 'interstitial']);
        return;
      }
      if ('card' in entry) {
        this.card(entry.card, [...p, 'card']);
        return;
      }
      if (entry.skip !== true) capturable++;
      this.tutorial(entry.tutorial, [...p, 'tutorial'], 'scene');
      if (entry.persona !== undefined && entry.pages !== undefined) {
        this.ctx.error([...p, 'persona'], 'a multi-page scene binds each page: write `persona` on the page (`pages.<id>.persona`)');
      } else this.personaName(entry.persona, [...p, 'persona']);

      if (entry.pages !== undefined) {
        const first = this.multiPageScene(entry, p, visited);
        if (first !== undefined && entry.skip !== true) current = first;
        return;
      }

      const page = typeof entry.page === 'string' ? entry.page : current;
      if (typeof entry.page === 'string' && this.pages && !Object.hasOwn(this.pages, entry.page) && !this.scenePageIds.has(entry.page)) {
        this.unknownPage(entry.page, [...p, 'page']);
      }
      if (entry.skip !== true) {
        if (typeof entry.page === 'string') this.singlePageViewport(entry.page, [...p, 'page'], 'this scene films');
        else this.singlePageViewport(current, p, 'this scene has no `page`: it continues on');
      }
      const steps = Array.isArray(entry.steps) ? entry.steps : [];
      const pageKey = page ?? '(default page)';
      const opensFirst = isObj(steps[0]) && 'open' in steps[0];
      if (entry.open === undefined && !opensFirst && !visited.has(pageKey) && entry.skip !== true) {
        const where = page ? ` on page "${page}"` : '';
        this.ctx.warning(p, `scene "${String(entry.id)}" is the first scene${where} but has no \`open\`: it starts on whatever is loaded`);
      }
      this.sceneCursor(entry, p, capturable === 1 && entry.skip !== true);
      if (entry.open !== undefined) visited.add(pageKey);
      current = page;
      if (Array.isArray(entry.steps) && steps.length === 0) this.ctx.warning([...p, 'steps'], 'scene has no steps');

      steps.forEach((raw, j) => {
        const sp: IssuePath = [...p, 'steps', j];
        if (this.ctx.broken(sp)) return;
        const step = normalizeStep(raw, j);
        if (step.on !== undefined) {
          this.ctx.error([...sp, 'on'], '`on:` names the page a step acts on in a multi-page scene (a scene with `pages`): this scene films one page');
        }
        this.step(step, sp);
        if (step.action === 'open') visited.add((step.args as { page?: string }).page ?? pageKey);
        if (entry.skip !== true && step.action === 'switch_page') {
          const arg = isObj(raw) ? raw.switch_page : undefined;
          const to = (step.args as { to?: unknown }).to;
          if (typeof to === 'string') this.singlePageViewport(to, isObj(arg) ? [...sp, 'switch_page', 'to'] : [...sp, 'switch_page'], '`switch_page` goes to');
        }
        if (entry.skip !== true && step.action === 'open' && typeof (step.args as { page?: unknown }).page === 'string') {
          this.singlePageViewport((step.args as { page: string }).page, [...sp, 'open', 'page'], '`open` goes to');
        }
      });
    });

    if (scenes.length > 0 && capturable === 0) {
      this.ctx.warning(['scenes'], 'nothing to capture: every entry is a card, an interstitial or a skipped scene');
    }
    for (const [id, path] of this.stepIds) {
      if (sceneIds.has(id)) this.ctx.warning([...path, 'id'], `step id "${id}" is also a scene id: --until "${id}" refers to the step`);
    }
  }

  /**
   * A multi-page scene (L2.11): its `pages` (2, unique ids, environment pages, `open` forms, viewports), no scene-level
   * `page` / `open`, steps acting on one of its pages (`on:`), no tab switching inside it. Returns its first page id.
   */
  private multiPageScene(entry: Record<string, unknown>, p: IssuePath, visited: Set<string>): string | undefined {
    const pp: IssuePath = [...p, 'pages'];
    for (const key of ['page', 'open'] as const) {
      if (entry[key] !== undefined) {
        this.ctx.error([...p, key], `a multi-page scene declares its pages in \`pages\`: remove \`${key}\` (${key === 'open' ? 'give each page its own `open`' : 'each page names its environment page'})`);
      }
    }
    if (entry.cursor !== undefined) this.ctx.warning([...p, 'cursor'], 'a multi-page scene places each cursor from its page: use `pages.<id>.cursor` (ignored here)');
    if (this.ctx.broken(pp)) return undefined;
    const entries = scenePageEntries(entry.pages as never);
    if (entries.length < 2) this.ctx.error(pp, `a multi-page scene films at least 2 pages (it has ${entries.length}); use \`page\` and \`open\` for one page`);
    else if (entries.length > MAX_SCENE_PAGES) {
      this.ctx.error(pp, `a scene films at most ${MAX_SCENE_PAGES} pages at the same time (it has ${entries.length}): split screen and picture in picture show two`);
    }
    const envKeys = Object.keys(this.pages ?? {});
    const ids = new Map<string, IssuePath>();
    for (const e of entries) {
      const ep: IssuePath = [...p, ...e.path];
      const prev = ids.get(e.id);
      if (prev) {
        this.ctx.error(ep, `duplicate page id "${e.id}" in this scene (already used at ${formatPath(prev)})` + (e.derived ? ': give the page an `id`' : ''));
        continue;
      }
      ids.set(e.id, ep);
      const s = e.spec;
      const plain = Array.isArray(entry.pages) && typeof (entry.pages as unknown[])[e.path[1] as number] === 'string';
      if (plain && this.pages && !Object.hasOwn(this.pages, e.id) && !this.scenePageIds.has(e.id)) {
        const known = [...envKeys, ...this.scenePageIds];
        this.ctx.error(ep, `unknown page "${e.id}": neither a page of environment "${this.envName}" nor a page an earlier scene films${suggestion(e.id, known)} (available: ${known.join(', ') || 'none'})`);
        continue;
      }
      if (this.pages && typeof s.page === 'string' && !Object.hasOwn(this.pages, s.page)) {
        this.unknownPage(s.page, [...ep, 'page']);
      }
      let envPage: string | undefined = typeof s.page === 'string' ? s.page : (this.scenePageEnv.get(e.id) ?? (envKeys.includes(e.id) ? e.id : undefined));
      if (typeof s.open === 'string') {
        const split = splitPageOpen(s.open, envKeys);
        const prefix = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(s.open)?.[1];
        if (split) {
          if (typeof s.page === 'string' && s.page !== split.page) this.ctx.error([...ep, 'open'], `\`open: ${s.open}\` names page "${split.page}" but \`page\` is "${s.page}"`);
          envPage = split.page;
        } else if (prefix !== undefined && this.pages && !/^(https?|file|about|data|chrome)$/i.test(prefix)) {
          this.ctx.error([...ep, 'open'], `"${prefix}:" in \`open: ${s.open}\` is not a page of environment "${this.envName}"${suggestion(prefix, envKeys)} (available: ${envKeys.join(', ') || 'none'})`);
        } else if (prefix === undefined && envPage === undefined && this.pages) {
          this.ctx.error([...ep, 'open'], `\`open: ${s.open}\` is relative but page "${e.id}" names no environment page: add \`page: <${envKeys.join(' | ') || 'page'}>\` or write \`<page>:${s.open}\``);
        }
        visited.add(e.id);
      } else if (!visited.has(e.id) && !this.scenePageIds.has(e.id) && entry.skip !== true) {
        this.ctx.warning(ep, `page "${e.id}" is filmed for the first time but has no \`open\`: it starts blank`);
      }
      if (s.cursor !== undefined) this.sceneCursor({ cursor: s.cursor }, ep, false);
      this.personaName(s.persona, [...ep, 'persona']);
      if (envPage !== undefined) this.scenePageEnv.set(e.id, envPage);
      if (entry.skip !== true) this.pageViewport(e.id, s.viewport, ep);
    }
    for (const id of ids.keys()) this.scenePageIds.add(id);
    const known = [...ids.keys()];
    const steps = Array.isArray(entry.steps) ? entry.steps : [];
    if (Array.isArray(entry.steps) && steps.length === 0) this.ctx.warning([...p, 'steps'], 'scene has no steps');
    steps.forEach((raw, j) => {
      const sp: IssuePath = [...p, 'steps', j];
      if (this.ctx.broken(sp)) return;
      const step = normalizeStep(raw, j);
      if (step.on !== undefined && !ids.has(step.on)) {
        this.ctx.error([...sp, 'on'], `unknown page "${step.on}": this scene films ${known.map((k) => `"${k}"`).join(' and ')}${suggestion(step.on, known)}`);
      }
      if (step.action === 'new_tab' || step.action === 'switch_page') {
        this.ctx.error([...sp, step.action], `${step.action} is not available in a multi-page scene: declare every page in \`pages\` and act on one with \`on:\``);
      }
      if (step.action === 'open' && (step.args as { page?: string }).page !== undefined) {
        this.ctx.error([...sp, 'open', 'page'], '`open.page` is not available in a multi-page scene: `open` navigates the page of the step (`on:`)');
      }
      this.step(step, sp);
    });
    return entries[0]?.id;
  }

  /** A scene's or a page's `persona`: one the project declares (in any environment), or `none`. */
  private personaName(v: unknown, path: IssuePath): void {
    if (typeof v !== 'string' || v === PERSONA_NONE || !this.opts.project || this.ctx.broken(path)) return;
    const names = projectPersonaNames(this.opts.project.config);
    if (names.includes(v)) return;
    this.ctx.error(
      path,
      names.length
        ? `unknown persona "${v}"${suggestion(v, names)} (personas: ${names.join(', ')}; or ${PERSONA_NONE})`
        : `unknown persona "${v}": project "${this.opts.project.slug}" declares no personas (auth.personas in project.yaml)`,
    );
  }

  /**
   * Personas (L1.6): in every environment that declares some, a page keeps one persona for the whole run (core
   * planPersonas — the walk the runner makes). Unknown names were reported by personaName (across environments); the
   * runner re-plans for the environment it runs on and stops before the browser opens.
   */
  private personas(): void {
    const project = this.opts.project;
    if (!project || !this.ctx.structurallyValid) return;
    const seen = new Set<string>();
    for (const env of Object.keys(project.config.environments ?? {})) {
      const personas = resolvePersonas(project, env, { home: '/' });
      if (personas.length === 0) continue;
      const plan = planPersonas(this.s as unknown as Scenario, { env, envPages: project.config.environments[env], personas, hooks: true });
      for (const i of plan.issues) {
        if (i.kind !== 'conflict') continue;
        const key = `${formatPath(i.path)} ${i.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.ctx.error(i.path, `${i.message}${Object.keys(project.config.environments).length > 1 ? ` (environment ${env})` : ''}`);
      }
    }
  }

  /** `card:` — something to show: a component, or the `title` slot of the theme's card component. */
  private card(card: unknown, p: IssuePath): void {
    if (!isObj(card) || this.ctx.broken(p)) return;
    const slots = isObj(card.slots) ? card.slots : {};
    const file = checkMediaFields(card, p, this.ctx);
    if (file.kind) {
      const unused = Object.keys(slots);
      if (unused.length > 0) this.ctx.warning([...p, 'slots'], `the ${file.kind} file replaces the card component: slots ${unused.join(', ')} are not shown`);
      return;
    }
    if (card.component === undefined && (typeof slots.title !== 'string' || slots.title.trim() === '')) {
      this.ctx.error(p, 'a card needs a `component`, a `slots.title` (the theme\'s card component shows a title) or a `video` / `image` / `lottie` file');
    }
    this.slotRefs(slots, [...p, 'slots']);
  }

  /** `intro` / `outro` (L2.12): the user's own file instead of the theme's component. */
  private segmentFile(spec: unknown, p: IssuePath, what: 'intro' | 'outro'): void {
    if (!isObj(spec)) return;
    const file = checkMediaFields(spec, p, this.ctx);
    if (!file.kind) return;
    const unused = what === 'outro' ? (['tagline', 'url'] as const).filter((k) => spec[k] !== undefined) : [];
    for (const k of unused) this.ctx.warning([...p, k], `the ${file.kind} file replaces the outro component: \`${k}\` is not shown`);
  }

  /**
   * Remember the artefact references of a component use's slots (`email`, `document`, `notification`, `capture`) and
   * its frame references (`before`, `after`); check its data and image files now.
   */
  private slotRefs(slots: Record<string, unknown>, p: IssuePath): void {
    for (const kind of ARTEFACT_SLOTS) {
      const v = slots[kind];
      if (typeof v === 'string' && v.trim() !== '') this.artefactRefs.push({ kind, value: v.trim(), path: [...p, kind] });
    }
    for (const name of FRAME_REF_SLOTS) {
      const v = slots[name];
      if (typeof v === 'string' && v.trim() !== '') this.frameRefs.push({ value: v.trim(), path: [...p, name] });
    }
    for (const name of DATA_FILE_SLOTS) {
      const v = slots[name];
      if (typeof v !== 'string' || v.trim() === '') continue;
      const ext = (/\.[A-Za-z0-9]+$/.exec(v.trim())?.[0] ?? '').toLowerCase();
      if (!DATA_FILE_EXTENSIONS.includes(ext)) this.ctx.error([...p, name], `data "${v}": a data file must be a ${DATA_FILE_EXTENSIONS.join(' or ')} file of the project`);
      else this.ctx.file(v.trim(), [...p, name], 'data file', 'error');
    }
    for (const name of IMAGE_FILE_SLOTS) {
      const v = slots[name];
      if (typeof v !== 'string' || v.trim() === '' || /^(https?:|data:|ds-asset:)/.test(v.trim())) continue;
      if (!isImagePath(v)) this.ctx.error([...p, name], `${name} "${v}": an image must be a ${IMAGE_FILE_EXTENSIONS.join(', ')} file of the project or an http(s) URL`);
      else this.ctx.file(v.trim(), [...p, name], 'image', 'error');
    }
  }

  /** Every frame reference names a mark, a scene (`start:` / `end:`), a time (`12.5s`) or an image file of the project. */
  private checkFrameRefs(): void {
    for (const r of this.frameRefs) {
      const ref = parseFrameRef(r.value);
      if (!ref) {
        this.ctx.error(r.path, `"${r.value}" is not a frame: use a mark name (or mark:<name>), start:<scene> / end:<scene>, a capture time such as 12.5s, or an image file`);
        continue;
      }
      if (ref.kind === 'file') this.ctx.file(ref.path, r.path, 'image', 'error');
      else if (ref.kind === 'mark' && !this.marks.has(ref.name)) {
        const names = [...this.marks.keys()];
        this.ctx.error(r.path, `unknown mark "${ref.name}": no step has \`mark: ${ref.name}\`${suggestion(ref.name, names)}` + (names.length ? ` (marks: ${names.join(', ')})` : ''));
      } else if (ref.kind === 'scene' && !this.sceneIdSet.has(ref.scene)) {
        this.ctx.error(r.path, `unknown scene "${ref.scene}"${suggestion(ref.scene, [...this.sceneIdSet])}`);
      }
    }
  }

  /**
   * `tutorial:` switches: `progress` is video-wide (ignored on a scene or a step); a step that turns an overlay on
   * explicitly should be a step that overlay can show (a press for shortcuts, a type for the loupe…).
   */
  private tutorial(sw: unknown, p: IssuePath, level: TutorialLevel, action?: string): void {
    if (sw === undefined || this.ctx.broken(p)) return;
    if (level !== 'scenario' && isObj(sw) && sw.progress !== undefined) {
      this.ctx.warning([...p, 'progress'], '`progress` is a video-wide switch: set it on the scenario `tutorial` (ignored here)');
    }
    if (level !== 'step' || action === undefined || !isObj(sw)) return;
    const on = (v: unknown) => v !== undefined && v !== false;
    const fits: Record<string, { actions: readonly string[]; what: string }> = {
      shortcuts: { actions: SHORTCUT_ACTIONS, what: 'shows the keys of `press` steps' },
      loupe: { actions: LOUPE_ACTIONS, what: 'magnifies the field of `type` steps' },
      steps: { actions: BADGE_ACTIONS, what: 'numbers steps that click a target' },
      spotlight: { actions: SPOTLIGHT_ACTIONS, what: 'follows the target of a step' },
    };
    for (const f of tutorialFeaturesNamed(sw as never, 'step')) {
      const fit = fits[f];
      if (fit && on(sw[f]) && !fit.actions.includes(action)) this.ctx.warning([...p, f], `${f} ${fit.what}: nothing to show on this ${action} step`);
    }
  }

  /**
   * Every `email:` names a wait_for_email `as`; every `document:` a download `as` or a project file; notifications: a name
   * or an index; every `capture:` a capture_text `as`.
   */
  private checkArtefactRefs(): void {
    for (const r of this.artefactRefs) {
      if (r.kind === 'notification') {
        const index = /^\d+$/.test(r.value);
        if (index ? !/^[1-9]\d*$/.test(r.value) : !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(r.value)) {
          this.ctx.error(r.path, `notification "${r.value}" must be a captured notification's name (its tag) or its 1-based index`);
        }
        continue;
      }
      if (r.kind === 'document' && isDocumentPath(r.value)) {
        const ext = (/\.[A-Za-z0-9]+$/.exec(r.value)?.[0] ?? '').toLowerCase();
        if (!DOCUMENT_FILE_EXTENSIONS.includes(ext)) {
          this.ctx.error(r.path, `document "${r.value}": a project document must be a ${DOCUMENT_FILE_EXTENSIONS.join(', ')} file`);
          continue;
        }
        this.ctx.file(r.value, r.path, 'document', 'error');
        continue;
      }
      const known = this.artefacts[r.kind === 'capture' ? 'text' : r.kind];
      if (!known.has(r.value)) {
        const action = r.kind === 'email' ? 'wait_for_email' : r.kind === 'capture' ? 'capture_text' : 'download';
        const names = [...known.keys()];
        this.ctx.error(
          r.path,
          `unknown ${r.kind} "${r.value}": no ${action} step captures it as \`as: ${r.value}\`${suggestion(r.value, names)}` +
            (names.length ? ` (captured: ${names.join(', ')})` : r.kind === 'document' ? ' (or give a project file such as assets/quote.pdf)' : ''),
        );
      }
    }
  }

  private interstitial(inter: unknown, p: IssuePath): void {
    if (!isObj(inter) || this.ctx.broken(p)) return;
    const file = checkMediaFields(inter, p, this.ctx);
    if (file.kind) {
      for (const k of ['text', 'kicker', 'style'] as const) {
        if (inter[k] !== undefined) this.ctx.warning([...p, k], `the ${file.kind} file replaces the interstitial component: \`${k}\` is not shown`);
      }
      return;
    }
    if (typeof inter.text !== 'string' || inter.text.trim() === '') {
      this.ctx.error(p, 'an interstitial needs `text` (or a `video` / `image` / `lottie` file)');
    }
    if (inter.style !== undefined && inter.component !== undefined) {
      this.ctx.warning([...p, 'style'], '`style` (legacy) is ignored when `component` is set');
    }
  }

  /** The capture size: scenario capture over project capture over the defaults. */
  private captureSize(): { width: number; height: number } {
    return this.viewport() ?? { width: DEFAULT_CAPTURE.width, height: DEFAULT_CAPTURE.height };
  }

  /**
   * A page of a multi-page scene keeps one viewport for the whole run: the first declaration sets it (a later one that
   * says nothing continues it), another size or mobile emulation for the same id is an error.
   */
  private pageViewport(id: string, spec: unknown, ep: IssuePath): void {
    let vp: ResolvedViewport;
    try {
      vp = resolveViewport(spec as never, this.captureSize());
    } catch {
      return; // an unknown preset is reported by the schema
    }
    const known = this.scenePageViewport.get(id);
    if (!known) {
      this.scenePageViewport.set(id, { viewport: vp, path: spec === undefined ? ep : [...ep, 'viewport'] });
      return;
    }
    if (spec === undefined) return;
    const k = known.viewport;
    if (k.width !== vp.width || k.height !== vp.height || k.mobile !== vp.mobile) {
      this.ctx.error(
        [...ep, 'viewport'],
        `page "${id}" is filmed at ${k.width}×${k.height}${k.mobile ? ' (mobile)' : ''} since ${formatPath(known.path)} and is asked at ${vp.width}×${vp.height}${vp.mobile ? ' (mobile)' : ''} here: ` +
          'a page keeps one viewport for the whole run (give the other viewport its own page id)',
      );
    }
  }

  /** A single-page scene films the capture size: the page it films must not be a mobile or other-size page of `pages`. */
  private singlePageViewport(id: string | undefined, path: IssuePath, how: string): void {
    const d = id !== undefined ? this.scenePageViewport.get(id) : undefined;
    if (!d) return;
    const cap = this.captureSize();
    if (isDesktopViewport(d.viewport, cap)) return;
    const v = d.viewport;
    this.ctx.error(
      path,
      `${how} page "${id}", filmed at ${v.width}×${v.height}${v.mobile ? ' (mobile)' : ''} since ${formatPath(d.path)}: a single-page scene films the capture size (${cap.width}×${cap.height}) — ` +
        'film that page in a multi-page scene (`pages`), or name an environment page with `page:`',
    );
  }

  /** Capture viewport (scenario capture over project capture) when known. */
  private viewport(): { width: number; height: number } | undefined {
    const cap = isObj(this.s.capture) ? this.s.capture : {};
    const proj = this.opts.project?.config.capture;
    const width = typeof cap.width === 'number' ? cap.width : proj?.width;
    const height = typeof cap.height === 'number' ? cap.height : proj?.height;
    return width !== undefined && height !== undefined ? { width, height } : undefined;
  }

  /** Scene `cursor`: a target must locate something, a point must lie inside the viewport, `keep` needs a previous scene. */
  private sceneCursor(entry: Record<string, unknown>, p: IssuePath, firstCaptured: boolean): void {
    const c = entry.cursor;
    if (c === undefined || this.ctx.broken([...p, 'cursor'])) return;
    const cp: IssuePath = [...p, 'cursor'];
    if (c === 'keep') {
      if (firstCaptured) this.ctx.warning(cp, '`cursor: keep` on the first scene: there is no previous position, it behaves like `auto`');
      return;
    }
    if (c === 'auto') return;
    if (isPoint(c)) {
      const vp = this.viewport();
      if (vp && (c.x < 0 || c.y < 0 || c.x > vp.width || c.y > vp.height)) {
        this.ctx.warning(cp, `point (${c.x}, ${c.y}) is outside the ${vp.width}×${vp.height} viewport: it is clamped inside`);
      }
      return;
    }
    checkTarget(c, cp, this.ctx);
  }

  private step(step: NormalizedStep, sp: IssuePath): void {
    if (step.id !== undefined) {
      const prev = this.stepIds.get(step.id);
      if (prev) this.ctx.error([...sp, 'id'], `duplicate step id "${step.id}" (already used at ${formatPath(prev)})`);
      else this.stepIds.set(step.id, sp);
    }
    if (step.mark !== undefined) {
      const prev = this.marks.get(step.mark);
      if (prev) this.ctx.warning([...sp, 'mark'], `mark "${step.mark}" is already used at ${formatPath(prev)}`);
      else this.marks.set(step.mark, sp);
    }
    if (step.camera) {
      if (step.camera.zoom > this.maxZoom) {
        const which = this.opts.template ? 'template' : 'default template';
        this.ctx.warning(
          [...sp, 'camera', 'zoom'],
          `zoom ${step.camera.zoom} is above the ${which} max_zoom ${this.maxZoom}: the editor clamps it`,
        );
      }
      const ct = step.camera.target;
      if (ct !== 'cursor' && ct !== 'step') checkTarget(ct, [...sp, 'camera', 'target'], this.ctx);
    }
    if (step.overlay?.target !== undefined) checkTarget(step.overlay.target, [...sp, 'overlay', 'target'], this.ctx);
    if (step.overlay?.slots) this.slotRefs(step.overlay.slots, [...sp, 'overlay', 'slots']);
    if (step.overlay) this.overlay(step, [...sp, 'overlay']);
    if (step.tutorial !== undefined) this.tutorial(step.tutorial, [...sp, 'tutorial'], 'step', step.action);
    if (typeof step.park === 'number' && step.action === 'hold') {
      this.ctx.warning([...sp, 'park'], 'on a `hold` step the cursor parks, then the hold step sets the time: give `park: true`');
    } else if (typeof step.park === 'number' && step.hold !== undefined) {
      this.ctx.warning([...sp, 'hold'], '`park: <seconds>` sets the hold after the park: `hold` is ignored');
    }
    const facts = checkActionArgs(step, sp, this.ctx);
    if (facts.artefact) {
      const known = this.artefacts[facts.artefact.kind];
      const prev = known.get(facts.artefact.name);
      if (prev) this.ctx.error(facts.artefact.path, `${facts.artefact.kind} "${facts.artefact.name}" is already captured at ${formatPath(prev)}: give each capture its own \`as\``);
      else known.set(facts.artefact.name, facts.artefact.path);
      if (facts.artefact.kind === 'email' && this.opts.project && !this.opts.project.config.mailbox) {
        this.ctx.error(
          [...sp, 'wait_for_email'],
          `project "${this.opts.project.slug}" has no \`mailbox\`: add mailbox: {provider: mailpit, url: http://localhost:8025} to project.yaml`,
        );
      }
    }
    if (facts.tabId) this.tabIds.add(facts.tabId);
    if (facts.switchTo) this.switches.push(facts.switchTo);
    if (facts.openPage && this.pages && !Object.hasOwn(this.pages, facts.openPage.page)) {
      this.unknownPage(facts.openPage.page, facts.openPage.path);
    }
  }

  /** A step `overlay` (L2.12 additions): a component or a file, when it starts, where a file goes. */
  private overlay(step: NormalizedStep, op: IssuePath): void {
    const o = step.overlay!;
    if (this.ctx.broken(op)) return;
    const file = checkMediaFields(o, op, this.ctx, { overlay: true });
    if (!file.kind && o.component === undefined) {
      this.ctx.error(op, 'an overlay needs a `component` or a `video` / `image` / `lottie` file');
    }
    if (o.rect !== undefined && o.anchor !== undefined) this.ctx.warning([...op, 'anchor'], '`rect` places the overlay: `anchor` is ignored');
    if (o.scale !== undefined && (o.rect !== undefined || o.anchor === 'screen')) {
      this.ctx.warning([...op, 'scale'], `\`scale\` is ignored: ${o.rect !== undefined ? '`rect` sets the size' : '`anchor: screen` fills the visible capture'}`);
    }
    if (typeof o.at === 'string' && o.at.startsWith('mark:')) this.atMarks.push({ name: o.at.slice(5), path: [...op, 'at'] });
    const clicks = ['click', 'double_click', 'menu', 'date', 'pick', 'select', 'drag', 'drop_file', 'download'];
    if (o.at === 'click' && !clicks.includes(step.action)) {
      this.ctx.warning([...op, 'at'], `a ${step.action} step has no click: the overlay starts at the end of the step`);
    }
    if (file.kind === 'lottie' && file.lottie && typeof o.duration === 'number' && o.duration > file.lottie.duration_s + 0.05 && o.loop !== true) {
      this.ctx.warning([...op, 'duration'], `the animation lasts ${file.lottie.duration_s} s: its last frame is held (\`loop: true\` replays it instead)`);
    }
  }

  private tokens(saved: Set<string>): void {
    const projectVars = Object.keys(this.opts.project?.config.vars ?? {});
    const scenarioVars = isObj(this.s.vars) ? Object.keys(this.s.vars) : [];
    const scope = {
      pages: this.pages ? Object.keys(this.pages) : undefined,
      vars: new Set([...projectVars, ...scenarioVars]),
      varsComplete: this.opts.project !== undefined,
      saved,
    };
    // Scenes are templated when they run (R-RUN-16): no token in a literal name, no secret in what the video shows.
    const sceneRules: TokenRules = {
      literal: (p, v) => isLiteralPath(p.slice(2), v),
      noSecret: (p) => isEditTextPath(p.slice(2)),
    };
    for (const key of ['setup', 'teardown', 'scenes'] as const) {
      const list = this.s[key];
      if (!Array.isArray(list)) continue;
      list.forEach((v, i) => {
        if (!this.ctx.broken([key, i])) checkTokens(v, [key, i], scope, this.ctx, false, key === 'scenes' ? sceneRules : undefined);
      });
    }
    if (this.s.vars !== undefined && !this.ctx.broken(['vars'])) checkVarsValues(this.s.vars, ['vars'], this.ctx);
    // The video's title, intro, outro and tutorial switches are templated too (shown in the video: no secrets).
    for (const key of ['title', 'intro', 'outro', 'tutorial'] as const) {
      if (this.s[key] !== undefined && !this.ctx.broken([key])) checkTokens(this.s[key], [key], scope, this.ctx, false, { noSecret: () => true });
    }
  }

  private misc(): void {
    this.checkArtefactRefs();
    this.checkFrameRefs();
    for (const r of this.atMarks) {
      if (this.marks.has(r.name)) continue;
      const names = [...this.marks.keys()];
      this.ctx.error(r.path, `unknown mark "${r.name}": no step has \`mark: ${r.name}\`${suggestion(r.name, names)}` + (names.length ? ` (marks: ${names.join(', ')})` : ''));
    }
    if (!this.ctx.broken(['intro'])) this.segmentFile(this.s.intro, ['intro'], 'intro');
    if (!this.ctx.broken(['outro'])) this.segmentFile(this.s.outro, ['outro'], 'outro');
    this.tutorial(this.s.tutorial, ['tutorial'], 'scenario');
    if (this.pages && this.switches.length > 0) {
      const known = new Set([...Object.keys(this.pages), ...STATIC_PAGE_IDS, ...this.tabIds, ...this.scenePageIds]);
      for (const { to, path } of this.switches) {
        if (!known.has(to) && !/^tab\d+$/.test(to)) {
          this.ctx.warning(path, `switch_page target "${to}" is not a page key, a new_tab \`as\` id, "main" or "previous"${suggestion(to, [...known])}`);
        }
      }
    }
    if (isObj(this.s.music) && typeof this.s.music.file === 'string' && !this.ctx.broken(['music'])) {
      this.ctx.file(this.s.music.file, ['music', 'file'], 'music file', 'error');
    }
    if (this.opts.until !== undefined && this.ctx.structurallyValid) {
      if (!resolveStepRef(this.s as unknown as Scenario, this.opts.until)) {
        this.ctx.error(
          [],
          `--until "${this.opts.until}" does not match any step (use "<scene>.<step id|index>", a unique step id or a scene id)`,
        );
      }
    }
    if (this.opts.file && typeof this.s.video === 'string') {
      const name = basename(this.opts.file).replace(/\.ya?ml$/i, '');
      if (name !== this.s.video) this.ctx.warning(['video'], `video "${this.s.video}" differs from the file name "${name}"`);
    }
  }
}

/** Semantic checks of a scenario value (see docs/DESIGN.md §1); `structural` = schema issues. */
export function checkScenario(value: unknown, structural: readonly LocatedIssue[], opts: ScenarioCheckOptions = {}): LocatedIssue[] {
  if (!isObj(value)) return [];
  return new ScenarioChecker(value, structural, opts).run();
}
