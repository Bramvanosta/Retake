/**
 * iOS environments in project.yaml: the `ios:` form (only a mapping with an `app`), pages xor ios, the settings
 * not supported yet, an app path that leaves the project, no personas; normalised and resolved; `retake env` refuses
 * one and keeps it intact; the app a run installs under the agent policy; the Retake home's iOS folders; a timeline's
 * capture device.
 */
import { chmodSync, lchmodSync, statSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EnvironmentEditError,
  PERSON_POLICY,
  TimelineSchema,
  editEnvironment,
  iosAppKind,
  iosAppTarget,
  iosDeviceLocks,
  iosDriverCache,
  parseProjectYaml,
  removeEnvironment,
  resolveEnvironment,
  workPolicyFrom,
} from '@retake/core';
import { iosDeviceLockDir, nodeFileFacts } from '@retake/core/io';
import { tempDir } from './helpers.js';

const IOS = 'environments:\n  simulator:\n    ios:\n      app: build/Buyer.app\n      device: iPhone 17 Pro\n      schemes: [northfield]\n';
const project = (envs: string, extra = '') => `version: 1\nname: Northfield\n${envs}${extra}`;
const errorsOf = (text: string) =>
  parseProjectYaml(text)
    .issues.filter((i) => i.severity === 'error')
    .map((i) => `${i.line}: ${i.path.join('.')}: ${i.message}`);

describe('the ios: form of an environment', () => {
  it('is read, normalised (no pages, its settings) and resolved', () => {
    const { config, issues } = parseProjectYaml(project(`${IOS}  staging:\n    shop: https://shop.staging.example.com\n`));
    expect(issues).toEqual([]);
    expect(config?.environments.simulator).toEqual({});
    expect(config?.environment_settings?.simulator).toEqual({ ios: { app: 'build/Buyer.app', device: 'iPhone 17 Pro', schemes: ['northfield'] } });
    const env = resolveEnvironment({ config: config! }, 'simulator');
    expect(env).toEqual({ name: 'simulator', pages: {}, ios: { app: 'build/Buyer.app', device: 'iPhone 17 Pro', schemes: ['northfield'] } });
    // The web environment beside it is unchanged.
    expect(resolveEnvironment({ config: config! }, 'staging')).toEqual({ name: 'staging', pages: { shop: 'https://shop.staging.example.com' } });
  });

  it('a page named ios stays a page; ios is the iOS form only as a mapping with an app', () => {
    const page = parseProjectYaml(project('environments:\n  staging:\n    ios: https://ios.staging.example.com\n'));
    expect(page.issues).toEqual([]);
    expect(page.config?.environments.staging).toEqual({ ios: 'https://ios.staging.example.com' });
    expect(page.config?.environment_settings).toBeUndefined();
    const display = parseProjectYaml(project('environments:\n  staging:\n    ios: {url: https://ios.staging.example.com, display: ios.example.com}\n'));
    expect(display.issues).toEqual([]);
    expect(display.config?.environments.staging).toEqual({ ios: 'https://ios.staging.example.com' });
    // A page named ios that is no URL is a page's error; an ios mapping without its app is the iOS form's.
    expect(errorsOf(project('environments:\n  staging:\n    ios: not-a-url\n'))).toEqual(['5: environments.staging.ios: expected an absolute http(s) URL, e.g. "https://app.staging.example.com"']);
    expect(errorsOf(project('environments:\n  staging:\n    ios: {device: iPhone 17 Pro}\n'))).toEqual(['5: environments.staging.ios: missing required key "app"']);
  });

  it('pages and ios in one environment are refused: one form each', () => {
    const errs = errorsOf(project('environments:\n  both:\n    pages: {shop: "https://shop.example.com"}\n    ios: {app: build/Buyer.app, device: iPhone 17 Pro}\n'));
    expect(errs.join('\n')).toContain('several environment forms in one environment (pages, ios)');
  });

  it('an iOS environment has no production, access, read_only or pages beside ios', () => {
    const errs = errorsOf(project('environments:\n  simulator:\n    ios: {app: build/Buyer.app, device: iPhone 17 Pro}\n    production: true\n'));
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('environments.simulator');
    expect(errs[0]).toContain('production');
  });

  it('app is a .app path or a bundle id; device is required; schemes are deep-link schemes', () => {
    expect(iosAppKind('build/Buyer.app')).toBe('path');
    expect(iosAppKind('/Users/x/Buyer.app/')).toBe('path');
    expect(iosAppKind('com.example.buyer')).toBe('bundle');
    expect(iosAppKind('com.example.app')).toBe('path');
    expect(iosAppKind('buyer')).toBeNull();
    expect(iosAppKind('-com.example.buyer')).toBeNull();
    expect(iosAppKind('com.-example.buyer')).toBeNull();
    expect(iosAppKind('com.example.9buyer-2')).toBe('bundle');
    const bad = errorsOf(project('environments:\n  simulator:\n    ios:\n      app: buyer\n      schemes: [https, Northfield, "x://"]\n'));
    expect(bad.join('\n')).toContain('app: expected the path of a simulator build ending in .app');
    expect(bad.join('\n')).toContain('device');
    expect(bad.join('\n')).toContain('"https" is not a deep-link scheme');
    expect(bad.join('\n')).toContain('"Northfield" is not a URL scheme');
    expect(bad.join('\n')).toContain('"x://" is not a URL scheme');
  });

  it('runtime, appearance and reset are refused: not supported yet', () => {
    const text = project('environments:\n  simulator:\n    ios:\n      app: build/Buyer.app\n      device: iPhone 17 Pro\n      runtime: iOS 26.5\n      appearance: dark\n      reset: true\n');
    expect(errorsOf(text)).toEqual([
      '8: environments.simulator.ios.runtime: `runtime` of an iOS environment is not supported yet: the newest iOS runtime the device type supports is used — remove it',
      '9: environments.simulator.ios.appearance: `appearance` of an iOS environment is not supported yet: the simulator shows its own appearance — remove it',
      '10: environments.simulator.ios.reset: `reset` of an iOS environment is not supported yet: the app is installed again for each take, its data kept — remove it',
    ]);
  });

  it('an app path that leaves the project is refused, an absolute one is the person own', () => {
    const at = (app: string) => errorsOf(project(`environments:\n  simulator:\n    ios: {app: "${app}", device: iPhone 17 Pro}\n`));
    expect(at('../builds/Buyer.app').join('\n')).toContain('leaves the project folder');
    expect(at('build/../../Buyer.app').join('\n')).toContain('leaves the project folder');
    expect(at('~/Buyer.app').join('\n')).toContain('is not expanded');
    expect(at('/opt/builds/Buyer.app')).toEqual([]);
    expect(at('build/./Buyer.app')).toEqual([]);
  });

  it('an iOS environment signs nobody in: its personas are refused', () => {
    const text = project(IOS, 'auth:\n  simulator:\n    personas:\n      buyer: {}\n');
    expect(errorsOf(text)).toEqual(['10: auth.simulator: environment simulator is an iOS environment: it signs nobody in — remove its personas (auth.simulator)']);
  });
});

