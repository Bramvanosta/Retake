/**
 * L5.16c (critique M6) — a signed-in profile is never opened by an older Chromium than the one that opened it last (the
 * installed app and a repository checkout share the Retake home): the major a launch would run (a macOS app's
 * Info.plist, the version playwright-core pins), the one a profile records (ours, and Chromium's own `Last Version`),
 * the refusal before any browser starts, and the record a launch leaves. No browser is started here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PROFILE_BROWSER_FILE, checkProfileBrowser, launchMajor, profileMajor, recordProfileBrowser } from '../src/index.js';
import { BrowserSession } from '../src/session.js';
import { PERSON_POLICY } from '@retake/core';

const base = mkdtempSync(join(tmpdir(), 'profile-browser-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const profile = () => {
  const d = join(base, `p${++n}`);
  mkdirSync(d);
  return d;
};

describe('the Chromium major of a launch', () => {
  it("Playwright's own builds by the pinned versions (the headless shell without a channel); an app by its Info.plist; else unknown", () => {
    const pins = () => ({ chromium: '141.0.7390.37', 'chromium-headless-shell': '140.0.7339.16' });
    expect(launchMajor({ channel: 'chromium' }, pins)).toBe(141);
    expect(launchMajor({}, pins)).toBe(140);
    expect(launchMajor({ channel: 'chrome' }, pins)).toBeNull();
    // The real pins of this checkout's playwright-core.
    expect(launchMajor({ channel: 'chromium' })).toBeGreaterThanOrEqual(100);
    const app = join(base, 'Chromium.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<plist><dict><key>CFBundleName</key><string>Chromium</string><key>CFBundleShortVersionString</key>\n\t<string>142.0.7444.0</string></dict></plist>',
    );
    expect(launchMajor({ executablePath: join(app, 'Contents', 'MacOS', 'Chromium') })).toBe(142);
    expect(launchMajor({ executablePath: '/opt/chromium/chrome' })).toBeNull();
    expect(launchMajor({ executablePath: join(base, 'Missing.app', 'Contents', 'MacOS', 'X') })).toBeNull();
  });
});

describe('what a profile records', () => {
  it("ours and Chromium's own Last Version: the newest counts; garbage is nothing", () => {
    const p = profile();
    expect(profileMajor(p)).toBeNull();
    writeFileSync(join(p, 'Last Version'), '141.0.7390.37');
    expect(profileMajor(p)).toBe(141);
    writeFileSync(join(p, PROFILE_BROWSER_FILE), JSON.stringify({ chromium_major: 143 }));
    expect(profileMajor(p)).toBe(143);
    writeFileSync(join(p, PROFILE_BROWSER_FILE), JSON.stringify({ chromium_major: 'lots' }));
    expect(profileMajor(p)).toBe(141);
    writeFileSync(join(p, 'Last Version'), 'not a version');
    expect(profileMajor(p)).toBeNull();
  });

  it('refuses an older Chromium before it starts, with what to do; the same or newer opens it and records itself', () => {
    const p = profile();
    writeFileSync(join(p, 'Last Version'), '142.0.7444.0');
    expect(() => checkProfileBrowser(p, 141, 'buyer')).toThrow(/last opened by Chromium 142, and this copy of Retake runs Chromium 141: an older Chromium would downgrade the profile/);
    expect(() => checkProfileBrowser(p, 141)).toThrow(/the signed-in profile \(/);
    expect(() => checkProfileBrowser(p, 142)).not.toThrow();
    expect(() => checkProfileBrowser(p, 150)).not.toThrow();
    // An unknown major (an executable outside an app): nothing checked.
    expect(() => checkProfileBrowser(p, null)).not.toThrow();
    // A profile not created yet: nothing to protect.
    expect(() => checkProfileBrowser(join(base, 'none'), 1)).not.toThrow();
    recordProfileBrowser(p, 150);
    expect(JSON.parse(readFileSync(join(p, PROFILE_BROWSER_FILE), 'utf8'))).toMatchObject({ chromium_major: 150 });
    expect(() => checkProfileBrowser(p, 142)).toThrow(/Chromium 150/);
    recordProfileBrowser(join(base, 'gone', 'x'), 150);
    recordProfileBrowser(p, null);
    expect(profileMajor(p)).toBe(150);
  });
});

describe("the launch of a persona's profile", () => {
  it('BrowserSession.open refuses a profile a newer Chromium opened, before any browser starts', async () => {
    // A fake Chromium app (version 141) that does not run: were the check missing, the launch would fail on it, never
    // start a real browser.
    const app = join(base, 'Old Chromium.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<key>CFBundleShortVersionString</key><string>141.0.1.0</string>');
    const p = profile();
    writeFileSync(join(p, 'Last Version'), '999.0.0.0');
    const opts = { policy: PERSON_POLICY, profileDir: p, width: 640, height: 360, scale: 1, browser: { executable: join(app, 'Contents', 'MacOS', 'Chromium') } };
    await expect(BrowserSession.open(opts as never)).rejects.toThrow(/last opened by Chromium 999, and this copy of Retake runs Chromium 141/);
  });

  it('the sign-in window and the recording window check the profile before their launch (static)', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');
    const login = src('login.ts');
    // L7.34 (finding C4): kept as an order check of the two headed launches (a behaviour test would sign a persona in
    // through a visible window), loosened to the calls' names and the profile they are handed — not their statements.
    // The headless launch's refusal is the behaviour case above.
    const headed = login.slice(login.indexOf('async function headedSession'));
    const launch = headed.indexOf('chromium.launchPersistentContext(userDataDir');
    // The version argument is pinned (review fix): the major the launch will run, checked and then recorded.
    const major = headed.search(/\bconst major = launchMajor\(\{ executablePath, channel \}\)/);
    expect(major).toBeGreaterThan(0);
    expect(headed.search(/\bcheckProfileBrowser\(userDataDir, major\)/)).toBeGreaterThan(major);
    expect(headed.search(/\bcheckProfileBrowser\(userDataDir, major\)/)).toBeLessThan(launch);
    expect(headed.search(/\brecordProfileBrowser\(userDataDir, major\)/)).toBeGreaterThan(launch);
    const rec = src('record-session.ts');
    expect(rec).toMatch(/\bif \(persona\) checkProfileBrowser\(userDataDir, launchMajor\(\{ executablePath, channel \}\), persona\.name\)/);
    expect(rec.indexOf('checkProfileBrowser(')).toBeLessThan(rec.indexOf('chromium.launchPersistentContext('));
  });
});
