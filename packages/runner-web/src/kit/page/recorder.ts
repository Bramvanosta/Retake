/** The recorder's helpers: the inventory entry of the element a person acted on, secret fields. */
import type { InventoryElement } from '../types.js';
import type { SecretFieldKind } from '@retake/core';
import { RT } from './clock.js';
import { inventory } from './inventory.js';
import { deref, ref } from './refs.js';
import { cssEscape, labelPairs, labelTarget } from './resolver.js';
import { INTERACTIVE, treeOf } from './roles.js';
import { lc } from './text.js';
import { deepClosest, isA, upOf } from './trees.js';
import { isVisible } from './visibility.js';

// ───────────────────────────── recorder (L3.4) ─────────────────────────────
/**
 * The inventory's entry for the interactive element a person acted on (`target`: the event's element, or a ref): the
 * element itself when it is interactive, else its nearest interactive ancestor — a label's control first, a hidden
 * file input's label or zone. Null when nothing interactive holds it. One `inventory({within, limit: 1})` per try
 * (at most 4), each with the per-call memo and the time budget (default 150 ms).
 */
export function suggestFor(target: Element | string, opts: { budget_ms?: number; alternatives?: number; alternatives_budget_ms?: number } = {}): InventoryElement | null {
  const el = typeof target === 'string' ? deref(target) : target;
  if (!el || !el.isConnected) return null;
  const tries: Element[] = [];
  const add = (e: Element | null) => {
    if (e && !tries.includes(e)) tries.push(e);
  };
  if (isA(el, 'label')) add(labelTarget(el));
  if (isA(el, 'input') && el.type === 'file' && !isVisible(el)) {
    add(el.closest('label'));
    if (el.id) add(treeOf(el).querySelector(`label[for="${cssEscape(el.id)}"]`));
  }
  for (let n: Element | null = deepClosest(el, INTERACTIVE), i = 0; n && i < 4; n = deepClosest(upOf(n), INTERACTIVE), i++) add(n);
  const budget = Math.max(20, opts.budget_ms ?? 150);
  const t0 = RT.performance.now();
  for (const c of tries.slice(0, 4)) {
    const left = budget - (RT.performance.now() - t0);
    if (left <= 0) break;
    const inv = inventory({
      within: ref(c),
      limit: 1,
      budget_ms: Math.max(20, left),
      ...(opts.alternatives ? { alternatives: opts.alternatives, alternatives_budget_ms: opts.alternatives_budget_ms } : {}),
    });
    if (inv.elements[0]) return inv.elements[0];
  }
  return null;
}
/** Words of a field that make it a secret one (camelCase / snake_case split first), and the kind each names. */
const SECRET_WORDS: Array<[RegExp, SecretFieldKind]> = [
  [/\b(one ?time|otp|totp|2fa|mfa|verification code)\b/, 'one_time_code'],
  [/\b(cvc|cvv|csc|cvc2|cvv2|security code|card code)\b/, 'card_code'],
  [/\b(card ?number|cc ?number|cc ?num|credit ?card|pan)\b/, 'card_number'],
  [/\biban\b/, 'iban'],
  [/\b(ssn|social security|national id|tax id)\b/, 'national_id'],
  [/pass ?(word|code|phrase)|\bpasswd\b|\bpwd\b/, 'password'],
  [/\bpin\b/, 'pin'],
  [/\b(api ?key|access ?key|secret ?key|private ?key|client ?secret)\b|\btoken\b/, 'api_key'],
  [/\bsecret\b/, 'secret'],
];
/**
 * The kind of secret a field holds (null: not a secret-class field): a password input; autocomplete current- /
 * new-password, one-time-code, cc-*; a name, id, label, aria-label, placeholder, title or test id naming a password,
 * code, card number, CVC, IBAN, PIN, token or key; one of ≥ 4 adjacent one-character inputs (one-time-code boxes).
 * Never reads a value.
 */
export function secretKind(el: Element): SecretFieldKind | null {
  const input = isA(el, 'input') ? el : null;
  if (input) {
    if (!['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(input.type)) return null;
  } else if (!isA(el, 'textarea') && (el as HTMLElement).isContentEditable !== true && !el.matches('[role=textbox],[role=searchbox]')) return null;
  const ac = lc(el.getAttribute('autocomplete') ?? '');
  if (/\bone-time-code\b/.test(ac)) return 'one_time_code';
  if (input?.type === 'password' || /\b(current|new)-password\b/.test(ac)) return 'password';
  if (/\bcc-number\b/.test(ac)) return 'card_number';
  if (/\bcc-csc\b/.test(ac)) return 'card_code';
  if (/\bcc-exp/.test(ac)) return 'card_expiry';
  if (/\bcc-/.test(ac)) return 'card_number';
  let label = '';
  for (const p of labelPairs(el.ownerDocument.body ?? el.ownerDocument.documentElement)) if (p.control === el) label += ` ${p.text}`;
  const words = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('data-testid'), label]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.:]+/g, ' ')
    .toLowerCase();
  for (const [re, kind] of SECRET_WORDS) if (re.test(words)) return kind;
  // One-time-code boxes: this one-character input and ≥ 3 more of them in its parent or grandparent.
  if (input && input.maxLength === 1) {
    for (let box: Element | null = input.parentElement, i = 0; box && i < 2; box = box.parentElement, i++) {
      const n = Array.from(box.querySelectorAll('input')).filter((x) => (x as HTMLInputElement).maxLength === 1).length;
      if (n >= 4) return 'one_time_code';
    }
  }
  return null;
}
