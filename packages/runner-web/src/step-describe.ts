/** How a step reads in progress events, and a caption as the timeline records it. */
import { describeTarget, isPoint } from '@retake/core/language';
import type { CaptionSpec, NormalizedStep, TargetSpec } from '@retake/core/language';
import { primaryTarget } from './actions/index.js';

export function caption(c: CaptionSpec | undefined): { kicker?: string; text: string } | undefined {
  if (c === undefined) return undefined;
  return typeof c === 'string' ? { text: c } : { ...c };
}

/** Short description of a step for progress events. */
export function describeStep(step: NormalizedStep): string {
  const a = step.args as unknown as Record<string, unknown>;
  const t = primaryTarget(step);
  const td = t ? describeTarget(t) : '';
  switch (step.action) {
    case 'open':
      return String(a.url);
    case 'click':
      return td || (a.outside !== undefined && typeof a.outside === 'object' ? `outside → ${describeTarget(a.outside as TargetSpec)}` : 'outside');
    case 'wait':
    case 'hold':
      return `${a.seconds} s`;
    case 'type':
      return `${JSON.stringify(a.text)}${td ? ` into ${td}` : ''}`;
    case 'press':
      return `${a.key}${a.times ? ` ×${a.times}` : ''}`;
    case 'select':
    case 'pick':
      return `${JSON.stringify(a.option)} in ${td}`;
    case 'menu':
      return `${td} → ${JSON.stringify(a.item)}${a.confirm ? ' + confirm' : ''}`;
    case 'date':
      return `${JSON.stringify(a.day)}${td ? ` in ${td}` : ''}`;
    case 'scroll':
      return a.to !== undefined ? `to ${typeof a.to === 'object' ? describeTarget(a.to as TargetSpec) : a.to}` : `by ${a.by}`;
    case 'wait_for':
    case 'assert':
      return JSON.stringify(a).slice(0, 100);
    case 'screenshot':
      return String(a.name);
    case 'hook':
      return `${a.name} (off camera)`;
    case 'switch_page':
      return String(a.to);
    case 'emit':
      return String(a.name);
    case 'notify':
      return String(a.message);
    case 'wait_for_email': {
      const f = [a.to && `to ${a.to}`, a.from && `from ${a.from}`, a.subject && `subject ${a.subject}`].filter(Boolean).join(', ');
      return `${f || 'any new message'} → ${a.as}`;
    }
    case 'download':
      return `${td} → ${a.as}`;
    case 'capture_text':
      return `${describeTarget(a.target as TargetSpec)}${a.pattern ? ` ${String(a.pattern)}` : ''} → ${a.as}`;
    case 'cursor':
      return `${a.mode}${a.to ? ` ${isPoint(a.to) ? `(${(a.to as { x: number }).x}, ${(a.to as { y: number }).y})` : describeTarget(a.to as TargetSpec)}` : ''}`;
    default:
      return td || (step.action === 'new_tab' && a.href ? String(a.href) : '');
  }
}
