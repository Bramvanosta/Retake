import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { formatPath } from '../issues.js';
import type { IssuePath } from '../issues.js';
import { normalizeStep, resolveStepRef } from '../steps.js';
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
import { checkTokens } from './tokens.js';

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
  private readonly switches: Array<{ to: string; path: IssuePath }> = [];
  /** Artefacts declared by wait_for_email / download / capture_text (`as`), per kind. */
  private readonly artefacts = { email: new Map<string, IssuePath>(), document: new Map<string, IssuePath>(), text: new Map<string, IssuePath>() };
  /** Frame references of card / overlay slots (`before: mark:x`…), checked once every mark and scene is known. */
  private readonly frameRefs: Array<{ value: string; path: IssuePath }> = [];
  private readonly sceneIdSet = new Set<string>();
  /** Artefact references in card / overlay slots (`email: <name>`…), checked once every step is known. */
  private readonly artefactRefs: Array<{ kind: ArtefactRefKind; value: string; path: IssuePath }> = [];

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
    checkHooks(this.s.setup, ['setup'], this.ctx, { pages: pageKeys, saved });
    checkHooks(this.s.teardown, ['teardown'], this.ctx, { pages: pageKeys, saved });
    this.tokens(saved);
    this.misc();
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

      const page = typeof entry.page === 'string' ? entry.page : current;
      if (typeof entry.page === 'string' && this.pages && !Object.hasOwn(this.pages, entry.page)) {
        this.unknownPage(entry.page, [...p, 'page']);
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
        this.step(step, sp);
        if (step.action === 'open') visited.add((step.args as { page?: string }).page ?? pageKey);
      });
    });

    if (scenes.length > 0 && capturable === 0) {
      this.ctx.warning(['scenes'], 'nothing to capture: every entry is a card, an interstitial or a skipped scene');
    }
    for (const [id, path] of this.stepIds) {
      if (sceneIds.has(id)) this.ctx.warning([...path, 'id'], `step id "${id}" is also a scene id: --until "${id}" refers to the step`);
    }
  }

  /** `card:` — something to show: a component, or the `title` slot of the theme's card component. */
  private card(card: unknown, p: IssuePath): void {
    if (!isObj(card) || this.ctx.broken(p)) return;
    const slots = isObj(card.slots) ? card.slots : {};
    if (card.component === undefined && (typeof slots.title !== 'string' || slots.title.trim() === '')) {
      this.ctx.error(p, 'a card needs a `component` or a `slots.title` (the theme\'s card component shows a title)');
    }
    this.slotRefs(slots, [...p, 'slots']);
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
    if (inter.style !== undefined && inter.component !== undefined) {
      this.ctx.warning([...p, 'style'], '`style` (legacy) is ignored when `component` is set');
    }
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
    if (step.tutorial !== undefined) this.tutorial(step.tutorial, [...sp, 'tutorial'], 'step', step.action);
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

  private tokens(saved: Set<string>): void {
    const projectVars = Object.keys(this.opts.project?.config.vars ?? {});
    const scenarioVars = isObj(this.s.vars) ? Object.keys(this.s.vars) : [];
    const scope = {
      pages: this.pages ? Object.keys(this.pages) : undefined,
      vars: new Set([...projectVars, ...scenarioVars]),
      varsComplete: this.opts.project !== undefined,
      saved,
    };
    for (const key of ['setup', 'teardown', 'scenes'] as const) {
      const list = this.s[key];
      if (!Array.isArray(list)) continue;
      list.forEach((v, i) => {
        if (!this.ctx.broken([key, i])) checkTokens(v, [key, i], scope, this.ctx);
      });
    }
  }

  private misc(): void {
    this.checkArtefactRefs();
    this.checkFrameRefs();
    this.tutorial(this.s.tutorial, ['tutorial'], 'scenario');
    if (this.pages && this.switches.length > 0) {
      const known = new Set([...Object.keys(this.pages), ...STATIC_PAGE_IDS, ...this.tabIds]);
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
