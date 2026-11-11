/**
 * Hotfix v0.2.3 — the validation of what a hook reads from its sandbox: `{{compose_env:NAME}}` and
 * `{{accounts.<persona>.username|password}}` are accepted in hooks (a scenario's, project.yaml's, a sandbox seed's —
 * there checked against its own accounts) and refused in what a scene does or shows; `auth: {persona}` on an http hook
 * names a persona of the scenario's environment, is not in a seed, and never beside an Authorization / Cookie header.
 * Through MCP a scenario names none of them (agent trust).
 */
import { describe, expect, it } from 'vitest';
import { agentTrustProblems, agentTrustProblemsAt, parseSandboxYaml, personaAuthOriginProblem, validateScenario } from '@retake/core';
import type { Scenario, ValidationIssue } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';
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
    const refused = agentTrustProblems({ dir: '/nonexistent/northfield' }, scenario({ setup: [{ http: { url: '{{console}}/x', json: { p: '{{accounts.admin.password}}', k: '{{compose_env:API_KEY}}' } } }] }), { files: nodeFileFacts });
    expect(refused).toEqual([expect.stringContaining('the scenario uses {{accounts.admin.password}}, {{compose_env:API_KEY}}: through MCP a scenario never resolves a secret')]);
    // A username is not a secret.
    expect(agentTrustProblems({ dir: '/nonexistent/northfield' }, scenario({ setup: [{ http: { url: '{{console}}/x', auth: { persona: 'admin' }, json: { e: '{{accounts.admin.username}}' } } }] }), { files: nodeFileFacts })).toEqual([]);
  });

  it("through MCP an http hook acting as a persona targets that persona's own pages only (its URL's origin is one of theirs)", () => {
    const p = project();
    const files = { files: nodeFileFacts };
    const hook = (url: string, extra: Record<string, unknown> = {}) => scenario({ setup: [{ http: { method: 'POST', url, auth: { persona: 'buyer' }, ...extra } }] });
    // Same origin as a page the persona signs in to: allowed.
    expect(agentTrustProblems(p, hook('{{console}}/api/replies'), files)).toEqual([]);
    expect(agentTrustProblems(p, hook('https://console.staging.example.com/api/x'), files)).toEqual([]);
    // Another page of the environment, another site, a host the agent's vars choose, a rollback elsewhere: refused.
    const rule = /^setup\[0\]\.http(\.rollback)?\.url: through MCP an http hook acting as persona buyer \(`auth: \{persona\}`\) sends its session only to that persona's own pages \(https:\/\/console\.staging\.example\.com\)/;
    for (const url of ['{{shop}}/api/x', 'https://elsewhere.example/collect', '{{vars.host}}/x', 'https://{{vars.sub}}.example.com/x', '{{console}}@elsewhere.example/x']) {
      const got = agentTrustProblems(p, hook(url), files);
      expect(got, url).toEqual([expect.stringMatching(rule)]);
    }
    expect(agentTrustProblems(p, hook('{{console}}/a', { rollback: { method: 'DELETE', url: '{{shop}}/a', auth: { persona: 'buyer' } } }), files)).toEqual([expect.stringMatching(rule)]);
    // Positioned at the hook's url; the environment of a submit narrows the check to its pages.
    const at = agentTrustProblemsAt(p, hook('{{shop}}/x'), 'video: x\nsetup:\n  - http: {method: POST, url: "{{shop}}/x", auth: {persona: buyer}}\nscenes: []\n', files);
    expect(at).toEqual([expect.objectContaining({ path: ['setup', 0, 'http', 'url'], line: 3 })]);
    expect(agentTrustProblems(p, hook('https://shop.staging.example.com/x'), { ...files, env: { name: 'staging', pages: { console: 'https://shop.staging.example.com' } } })).toEqual([]);
    // The rule itself, on a rendered URL.
    expect(personaAuthOriginProblem('buyer', 'https://console.staging.example.com/x?y', ['https://console.staging.example.com'])).toBeNull();
    expect(personaAuthOriginProblem('buyer', 'http://console.staging.example.com/x', ['https://console.staging.example.com'])).toContain('http://console.staging.example.com is not one of them');
  });
});
