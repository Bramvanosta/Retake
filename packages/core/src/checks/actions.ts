import { parseDay } from '../dates.js';
import type { IssuePath } from '../issues.js';
import { hasLocator, isPoint, pickTarget } from '../targets.js';
import type { NormalizedStep, TargetObject } from '../types.js';
import type { CheckContext } from './context.js';
import { isObj } from './context.js';

const LOCATOR_KEYS = 'text, contains, role, label, aria, placeholder, css or testid';

/** A target object must locate something: at least one locator key (recursively for `in` scopes). */
export function checkTarget(t: unknown, path: IssuePath, ctx: CheckContext): void {
  if (typeof t === 'string' || t === undefined || isPoint(t) || !isObj(t)) return;
  const o = t as TargetObject;
  if (!hasLocator(o)) ctx.error(path, `target needs at least one of ${LOCATOR_KEYS}`);
  if (o.name !== undefined && o.role === undefined) ctx.warning(path, '`name` is only used together with `role`');
  if (isObj(o.in) && !('row' in o.in)) checkTarget(o.in, [...path, 'in'], ctx);
}

/** What the scenario-level checks need to know about a step. */
export interface ActionFacts {
  /** `new_tab.as` page id declared by the step. */
  tabId?: string;
  /** `switch_page` target, checked once every page id is known. */
  switchTo?: { to: string; path: IssuePath };
  /** `open.page`, checked against the environment. */
  openPage?: { page: string; path: IssuePath };
  /** Artefact declared by the step (`wait_for_email.as` → email, `download.as` → document, `capture_text.as` → text). */
  artefact?: { kind: 'email' | 'document' | 'text'; name: string; path: IssuePath };
}

/** `search_cps` and `search_instant` (hotfix v0.2.5) are two ways to fill the search: one at a time. */
function searchPace(a: Record<string, unknown>, ap: IssuePath, ctx: CheckContext): void {
  if (a.search_instant === true && a.search_cps !== undefined) ctx.error([...ap, 'search_cps'], '`search_instant` fills the search at once: `search_cps` (its typing pace) does not apply — keep one');
}

