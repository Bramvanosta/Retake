/** `retake doctor` shows a worker lock's texts with every hidden character (core hidden-chars.ts) as `?`, capped. */
import { describe, expect, it } from 'vitest';
import { lockText } from '../src/commands/doctor.js';

describe('lockText', () => {
  it('each hidden character as ?, at most 300 characters', () => {
    expect(lockText('ui')).toBe('ui');
    expect(lockText('u\u202ei\u00ad\u2800\n')).toBe('u?i???');
    expect(lockText('x'.repeat(400))).toHaveLength(300);
  });
});
