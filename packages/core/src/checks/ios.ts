/**
 * A scenario on an iOS environment (`ios:` in project.yaml): the steps, targets, keys and scene keys the iOS driver
 * plays, every other one refused where it is written (its line). Called by the scenario checks once the environment
 * is known to be an iOS one.
 */
import { isPoint, looksLikeCss } from '../targets.js';
import type { IssuePath } from '../issues.js';
import { hookStepName } from '../named-hooks.js';
import { stepActionKeys } from '../steps.js';
import { isObj } from './context.js';
import type { CheckContext } from './context.js';

/** The steps an iOS environment plays (the driver's: tap, type, the keys, swipes, deep links, waits, checks, hooks). */
export const IOS_STEP_ACTIONS: readonly string[] = ['click', 'type', 'press', 'scroll', 'open', 'wait', 'wait_for', 'hold', 'assert', 'screenshot', 'hook', 'emit'];

/** The keys `press` sends on iOS (the on-screen keyboard's return and delete keys), compared without case. */
export const IOS_PRESS_KEYS: readonly string[] = ['Enter', 'Return', 'Backspace', 'Delete'];

/** The roles an iOS target names (`role:`, mapped to the app's element types: button, text field, switch, text, cell). */
export const IOS_TARGET_ROLES: readonly string[] = ['button', 'textbox', 'checkbox', 'switch', 'heading', 'text', 'cell', 'row'];

/** The keys of an iOS target (the app's accessibility: its label, value, identifier, element type, placeholder). */
export const IOS_TARGET_KEYS: readonly string[] = ['text', 'label', 'aria', 'testid', 'role', 'name', 'placeholder', 'nth', 'exact'];

/** Keys of a capture scene a web page needs and an iOS environment has no use for. */
const REFUSED_SCENE_KEYS: Readonly<Record<string, string>> = {
  pages: 'an iOS environment films one device: a multi-page scene is a browser scene',
  page: 'an iOS environment has no pages',
  persona: 'an iOS environment signs nobody in',
};

/** Step arguments the iOS driver does not play, per action, with why. */
const REFUSED_ARGS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  open: { page: 'an iOS environment has no pages', wait_until: 'a deep link has no page load to wait for' },
  scroll: { in: 'a swipe scrolls what is under it', offset: 'a swipe brings the target into view' },
  wait_for: { url: 'the app has no address', network_idle: "the app's requests are not watched" },
  assert: { url: 'the app has no address', title: 'the app has no page title' },
  screenshot: { full_page: 'the screenshot is the screen' },
};

/** A secret reference in a value (`{{env:…}}`, `{{keychain:…}}`, `{{secret:…}}`, a sandbox's compose env, an account's password). */
const SECRET_TOKEN = /\{\{\s*(?:(?:env|keychain|secret|compose_env):|accounts\.[^.\s{}]+\.password\s*\}\})/;

export interface IosScenarioOptions {
  /** The iOS environment's name (for the messages). */
  envName: string;
  /** project.yaml's named hooks (what a `hook: <name>` step runs when the scenario has none of that name). */
  projectHooks?: Record<string, unknown>;
}

/** Every step, target, key and hook of the scenario `s` the iOS driver cannot play, as errors at their place. */
export function checkIosScenario(s: Record<string, unknown>, ctx: CheckContext, o: IosScenarioOptions): void {
  const c = new IosChecker(s, ctx, o);
  c.scenes();
  c.hooks();
}

class IosChecker {
  private readonly on: string;

  constructor(
    private readonly s: Record<string, unknown>,
    private readonly ctx: CheckContext,
    private readonly o: IosScenarioOptions,
  ) {
    this.on = `on iOS environment ${o.envName}`;
  }

  scenes(): void {
    const scenes = Array.isArray(this.s.scenes) ? this.s.scenes : [];
    scenes.forEach((entry, i) => {
      if (!isObj(entry) || 'card' in entry || 'interstitial' in entry) return;
      const p: IssuePath = ['scenes', i];
      for (const [key, why] of Object.entries(REFUSED_SCENE_KEYS)) {
        if (entry[key] !== undefined) this.ctx.error([...p, key], `\`${key}\` is not available ${this.on}: ${why}`, { path: [...p, key], key: true });
      }
      (Array.isArray(entry.steps) ? entry.steps : []).forEach((raw, j) => {
        const sp: IssuePath = [...p, 'steps', j];
        if (isObj(raw) && !this.ctx.broken(sp)) this.step(raw, sp);
      });
    });
  }

  private step(raw: Record<string, unknown>, sp: IssuePath): void {
    const [action] = stepActionKeys(raw);
    if (action === undefined) return;
    if (raw.park !== undefined) this.ctx.error([...sp, 'park'], `\`park\` is not available ${this.on}: a touch leaves no cursor to park`, { path: [...sp, 'park'], key: true });
    if (!IOS_STEP_ACTIONS.includes(action)) {
      this.ctx.error([...sp, action], `${action} is not available ${this.on} (iOS steps: ${IOS_STEP_ACTIONS.join(', ')})`, { path: [...sp, action], key: true });
      return;
    }
    const v = raw[action];
    const at: IssuePath = [...sp, action];
    const refused = REFUSED_ARGS[action];
    if (refused && isObj(v)) {
      for (const [key, why] of Object.entries(refused)) {
        if (v[key] !== undefined) this.ctx.error([...at, key], `\`${action}.${key}\` is not available ${this.on}: ${why}`, { path: [...at, key], key: true });
      }
    }
    switch (action) {
      case 'click':
        if (!isPoint(v)) this.target(v, at);
        return;
      case 'type':
        this.typed(v, at);
        return;
      case 'press':
        this.press(v, at);
        return;
      case 'scroll':
        this.scroll(v, at);
        return;
      case 'wait_for':
      case 'assert':
        if (!isObj(v)) return;
        for (const key of ['target', 'gone'] as const) if (v[key] !== undefined) this.target(v[key], [...at, key]);
        if (isObj(v.count) && v.count.target !== undefined) this.target(v.count.target, [...at, 'count', 'target']);
        return;
      case 'hook':
        this.namedHook(raw, at);
        return;
    }
  }

