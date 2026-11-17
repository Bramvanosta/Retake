/**
 * A scenario on an iOS environment: the steps, targets, keys and scene keys the iOS driver plays, every other
 * one refused at its line; deep links with the environment's schemes only (a person's and an agent's work alike); no
 * secret typed; no js hook.
 */
import { describe, expect, it } from 'vitest';
import { IOS_STEP_ACTIONS, agentTrustProblems, iosNavigationProblem, parseProjectYaml, parseScenario, resolveEnvironment, scenarioNavigationProblems } from '@retake/core';
import type { LoadedProject, Scenario, ValidationIssue } from '@retake/core';
import { nodeFileFacts } from '@retake/core/io';

const PROJECT = [
  'version: 1',
  'name: Northfield',
  'environments:',
  '  simulator:',
  '    ios: {app: build/Buyer.app, device: iPhone 17 Pro, schemes: [northfield]}',
  '  staging:',
  '    shop: https://shop.staging.example.com',
  'hooks:',
  '  page-reset:',
  '    js: "window.x = 1"',
  '  api-reset:',
  '    http: {method: POST, url: "http://localhost:4401/api/reset"}',
  '',
].join('\n');

function project(): LoadedProject {
  const { config, issues } = parseProjectYaml(PROJECT);
  if (!config) throw new Error(JSON.stringify(issues));
  return { slug: 'northfield', dir: '/nonexistent/projects/northfield', root: '/nonexistent', file: '/nonexistent/projects/northfield/project.yaml', readme: null, scenarios: [], config };
}

const scenario = (steps: string, extra = '', scene = '') => `video: demo\nenv: simulator\n${extra}scenes:\n  - id: main\n${scene}    steps:\n${steps}`;
const check = (text: string, env?: string) => parseScenario(text, { project: project(), files: nodeFileFacts, ...(env ? { env } : {}) });
const errs = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === 'error').map((i) => `${i.line}: ${i.path.join('.')}: ${i.message}`);