describe('retake env on a project with an iOS environment', () => {
  const text = project(`${IOS}  staging:\n    shop: https://shop.staging.example.com\n`);

  it('refuses to set or remove the iOS environment', () => {
    expect(() => editEnvironment(text, 'simulator', { pages: { shop: 'https://shop.example.com' } }, 'set')).toThrow(EnvironmentEditError);
    expect(() => editEnvironment(text, 'simulator', { pages: { shop: 'https://shop.example.com' } }, 'upsert')).toThrow(/is an iOS environment/);
    expect(() => removeEnvironment(text, 'simulator')).toThrow(/is an iOS environment .*edit it in project.yaml by hand/);
  });

  it('edits another environment and keeps the iOS one intact', () => {
    const edit = editEnvironment(text, 'staging', { pages: { console: 'https://console.staging.example.com' } }, 'set');
    expect(edit.text).toContain('    ios:\n      app: build/Buyer.app\n      device: iPhone 17 Pro\n      schemes: [northfield]\n');
    const { config, issues } = parseProjectYaml(edit.text);
    expect(issues).toEqual([]);
    expect(config?.environment_settings?.simulator?.ios).toEqual({ app: 'build/Buyer.app', device: 'iPhone 17 Pro', schemes: ['northfield'] });
    expect(removeEnvironment(text, 'staging').text).toContain('    ios:\n      app: build/Buyer.app\n');
  });
});