  /** `type`: its field is a target; a secret is never typed on iOS (the simulator's keyboard shows every key it types). */
  private typed(v: unknown, at: IssuePath): void {
    const text = typeof v === 'string' ? v : isObj(v) ? v.text : undefined;
    if (isObj(v) && v.into !== undefined) this.target(v.into, [...at, 'into']);
    if (typeof text === 'string' && SECRET_TOKEN.test(text)) {
      this.ctx.error(
        typeof v === 'string' ? at : [...at, 'text'],
        `a secret is not typed ${this.on}: the simulator's keyboard shows each key it types, and the video would show the secret — type a value made for the video, or sign in before the take`,
      );
    }
  }

  private press(v: unknown, at: IssuePath): void {
    const key = typeof v === 'string' ? v : isObj(v) && typeof v.key === 'string' ? v.key : undefined;
    if (key === undefined || IOS_PRESS_KEYS.some((k) => k.toLowerCase() === key.trim().toLowerCase())) return;
    this.ctx.error(typeof v === 'string' ? at : [...at, 'key'], `key "${key}" is not available ${this.on}: the on-screen keyboard sends ${IOS_PRESS_KEYS.join(', ')} (no shortcut, no Escape, no Tab)`);
  }

  private scroll(v: unknown, at: IssuePath): void {
    const to = isObj(v) ? v.to : v;
    const toAt = isObj(v) ? [...at, 'to'] : at;
    if (to === 'top' || to === 'bottom') {
      this.ctx.error(toAt, `\`scroll: ${to}\` is not available ${this.on} yet: swipe by a distance (\`by:\`) or to an element (\`to: <target>\`)`);
      return;
    }
    if (to !== undefined && typeof to !== 'number') this.target(to, toAt);
  }

  /** A target as the app's accessibility names an element: never a CSS selector, a scope or "the last visible". */
  private target(v: unknown, at: IssuePath): void {
    if (this.ctx.broken(at)) return;
    const keys = IOS_TARGET_KEYS.join(', ');
    if (typeof v === 'string') {
      if (looksLikeCss(v)) this.ctx.error(at, `"${v}" reads as a CSS selector, and an iOS app has none ${this.on}: name the element by its text, or {${keys}}`);
      return;
    }
    if (!isObj(v)) return;
    for (const key of Object.keys(v)) {
      if (IOS_TARGET_KEYS.includes(key)) continue;
      this.ctx.error([...at, key], `\`${key}\` is not available in a target ${this.on} (target keys: ${keys})`, { path: [...at, key], key: true });
    }
    if (typeof v.role === 'string' && !IOS_TARGET_ROLES.includes(v.role)) {
      this.ctx.error([...at, 'role'], `role "${v.role}" is not available ${this.on} (roles: ${IOS_TARGET_ROLES.join(', ')})`);
    }
  }

  /** `hook: <name>`: the named hook it runs (the scenario's, else project.yaml's) is no js hook (no browser page). */
  private namedHook(raw: Record<string, unknown>, at: IssuePath): void {
    const name = hookStepName(raw);
    if (name === undefined) return;
    const own = isObj(this.s.hooks) && Object.hasOwn(this.s.hooks, name) ? this.s.hooks[name] : undefined;
    const hook = own ?? (this.o.projectHooks && Object.hasOwn(this.o.projectHooks, name) ? this.o.projectHooks[name] : undefined);
    if (own === undefined && hook !== undefined && (Array.isArray(hook) ? hook : [hook]).some((h) => isObj(h) && h.js !== undefined)) {
      this.ctx.error(at, `hook "${name}" of project.yaml is a js hook, which is not available ${this.on}: a js hook runs in a browser page (use shell, http or sql)`);
    }
  }

  /** The scenario's setup, teardown and named hooks: no js hook (it runs in a browser page). */
  hooks(): void {
    const one = (h: unknown, p: IssuePath) => {
      if (isObj(h) && h.js !== undefined) this.ctx.error([...p, 'js'], `a js hook is not available ${this.on}: it runs in a browser page (use shell, http or sql)`, { path: [...p, 'js'], key: true });
    };
    for (const phase of ['setup', 'teardown'] as const) {
      const list = this.s[phase];
      if (Array.isArray(list)) list.forEach((h, i) => one(h, [phase, i]));
    }
    if (isObj(this.s.hooks)) {
      for (const [name, v] of Object.entries(this.s.hooks)) {
        if (Array.isArray(v)) v.forEach((h, i) => one(h, ['hooks', name, i]));
        else one(v, ['hooks', name]);
      }
    }
  }
}