describe('the steps of an iOS environment', () => {
  it('plays tap, type, the keys, swipes, deep links, waits, checks, screenshots, hooks and emits', () => {
    const text = scenario(
      [
        '      - open: northfield://product/NF-1042',
        '      - click: Add to quote',
        '      - click: {role: button, name: Send request}',
        '      - type: {into: {placeholder: Search}, text: anchor bolts, cps: 12, clear: true, enter: true}',
        '      - press: Return',
        '      - press: {key: backspace, times: 3}',
        '      - scroll: 300',
        '      - scroll: {by: -200, duration: 0.6}',
        '      - scroll: {to: {testid: quote-total}}',
        '      - wait: 1',
        '      - wait_for: {target: {label: Quote}, timeout: 5}',
        '      - wait_for: {gone: {text: Loading, exact: true}}',
        '      - assert: {count: {target: {role: cell}, equals: 3}}',
        '      - assert: {not_text: Error}',
        '      - hold: 1',
        '      - screenshot: quote',
        '      - hook: api-reset',
        '      - emit: done',
        '',
      ].join('\n'),
    );
    const r = check(text);
    expect(errs(r.issues)).toEqual([]);
    // The first scene without `open` launches the app: no "starts on whatever is loaded" warning.
    expect(check(scenario('      - wait: 1\n')).issues).toEqual([]);
  });

  it('refuses every other action on its action key, naming the iOS steps', () => {
    const refused = [
      'double_click: Save',
      'hover: Save',
      'select: {option: A}',
      'drag: {from: a, to: b}',
      'new_tab: /x',
      'switch_page: main',
      'eval: "1"',
      'notify: hi',
      'cursor: hide',
      'download: {click: a, as: f}',
    ];
    const text = scenario(refused.map((s) => `      - ${s}\n`).join(''));
    const got = errs(check(text).issues).filter((m) => m.includes('is not available on iOS environment simulator (iOS steps:'));
    expect(got.map((m) => m.split(': ')[1])).toEqual([
      'scenes.0.steps.0.double_click',
      'scenes.0.steps.1.hover',
      'scenes.0.steps.2.select',
      'scenes.0.steps.3.drag',
      'scenes.0.steps.4.new_tab',
      'scenes.0.steps.5.switch_page',
      'scenes.0.steps.6.eval',
      'scenes.0.steps.7.notify',
      'scenes.0.steps.8.cursor',
      'scenes.0.steps.9.download',
    ]);
    expect(got[0]).toBe(`6: scenes.0.steps.0.double_click: double_click is not available on iOS environment simulator (iOS steps: ${IOS_STEP_ACTIONS.join(', ')})`);
  });

  it('refuses the arguments and modifiers a browser needs', () => {
    const text = scenario(
      [
        '      - open: {url: "northfield://home", wait_until: load}',
        '      - scroll: {to: top}',
        '      - scroll: {to: bottom}',
        '      - scroll: {by: 100, in: {testid: list}}',
        '      - wait_for: {url: /quotes}',
        '      - wait_for: {network_idle: true}',
        '      - assert: {title: Quotes}',
        '      - screenshot: {name: s, full_page: true}',
        '      - press: Escape',
        '      - press: Meta+A',
        '      - click: Save',
        '        park: true',
        '',
      ].join('\n'),
    );
    const got = errs(check(text).issues);
    expect(got).toEqual([
      '6: scenes.0.steps.0.open.wait_until: `open.wait_until` is not available on iOS environment simulator: a deep link has no page load to wait for',
      '7: scenes.0.steps.1.scroll.to: `scroll: top` is not available on iOS environment simulator yet: swipe by a distance (`by:`) or to an element (`to: <target>`)',
      '8: scenes.0.steps.2.scroll.to: `scroll: bottom` is not available on iOS environment simulator yet: swipe by a distance (`by:`) or to an element (`to: <target>`)',
      '9: scenes.0.steps.3.scroll.in: `scroll.in` is not available on iOS environment simulator: a swipe scrolls what is under it',
      '10: scenes.0.steps.4.wait_for.url: `wait_for.url` is not available on iOS environment simulator: the app has no address',
      "11: scenes.0.steps.5.wait_for.network_idle: `wait_for.network_idle` is not available on iOS environment simulator: the app's requests are not watched",
      '12: scenes.0.steps.6.assert.title: `assert.title` is not available on iOS environment simulator: the app has no page title',
      '13: scenes.0.steps.7.screenshot.full_page: `screenshot.full_page` is not available on iOS environment simulator: the screenshot is the screen',
      '14: scenes.0.steps.8.press: key "Escape" is not available on iOS environment simulator: the on-screen keyboard sends Enter, Return, Backspace, Delete (no shortcut, no Escape, no Tab)',
      '15: scenes.0.steps.9.press: key "Meta+A" is not available on iOS environment simulator: the on-screen keyboard sends Enter, Return, Backspace, Delete (no shortcut, no Escape, no Tab)',
      '17: scenes.0.steps.10.park: `park` is not available on iOS environment simulator: a touch leaves no cursor to park',
    ]);
  });

  it('refuses page, pages and persona on a scene', () => {
    const got = errs(check(scenario('      - wait: 1\n', '', '    page: shop\n    persona: buyer\n')).issues);
    expect(got.filter((m) => m.includes('on iOS environment'))).toEqual([
      '5: scenes.0.page: `page` is not available on iOS environment simulator: an iOS environment has no pages',
      '6: scenes.0.persona: `persona` is not available on iOS environment simulator: an iOS environment signs nobody in',
    ]);
    const multi = errs(check('video: demo\nenv: simulator\nscenes:\n  - id: main\n    pages: [a, b]\n    steps: [{wait: 1}]\n').issues);
    expect(multi.join('\n')).toContain('scenes.0.pages: `pages` is not available on iOS environment simulator');
  });

  it('a target names the app accessibility: css, CSS-looking text, in, last_visible, contains and other roles refused', () => {
    const text = scenario(
      [
        '      - click: "#save"',
        '      - click: {css: .save}',
        '      - click: {text: Save, in: dialog}',
        '      - click: {text: Save, last_visible: true}',
        '      - click: {contains: [A, B]}',
        '      - click: {role: link, name: Docs}',
        '      - type: {into: ".field > input", text: x}',
        '      - wait_for: {target: {role: dialog}}',
        '',
      ].join('\n'),
    );
    const got = errs(check(text).issues);
    expect(got).toEqual([
      '6: scenes.0.steps.0.click: "#save" reads as a CSS selector, and an iOS app has none on iOS environment simulator: name the element by its text, or {text, label, aria, testid, role, name, placeholder, nth, exact}',
      '7: scenes.0.steps.1.click.css: `css` is not available in a target on iOS environment simulator (target keys: text, label, aria, testid, role, name, placeholder, nth, exact)',
      '8: scenes.0.steps.2.click.in: `in` is not available in a target on iOS environment simulator (target keys: text, label, aria, testid, role, name, placeholder, nth, exact)',
      '9: scenes.0.steps.3.click.last_visible: `last_visible` is not available in a target on iOS environment simulator (target keys: text, label, aria, testid, role, name, placeholder, nth, exact)',
      '10: scenes.0.steps.4.click.contains: `contains` is not available in a target on iOS environment simulator (target keys: text, label, aria, testid, role, name, placeholder, nth, exact)',
      '11: scenes.0.steps.5.click.role: role "link" is not available on iOS environment simulator (roles: button, textbox, checkbox, switch, heading, text, cell, row)',
      '12: scenes.0.steps.6.type.into: ".field > input" reads as a CSS selector, and an iOS app has none on iOS environment simulator: name the element by its text, or {text, label, aria, testid, role, name, placeholder, nth, exact}',
      '13: scenes.0.steps.7.wait_for.target.role: role "dialog" is not available on iOS environment simulator (roles: button, textbox, checkbox, switch, heading, text, cell, row)',
    ]);
  });

  it('never types a secret: env, keychain, secret and account passwords refused', () => {
    const text = scenario(
      [
        '      - type: {text: "{{env:BUYER_PASSWORD}}"}',
        '      - type: {into: Password, text: "pw {{keychain:shop/buyer}}"}',
        '      - type: {text: "{{secret:env:X}}"}',
        '      - type: {text: "{{ accounts.buyer.password }}"}',
        '      - type: {text: "{{vars.name}}"}',
        '',
      ].join('\n'),
      'vars:\n  name: Ada\n',
    );
    const got = errs(check(text).issues).filter((m) => m.includes('a secret is not typed'));
    expect(got.map((m) => m.split(': ').slice(0, 2).join(': '))).toEqual([
      '8: scenes.0.steps.0.type.text',
      '9: scenes.0.steps.1.type.text',
      '10: scenes.0.steps.2.type.text',
      '11: scenes.0.steps.3.type.text',
    ]);
  });

  it('refuses js hooks: setup, the scenario own named hooks, and a project hook a step runs', () => {
    const text = scenario('      - hook: page-reset\n      - hook: own\n', 'setup:\n  - js: "1"\nhooks:\n  own:\n    js: "2"\n');
    const got = errs(check(text).issues).filter((m) => m.includes('js hook'));
    expect(got).toEqual([
      '4: setup.0.js: a js hook is not available on iOS environment simulator: it runs in a browser page (use shell, http or sql)',
      '7: hooks.own.js: a js hook is not available on iOS environment simulator: it runs in a browser page (use shell, http or sql)',
      '11: scenes.0.steps.0.hook: hook "page-reset" of project.yaml is a js hook, which is not available on iOS environment simulator: a js hook runs in a browser page (use shell, http or sql)',
    ]);
  });

  it('the same scenario on the web environment keeps the web rules (no iOS check)', () => {
    const text = 'video: demo\nenv: staging\nscenes:\n  - id: main\n    page: shop\n    open: /\n    steps:\n      - hover: Save\n      - click: "#save"\n';
    expect(errs(check(text).issues)).toEqual([]);
  });
});