describe('the app a run installs (iosAppTarget)', () => {
  it('a bundle id as is; a path made real; a path leaving the project (.., a link) refused for every run', async () => {
    const { dir, cleanup } = await tempDir('retake-ios-app-');
    try {
      const ws = join(dir, 'ws');
      const proj = join(ws, 'projects', 'p');
      await mkdir(join(proj, 'build', 'Buyer.app'), { recursive: true });
      await mkdir(join(dir, 'outside', 'Other.app'), { recursive: true });
      await symlink(join(dir, 'outside'), join(proj, 'linked'));
      const o = { projectDir: proj, policy: PERSON_POLICY, files: nodeFileFacts };
      expect(iosAppTarget('com.example.buyer', o)).toEqual({ target: { kind: 'bundle', bundleId: 'com.example.buyer' }, problem: null });
      const made = iosAppTarget('build/Buyer.app', o);
      expect(made.problem).toBeNull();
      expect(made.target).toEqual({ kind: 'path', path: nodeFileFacts.nativeRealpath(join(proj, 'build', 'Buyer.app')) });
      expect(iosAppTarget('../Buyer.app', o).problem).toContain('leaves the project folder: write its path');
      expect(iosAppTarget('linked/Other.app', o).problem).toContain('leaves the project folder through a link');
      expect(iosAppTarget(join(dir, 'outside', 'Other.app'), o).problem).toBeNull();
      expect(iosAppTarget('buyer', o).problem).toContain('expected the path of a simulator build');
    } finally {
      await cleanup();
    }
  });

  it('under the agent policy, a build inside the workspace is refused; a bundle id or a build outside may', async () => {
    const { dir, cleanup } = await tempDir('retake-ios-app-');
    try {
      const ws = join(dir, 'ws');
      const proj = join(ws, 'projects', 'p');
      await mkdir(join(proj, 'build', 'Buyer.app'), { recursive: true });
      await mkdir(join(dir, 'outside', 'Other.app'), { recursive: true });
      await writeFile(join(proj, 'project.yaml'), '');
      const o = { projectDir: proj, policy: workPolicyFrom([ws]), files: nodeFileFacts };
      expect(iosAppTarget('build/Buyer.app', o).problem).toContain('lies inside the workspace');
      expect(iosAppTarget(join(proj, 'build', 'Buyer.app'), o).problem).toContain('lies inside the workspace');
      expect(iosAppTarget(join(dir, 'outside', 'Other.app'), o).problem).toBeNull();
      expect(iosAppTarget('com.example.buyer', o).problem).toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('the iOS folders of the Retake home and a capture device', () => {
  it('ios-driver/<key> in the home; the simulator locks machine-wide per user', () => {
    expect(iosDriverCache('/h', '17F113-abc')).toBe(join('/h', 'ios-driver', '17F113-abc'));
    expect(iosDeviceLocks(501)).toBe(join('/tmp', 'retake-ios-501'));
  });

  it("the locks' folder is made private, and refused when it is a link or open to others", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const uid = process.getuid?.() ?? 0;
      const made = iosDeviceLockDir(dir, uid);
      expect(made).toBe(join(dir, `retake-ios-${uid}`));
      expect(statSync(made).mode & 0o777).toBe(0o700);
      chmodSync(made, 0o755);
      expect(() => iosDeviceLockDir(dir, uid)).toThrow(/not this user's private folder/);
      await mkdir(join(dir, 'elsewhere'), { mode: 0o700 });
      await symlink(join(dir, 'elsewhere'), join(dir, 'retake-ios-424242'));
      expect(() => iosDeviceLockDir(dir, 424242)).toThrow(/not this user's private folder/);
      // A link of this user's, closed to others, to a private folder of this user's: still refused (a link).
      await mkdir(join(dir, 'linked'));
      await symlink(join(dir, 'elsewhere'), join(dir, 'linked', `retake-ios-${uid}`));
      lchmodSync(join(dir, 'linked', `retake-ios-${uid}`), 0o700);
      expect(() => iosDeviceLockDir(join(dir, 'linked'), uid)).toThrow(/not this user's private folder/);
    } finally {
      await cleanup();
    }
  });

  it('a timeline records the device it was filmed on (strict)', () => {
    const base = {
      version: 1,
      run_id: 'r',
      project: 'p',
      scenario: 's',
      created_at: '2026-11-17T10:00:00Z',
      mode: 'capture',
      capture: { file: 'capture.mp4', width: 402, height: 874, scale: 3, fps: 30, duration: 1, t0_wall: 1, frames: 30 },
      scenes: [],
      events: [],
      markers: [],
      pages: [],
      cursor: [],
      idle: [],
      warnings: [],
    };
    const device = { kind: 'ios', name: 'iPhone 17 Pro', runtime: 'iOS 26.5', xcode: '26.6 (17F113)' };
    expect(TimelineSchema.safeParse({ ...base, capture: { ...base.capture, device } }).success).toBe(true);
    expect(TimelineSchema.safeParse(base).success).toBe(true);
    expect(TimelineSchema.safeParse({ ...base, capture: { ...base.capture, device: { ...device, kind: 'android' } } }).success).toBe(false);
    expect(TimelineSchema.safeParse({ ...base, capture: { ...base.capture, device: { ...device, udid: 'x' } } }).success).toBe(false);
  });
});
