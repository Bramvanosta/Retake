import { describe, expect, it } from 'vitest';
import { describeHook, hookKindOf } from '@retake/hooks';
import type { HookStep } from '@retake/core';

describe('describeHook', () => {
  it.each<[HookStep, string]>([
    [{ http: { method: 'POST', url: '{{console}}/api/replies', save_as: 'reply' } }, 'http POST {{console}}/api/replies → hooks.reply'],
    [{ http: { url: '{{shop}}/api/health' } }, 'http GET {{shop}}/api/health'],
    [{ name: 'remove duplicate refs', sql: 'hooks/remove-registry-refs.sql' }, 'remove duplicate refs: sql hooks/remove-registry-refs.sql'],
    [{ sql: { query: "UPDATE offers   SET rights_until = DATE '2027-12-31'\n WHERE region = 'Sweden'", db: 'main' } }, `sql "UPDATE offers SET rights_until = DATE '2027-12-31' WHERE re…" on main`],
    [{ shell: { run: 'pnpm run seed --roasters 3', rollback: 'pnpm run unseed' } }, 'shell "pnpm run seed --roasters 3"'],
    [{ js: { file: 'hooks/dismiss-banner.js', page: 'shop' } }, 'js hooks/dismiss-banner.js on page shop'],
    [{ http: { url: '{{console}}/x', headers: { authorization: 'Bearer {{env:NF_TOKEN}}' } } }, 'http GET {{console}}/x'],
  ])('%j', (hook, expected) => {
    expect(describeHook(hook)).toBe(expected);
  });

  it('truncates long inline code and flags malformed hooks', () => {
    expect(describeHook({ js: 'x'.repeat(200) })).toBe(`js "${'x'.repeat(59)}…"`);
    expect(describeHook({} as HookStep)).toBe('invalid hook');
    expect(() => hookKindOf({ name: 'x' } as HookStep)).toThrow('a hook needs one of: http, sql, shell, js (keys: name)');
  });
});
