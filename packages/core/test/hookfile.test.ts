import { describe, expect, it } from 'vitest';
import { parseHookFile } from '@retake/core';
import type { LoadedProject } from '@retake/core';
import { DEFAULT_CAPTURE } from '@retake/core';

const project: LoadedProject = {
  slug: 'demo',
  dir: '/nonexistent/demo',
  root: '/nonexistent',
  config: {
    name: 'Demo',
    environments: { staging: { app: 'https://app.staging.example.com' } },
    capture: DEFAULT_CAPTURE,
    frame: 'card',
    template: 'default',
    vars: { account: 'demo' },
  },
  readme: null,
  scenarios: [],
  file: '/nonexistent/demo/project.yaml',
};

describe('parseHookFile', () => {
  it('accepts a list of hooks', () => {
    const { hooks, issues } = parseHookFile(
      '- name: seed\n  http: {method: POST, url: "{{app}}/api/seed/{{vars.account}}", rollback: {method: DELETE, url: "{{app}}/api/seed/{{response.json.id}}"}}\n',
      { project },
    );
    expect(issues).toEqual([]);
    expect(hooks).toHaveLength(1);
  });

  it('reports positioned errors: typos, destructive hooks without confirm, unknown template keys', () => {
    const text = [
      '- name: wipe', // 1
      '  http: {method: DELETE, url: "{{app}}/api/all"}', // 2
      '- shell: {run: "echo hi", timout: 3}', // 3
      '- http: {url: "{{ap}}/x"}', // 4
    ].join('\n');
    const { hooks, issues } = parseHookFile(text, { project });
    expect(hooks).toBeUndefined();
    const messages = issues.map((i) => `${i.line}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^2: destructive hook \(HTTP DELETE\) requires "confirm: true"/),
        expect.stringMatching(/^3: .*"timout".*did you mean "timeout"/),
        expect.stringMatching(/^4: unknown template key \{\{ap\}\}/),
      ]),
    );
  });

  it('shell hooks naming a host outside the allow-list are errors, before anything runs (R-SEC-06)', () => {
    const { hooks, issues } = parseHookFile('- shell: "curl -fsS https://elsewhere.invalid/reset"\n- shell: "curl {{app}}/ok"\n', { project });
    expect(hooks).toBeUndefined();
    expect(issues.map((i) => `${i.line}: ${i.message}`)).toEqual([
      '1: shell hook names host elsewhere.invalid (URL): it is not allowed: use localhost, an environment host, or add it to allow_hosts (allowed: localhost, 127.0.0.1, ::1, app.staging.example.com)',
    ]);
  });

  it('rejects a document that is not a list', () => {
    const { hooks, issues } = parseHookFile('http: {url: "https://x.example.com"}\n');
    expect(hooks).toBeUndefined();
    expect(issues[0]).toMatchObject({ severity: 'error', line: 1 });
  });
});