describe('deep links on an iOS environment', () => {
  const opens = (url: string) => scenario(`      - open: "${url}"\n`);

  it('a deep link with a listed scheme is accepted, in any case', () => {
    expect(errs(check(opens('northfield://product/NF-1042')).issues)).toEqual([]);
    expect(errs(check(opens('NorthField://home')).issues)).toEqual([]);
    expect(errs(check(opens('{{vars.link}}')).issues).filter((m) => m.includes('deep link'))).toEqual([]);
  });

  it('a web page, a path and another scheme are refused (a person and an agent alike)', () => {
    expect(errs(check(opens('https://shop.staging.example.com/')).issues)).toEqual([
      '6: scenes.0.steps.0.open: https://shop.staging.example.com/ opens a web page: iOS environment simulator films its app only — `open` names a deep link `<scheme>://…` (its schemes: northfield)',
    ]);
    expect(errs(check(opens('/products')).issues)).toEqual([
      '6: scenes.0.steps.0.open: /products is not a deep link: iOS environment simulator has no pages — `open` names a link into the app, `<scheme>://…` (its schemes: northfield)',
    ]);
    expect(errs(check(opens('other://x')).issues)).toEqual(['6: scenes.0.steps.0.open: other://x opens a other: link, not one of the schemes of iOS environment simulator (its schemes: northfield)']);
  });

  it('no schemes listed: every open is refused', () => {
    expect(iosNavigationProblem('northfield://x', { ios: {}, envName: 'sim' })).toBe(
      'northfield://x opens a northfield: link, not one of the schemes of iOS environment sim (it lists no `ios.schemes` in project.yaml (a person adds them))',
    );
    expect(iosNavigationProblem('northfield://x', { ios: { schemes: ['northfield'] } })).toBeNull();
  });

  it('scenarioNavigationProblems: the iOS context replaces the page rules', () => {
    const sc = { scenes: [{ id: 'a', open: 'northfield://home', steps: [{ open: 'https://x.example.com/' }] }] };
    expect(scenarioNavigationProblems(sc, { ios: { schemes: ['northfield'] }, envName: 'sim' }).map((p) => p.path.join('.'))).toEqual(['scenes.0.steps.0.open']);
    // Without it, the deep link is a scheme no browser page opens.
    expect(scenarioNavigationProblems(sc).map((p) => p.path.join('.'))).toEqual(['scenes.0.open']);
  });

  it('agent trust on the iOS environment uses its schemes, not the page origins', () => {
    const p = project();
    const sc = check(opens('northfield://product/NF-1042')).scenario as Scenario;
    const env = resolveEnvironment(p, 'simulator');
    expect(agentTrustProblems(p, sc, { env, files: nodeFileFacts })).toEqual([]);
    const other = { ...sc, scenes: [{ id: 'main', steps: [{ open: 'other://x' }] }] } as Scenario;
    expect(agentTrustProblems(p, other, { env, files: nodeFileFacts }).join('\n')).toContain('opens a other: link, not one of the schemes of iOS environment simulator');
  });
});
