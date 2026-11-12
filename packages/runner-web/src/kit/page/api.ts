/** The kit's API, `window.__retake`: what the runner calls (types.ts `KitApi`). */
import type { KitApi } from '../types.js';
import { calendar, setNativeValue } from './calendar.js';
import { changedBoxes, watchChanges } from './changes.js';
import { checkTargets, closest, fieldValue, focusCheck } from './target-checks.js';
import { domClick, pointerSequence } from './clicks.js';
import { RT } from './clock.js';
import { config } from './config.js';
import { cursorApi, ghost } from './cursor.js';
import { lookCss, lookHtml } from './cursor-look.js';
import { effectSeen, effectStop, effectWatch } from './click-effects.js';
import { clearField, editableBody, fieldState, isTextInput, selectNative } from './fields.js';
import { fileDrag } from './file-drag.js';
import { inventory } from './inventory.js';
import { VERSION, dispose, healthy } from './lifecycle.js';
import { outsidePlan, popupState, restNear, restPoint, textBox } from './placement.js';
import { pointFor } from './points.js';
import { secretKind, suggestFor } from './recorder.js';
import { deref, ref } from './refs.js';
import { describeEl, fieldTriggerEl, find, popupExpected, rowFor } from './resolver.js';
import { roleOf } from './roles.js';
import { scrollAnimate, scrollContainerFor, scrollInfo, scrollPlan } from './scrolling.js';
import { norm, short, textOf } from './text.js';
import { deepActive, frameElOf, isA } from './trees.js';
import { confirmButton, fileInputFor, menuTrigger, positionalTrigger } from './triggers.js';
import { bboxOf, isVisible, textVisible } from './visibility.js';

export const api: KitApi = {
  version: VERSION,
  healthy,
  dispose,
  config,
  cursor: cursorApi,
  cursorLook: { css: lookCss, html: lookHtml },
  ghost,
  fileDrag,
  find,
  el: (id) => deref(id),
  alive: (id) => deref(id) !== null,
  visible: (id) => {
    const el = deref(id);
    return el !== null && isVisible(el);
  },
  point: pointFor,
  scrollPlan,
  scrollContainerFor,
  scrollInfo,
  scrollAnimate,
  afterPaint: () =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      RT.setTimeout(finish, 150);
      RT.requestAnimationFrame(() => RT.requestAnimationFrame(finish));
    }),
  popupState,
  expanded: (id) => deref(id)?.getAttribute('aria-expanded') ?? null,
  outsidePlan,
  blankPoint: (near) => {
    const p = outsidePlan(
      near,
      popupState().map((e) => e.id),
    );
    return p ? { x: p.x, y: p.y } : null;
  },
  dragGhost: ghost,
  restPoint,
  restNear,
  watchChanges,
  changedBoxes,
  textBox: (id) => {
    const el = deref(id);
    return el ? textBox(el) : null;
  },
  hasText: textVisible,
  snapshot: (id, max) => {
    const el = id ? deref(id) : document.body;
    let html = el ? el.outerHTML : document.documentElement.outerHTML;
    html = html.replace(/<retake-cursor[\s\S]*?<\/retake-cursor>/g, '');
    if (html.length <= max) return html;
    // Cut after the last complete tag within the cap (a cut inside a tag would be unreadable).
    let cut = html.lastIndexOf('>', max - 1) + 1;
    if (cut < max * 0.75) cut = max;
    return html.slice(0, cut) + `\n<!-- … trimmed to ${cut} of ${html.length} chars -->`;
  },
  domClick,
  pointerSequence,
  rowFor: (text) => {
    const r = rowFor(text);
    return r ? ref(r) : null;
  },
  menuTrigger,
  positionalTrigger,
  fieldTrigger: (label) => {
    const el = fieldTriggerEl(label, document.body);
    return el ? ref(el) : null;
  },
  confirmButton,
  fileInputFor,
  selectNative,
  isTextInput,
  fieldState,
  clearField,
  calendar,
  setNativeValue,
  describe: (id) => {
    const el = deref(id);
    return el ? describeEl(el) : '(gone)';
  },
  info: (id) => {
    const el = deref(id);
    if (!el) return null;
    const a = el.closest('a[href]') as HTMLAnchorElement | null;
    return {
      desc: describeEl(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      text: short(textOf(el)),
      href: a ? a.href : null,
      popup_expected: popupExpected(el),
      input_type: isA(el, 'input') ? el.type : null,
    };
  },
  textOf: (id) => {
    const el = deref(id);
    return el ? short(textOf(el), 200) : '';
  },
  focused: () => {
    // The focused field (type steps without `into`): its description and box, when it is visible; `input_type` tells
    // a password field (its text shows as bullets) from a field that shows what is typed.
    let el = deepActive();
    let edited = el !== null && editableBody(el);
    // The body of a frame (an editor drawn in a frame, or a frame holding the focus): the frame is what is seen.
    if (el && el.ownerDocument !== document && (el === el.ownerDocument.body || el === el.ownerDocument.documentElement)) el = frameElOf(el.ownerDocument);
    if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement || !isVisible(el)) return null;
    edited ||= (el as HTMLElement).isContentEditable === true;
    const input_type = isA(el, 'input') ? el.type : edited ? 'contenteditable' : el.tagName.toLowerCase();
    return { desc: describeEl(el), bbox: bboxOf(el), input_type };
  },
  visibleText: (id) => {
    const el = deref(id);
    if (!el) return '';
    const raw = isA(el, 'input') || isA(el, 'textarea') ? el.value : typeof (el as HTMLElement).innerText === 'string' ? (el as HTMLElement).innerText : el.textContent;
    return norm(raw).slice(0, 2000);
  },
  inventory,
  checkTargets,
  closest,
  focusCheck,
  fieldValue,
  effectWatch,
  effectSeen,
  effectStop,
  suggestFor,
  secretField: (target) => {
    const el = typeof target === 'string' ? deref(target) : target;
    return el ? secretKind(el) : null;
  },
};
