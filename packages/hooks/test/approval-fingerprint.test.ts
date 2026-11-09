/**
 * The fingerprint a human approval is bound to (approval.ts hookFingerprint), frozen: its canonical JSON moved to core
 * (canonicalJson), and a fingerprint that changed would void every approval already given. The copy it replaced is
 * checked byte for byte against canonicalJson in core test/canonical-json.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { HookStep } from '@retake/core';
import { hookFingerprint } from '../src/index.js';

describe('hookFingerprint, frozen', () => {
  const shell = { shell: 'psql -f hooks/reset.sql', name: 'reset the demo', optional: true } as HookStep;
  const http = { http: { method: 'POST', url: '{{app}}/api/reset', headers: { 'X-B': '2', 'X-A': '1' }, body: { b: [1, 2], a: null } } } as unknown as HookStep;

  it('keeps its values for a hook, its place and its files', () => {
    expect([
      hookFingerprint(shell, { phase: 'setup', index: 0, env: 'staging' }),
      hookFingerprint(http, { phase: 'teardown', index: 2, env: 'local', files: { 'hooks/z.sql': 'f'.repeat(64), 'hooks/a.sql': 'a'.repeat(64) } }),
      hookFingerprint(http, { phase: 'setup', index: 1, env: 'local', files: {} }),
      hookFingerprint({ ...http, name: undefined } as unknown as HookStep, { phase: 'setup', index: 1, env: 'local' }),
    ]).toEqual([
      '42e47be6bcd85657fab60c5a8b50c1c85ac0d1da219b181e853a87927c2eb2bd',
      '17aadeec2e4f90da34d4c7699cccf1aa078d1cf6a7fe57aab96603c8f9cf0fca',
      // no files and an empty files map, an undefined key and none: one fingerprint
      '48528774e633870d7c8782d684121474a87cd7a6337c04b0d28b75954be14b2f',
      '48528774e633870d7c8782d684121474a87cd7a6337c04b0d28b75954be14b2f',
    ]);
  });
});