/** Rules the schema cannot express (required-one-of, conflicting keys, empty targets, files). */
export function checkActionArgs(step: NormalizedStep, sp: IssuePath, ctx: CheckContext): ActionFacts {
  const ap: IssuePath = [...sp, step.action];
  const a = step.args as unknown as Record<string, unknown>;
  const rawArg = (step.raw as Record<string, unknown>)[step.action];
  const target = (t: unknown, ...keys: Array<string | number>) => checkTarget(t, [...ap, ...keys], ctx);

  switch (step.action) {
    case 'click':
    case 'double_click':
      if (a.outside !== undefined && a.outside !== false) {
        if (hasLocator(pickTarget(a))) ctx.warning(ap, '`outside` clicks a neutral spot: the target keys are ignored');
        target(a.outside, 'outside');
      } else {
        target(pickTarget(a));
      }
      break;
    case 'hover':
      target(pickTarget(a));
      break;
    case 'type':
      target(a.into, 'into');
      if (a.fill === true && a.cps !== undefined) ctx.error([...ap, 'cps'], '`fill` sets the value at once: `cps` (the typing pace) does not apply — keep one');
      break;
    case 'select':
      if (a.combobox === undefined && a.field === undefined) {
        ctx.error(ap, 'select needs `combobox` (the trigger) or `field` (its label)');
      } else if (a.combobox !== undefined && a.field !== undefined) {
        ctx.error(ap, 'select takes `combobox` or `field`, not both');
      }
      target(a.combobox, 'combobox');
      searchPace(a, ap, ctx);
      break;
    case 'pick':
      target(a.field, 'field');
      searchPace(a, ap, ctx);
      break;
    case 'menu':
      if (a.row === undefined && a.trigger === undefined) ctx.error(ap, 'menu needs `row` (text in the row) or `trigger`');
      target(a.row, 'row');
      target(a.trigger, 'trigger');
      break;
    case 'date': {
      target(a.field, 'field');
      target(a.next, 'next');
      target(a.previous, 'previous');
      const days = Array.isArray(a.day) ? (a.day as unknown[]) : [a.day];
      days.forEach((d, i) => {
        if (typeof d !== 'string' || d.includes('{{') || parseDay(d) !== null) return;
        // Not a date the runner reads (ISO, English long forms): matched as words of the day labels.
        const path = typeof rawArg === 'string' ? ap : Array.isArray(a.day) ? [...ap, 'day', i] : [...ap, 'day'];
        const what = /\b(1[89]|2\d)\d{2}\b/.test(d) ? 'is not a date the runner reads (2027-01-10, 10 January 2027, January 10, 2027)' : 'has no year';
        ctx.warning(path, `"${d}" ${what}: it is matched by its label only, and the calendar can only be paged forward to find it`);
      });
      break;
    }
    case 'scroll': {
      if (a.to === undefined && a.by === undefined) ctx.error(ap, 'scroll needs `to` or `by`');
      else if (a.to !== undefined && a.by !== undefined) ctx.error(ap, 'scroll takes `to` or `by`, not both');
      const toIsTarget = a.to !== undefined && typeof a.to !== 'number' && a.to !== 'top' && a.to !== 'bottom';
      if (a.offset !== undefined && !toIsTarget) ctx.warning([...ap, 'offset'], '`offset` only applies when `to` is a target');
      if (toIsTarget) target(a.to, 'to');
      target(a.in, 'in');
      break;
    }
    case 'drag':
      target(a.from, 'from');
      target(a.to, 'to');
      break;
    case 'drop_file':
      if (a.path === undefined && a.fake !== true) {
        ctx.error(ap, 'drop_file needs `path` (a file in the project) or `fake: true` with `name`');
      }
      if (a.fake === true && a.name === undefined) ctx.error(ap, '`fake: true` needs a file `name`');
      if (a.fake === true && a.path !== undefined) ctx.warning([...ap, 'path'], '`path` is ignored with `fake: true`');
      if (typeof a.path === 'string' && a.fake !== true) ctx.file(a.path, [...ap, 'path'], 'file', 'error');
      target(a.zone, 'zone');
      target(a.input, 'input');
      break;
    case 'wait_for':
    case 'assert': {
      const extra = step.action === 'wait_for' ? ['network_idle'] : ['title', 'count'];
      const keys = ['text', 'not_text', 'target', 'gone', 'url', ...extra];
      if (!keys.some((k) => a[k] !== undefined)) ctx.error(ap, `${step.action} needs one of ${keys.join(', ')}`);
      target(a.target, 'target');
      target(a.gone, 'gone');
      if (isObj(a.count)) target(a.count.target, 'count', 'target');
      break;
    }
    case 'new_tab':
      if (a.target === undefined && a.href === undefined) ctx.error(ap, 'new_tab needs a `target` to click or an `href`');
      target(a.target, 'target');
      return typeof a.as === 'string' ? { tabId: a.as } : {};
    case 'switch_page':
      return { switchTo: { to: String(a.to), path: typeof rawArg === 'string' ? ap : [...ap, 'to'] } };
    case 'eval':
      if (!a.js === !a.file) ctx.error(ap, 'eval needs exactly one of `js` or `file`');
      if (typeof a.file === 'string') ctx.file(a.file, [...ap, 'file'], 'JS file', 'error');
      break;
    case 'cursor':
      if (isObj(rawArg)) {
        if (rawArg.move === undefined && rawArg.set === undefined && rawArg.show === undefined) {
          ctx.error(ap, 'cursor needs `move`, `set` or `show`');
        } else if (rawArg.move !== undefined && rawArg.set !== undefined) {
          ctx.error(ap, 'cursor takes `move` or `set`, not both');
        }
        target(rawArg.move, 'move');
      }
      break;
    case 'open':
      return typeof a.page === 'string' ? { openPage: { page: a.page, path: [...ap, 'page'] } } : {};
    case 'wait_for_email':
      if (a.to === undefined && a.from === undefined && a.subject === undefined) {
        ctx.warning(ap, 'wait_for_email without `to`, `from` or `subject` captures the first new message, whatever it is');
      }
      if (typeof a.subject === 'string' && /^\/.*\/[a-z]*$/.test(a.subject)) {
        const m = /^\/(.*)\/([a-z]*)$/.exec(a.subject)!;
        try {
          new RegExp(m[1], m[2]);
        } catch (e) {
          ctx.error([...ap, 'subject'], `invalid regular expression ${a.subject}: ${(e as Error).message}`);
        }
      }
      return typeof a.as === 'string' ? { artefact: { kind: 'email', name: a.as, path: [...ap, 'as'] } } : {};
    case 'capture_text':
      target(a.target, 'target');
      if (typeof a.pattern === 'string') {
        const m = /^\/(.*)\/([a-z]*)$/.exec(a.pattern);
        try {
          new RegExp(m ? m[1] : a.pattern, m ? m[2] : '');
        } catch (e) {
          ctx.error([...ap, 'pattern'], `invalid regular expression ${a.pattern}: ${(e as Error).message}`);
        }
      }
      return typeof a.as === 'string' ? { artefact: { kind: 'text', name: a.as, path: [...ap, 'as'] } } : {};
    case 'download':
      target(pickTarget(a.click as Record<string, unknown>), 'click');
      return typeof a.as === 'string' ? { artefact: { kind: 'document', name: a.as, path: [...ap, 'as'] } } : {};
    default:
      break;
  }
  return {};
}
