/**
 * A plan's asset URLs (core plan-asset-url.ts): written `retake-asset:<name>`, read in that spelling and in the earlier
 * one a render record's plan may hold — named, recognised as a URL, signed alike — and the scenario check takes a slot
 * that already holds either for a URL, not a project file.
 */
import { describe, expect, it } from 'vitest';
import { EARLIER_PLAN_ASSET_SCHEME, PERSON_POLICY, PLAN_ASSET_SCHEME, PLAN_ASSET_SCHEMES, isLoadedUrl, isPlanAssetUrl, parseScenario, planAssetName, planTextInPresentSpelling } from '@retake/core';
import { fileFacts } from '@retake/core/io';
import { fakeProject } from './helpers.js';

const EARLIER_FONT = (theme: string, role: string) => `${EARLIER_PLAN_ASSET_SCHEME.replace(/asset:$/, '')}${theme}-${role}`;

describe('plan asset URLs, in both spellings', () => {
  it('the present spelling is written; both are read and named', () => {
    expect(PLAN_ASSET_SCHEME).toBe('retake-asset:');
    expect(PLAN_ASSET_SCHEMES).toEqual([PLAN_ASSET_SCHEME, EARLIER_PLAN_ASSET_SCHEME]);
    for (const s of [PLAN_ASSET_SCHEME, EARLIER_PLAN_ASSET_SCHEME]) {
      expect(isPlanAssetUrl(`${s}logo.svg`), s).toBe(true);
      expect(isLoadedUrl(`${s}logo.svg`), s).toBe(true);
      expect(planAssetName(`${s}logo.svg`), s).toBe('logo.svg');
    }
    expect(isPlanAssetUrl('assets/logo.svg')).toBe(false);
    expect(isPlanAssetUrl('https://x.test/logo.svg')).toBe(false);
    expect(isLoadedUrl('https://x.test/logo.svg')).toBe(true);
    expect(isLoadedUrl('data:image/png;base64,AA')).toBe(true);
    expect(isLoadedUrl('assets/logo.svg')).toBe(false);
    expect(planAssetName('assets/logo.svg')).toBe('assets/logo.svg');
  });

  it("a plan's text in the present spelling: earlier asset URLs and font family names rewritten, nothing else", () => {
    const earlier = JSON.stringify({
      assets: { [`${EARLIER_PLAN_ASSET_SCHEME}logo.svg`]: '/t/logo.svg' },
      brand: { fonts: { display: { family: EARLIER_FONT('my-theme', 'display'), url: `${EARLIER_PLAN_ASSET_SCHEME}font-display.ttf` } } },
      kicker: { font: EARLIER_FONT('editorial', 'body') },
      caption: `the text ${EARLIER_PLAN_ASSET_SCHEME}x stays`,
    });
    const present = JSON.stringify({
      assets: { 'retake-asset:logo.svg': '/t/logo.svg' },
      brand: { fonts: { display: { family: 'retake-my-theme-display', url: 'retake-asset:font-display.ttf' } } },
      kicker: { font: 'retake-editorial-body' },
      caption: `the text ${EARLIER_PLAN_ASSET_SCHEME}x stays`,
    });
    expect(planTextInPresentSpelling(earlier)).toBe(present);
    expect(planTextInPresentSpelling(present)).toBe(present);
  });

  it('the scenario check takes a slot holding a plan asset URL, in either spelling, for a URL (not a project file)', () => {
    const check = (logo: string) =>
      parseScenario(['scenes:', '  - card: {slots: {title: T, logo: ' + JSON.stringify(logo) + '}}', ''].join('\n'), { files: fileFacts(PERSON_POLICY), project: fakeProject() })
        .issues.filter((i) => i.path.includes('logo'))
        .map((i) => i.message);
    for (const s of [PLAN_ASSET_SCHEME, EARLIER_PLAN_ASSET_SCHEME]) expect(check(`${s}logo`), s).toEqual([]);
    expect(check('assets/logo.mp4').join('\n')).toMatch(/an image must be a .* file of the project or an http\(s\) URL/);
  });
});
