/**
 * Hotfix v0.2.3 — the validation of what a hook reads from its sandbox: `{{compose_env:NAME}}` and
 * `{{accounts.<persona>.username|password}}` are accepted in hooks (a scenario's, project.yaml's, a sandbox seed's —
 * there checked against its own accounts) and refused in what a scene does or shows; `auth: {persona}` on an http hook
 * names a persona of the scenario's environment, is not in a seed, and never beside an Authorization / Cookie header.
 * Through MCP a scenario names none of them (agent trust).
 */
import { describe, expect, it } from 'vitest';
import { agentTrustProblems, parseSandboxYaml, validateScenario } from '@retake/core';
import type { Scenario, ValidationIssue } from '@retake/core';
import { errors, fakeProject } from './helpers.js';

const msgs = (issues: ValidationIssue[]) => errors(issues).map((i) => `${i.path.join('.')}: ${i.message}`);

const project = () =>
  fakeProject(undefined, {
    auth: { login_url: '/sign-in', personas: { buyer: { pages: ['console'] }, admin: { pages: ['console'] } } },
  });

const scenario = (extra: Record<string, unknown>): Scenario =>
  ({ video: 'x', scenes: [{ id: 'a', page: 'console', steps: [{ click: { text: 'Go' } }] }], ...extra }) as unknown as Scenario;

describe('sandbox references and auth in hooks (hotfix v0.2.3)', () => {
  it('a scenario hook may read {{compose_env:…}} and {{accounts.<persona>.…}} and act as a persona', () => {
    const sc = scenario({
      setup: [
        {
          http: {
            method: 'POST',
            url: '{{console}}/api/sign-in?key={{compose_env:API_KEY}}',
            json: { email: '{{accounts.admin.username}}', password: '{{ accounts.admin.password }}' },
            save_as: 'admin',
          },
        },
        { http: { method: 'POST', url: '{{console}}/api/approve', auth: { persona: 'admin' } } },
      ],
      hooks: { reply: { http: { method: 'POST', url: '{{console}}/api/replies', auth: { persona: 'buyer' } } } },
    });
    expect(msgs(validateScenario(sc, { project: project() }))).toEqual([]);
  });

  it('refuses: in a scene, a malformed account reference, an unknown persona, a header beside auth', () => {
    const sc = scenario({
      scenes: [{ id: 'a', page: 'console', steps: [{ type: { into: { label: 'Key' }, text: '{{compose_env:API_KEY}}' } }] }],
      setup: [
        { http: { url: '{{console}}/x?p={{accounts.admin.token}}' } },
        { http: { url: '{{console}}/y', auth: { persona: 'seller' } } },
        { http: { url: '{{console}}/z', auth: { persona: 'buyer' }, headers: { Authorization: 'Bearer x' } } },
      ],
    });
    expect(msgs(validateScenario(sc, { project: project() }))).toEqual([
      "setup.2.http.headers.Authorization: `auth: {persona}` sets the Authorization header from the persona's session: remove one of the two",
      'setup.0.http.url: unknown template key {{accounts.admin.token}}; a sandbox account is read as {{accounts.<persona>.username}} or {{accounts.<persona>.password}}',
      "scenes.0.steps.0.type.text: {{compose_env:API_KEY}} reads a sandbox's compose env file: it is available in hooks (run on a sandbox environment) and as an account's username or password in sandbox.yaml",
      'setup.1.http.auth.persona: auth: persona "seller" is not declared for environment "staging" (personas: buyer, admin)',
    ]);
  });

  it('a seed reads its own accounts and compose env file; never auth: {persona}', () => {
    const text = `version: 1
provider: docker-compose
accounts:
  admin: {pages: [app], username: admin@example.com, password: "{{compose_env:ADMIN_PASSWORD}}", login: [{open: "app:/sign-in"}]}
services:
  app: {url: "http://localhost:4600", pages: {app: "http://localhost:4600"}}
seed:
  - http: {method: POST, url: "{{app}}/api/sign-in", json: {email: "{{accounts.admin.username}}", password: "{{accounts.admin.password}}", key: "{{compose_env:API_KEY}}"}}
  - http: {method: POST, url: "{{app}}/api/x", json: {p: "{{accounts.owner.password}}"}}
  - http: {method: POST, url: "{{app}}/api/y", auth: {persona: admin}}
`;
    expect(msgs(parseSandboxYaml(text).issues)).toEqual([
      'seed.1.http.json.p: {{accounts.owner.password}}: this sandbox has no account "owner" (accounts: admin)',
      expect.stringMatching(/^seed\.2\.http\.auth: a seed runs while the data is being built: no persona is signed in yet/),
    ]);
  });

  it('through MCP a scenario never names a sandbox secret (it acts as a persona with auth instead)', () => {
    const refused = agentTrustProblems({ dir: '/nonexistent/northfield' }, scenario({ setup: [{ http: { url: '{{console}}/x', json: { p: '{{accounts.admin.password}}', k: '{{compose_env:API_KEY}}' } } }] }));
    expect(refused).toEqual([expect.stringContaining('the scenario uses {{accounts.admin.password}}, {{compose_env:API_KEY}}: through MCP a scenario never resolves a secret')]);
    // A username is not a secret.
    expect(agentTrustProblems({ dir: '/nonexistent/northfield' }, scenario({ setup: [{ http: { url: '{{console}}/x', auth: { persona: 'admin' }, json: { e: '{{accounts.admin.username}}' } } }] }))).toEqual([]);
  });
});
