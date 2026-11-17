/**
 * The app a run films (src/app.ts appInfoProblem): a build must be made for the simulator, and its Info.plist's
 * CFBundleIdentifier must be a bundle id (it reaches simctl's and the driver's arguments: never one starting with "-").
 */
import { describe, expect, it } from 'vitest';
import { appInfoProblem } from '../src/app.js';

describe("a build's Info.plist", () => {
  it('a simulator build with a bundle id passes; another platform, no id, or an id that is none is refused', () => {
    expect(appInfoProblem({ platform: 'iphonesimulator', bundleId: 'com.example.buyer' }, '/b/Buyer.app')).toBeNull();
    expect(appInfoProblem({ platform: 'iphoneos', bundleId: 'com.example.buyer' }, '/b/Buyer.app')).toMatch(/built for iphoneos, not for the iOS Simulator/);
    expect(appInfoProblem({ platform: 'iphonesimulator', bundleId: '' }, '/b/Buyer.app')).toMatch(/no Info.plist with a CFBundleIdentifier/);
    for (const id of ['-com.example.buyer', 'com..buyer', 'buyer', 'com.example.buyer; rm', '--set=x.y']) {
      expect(appInfoProblem({ platform: 'iphonesimulator', bundleId: id }, '/b/Buyer.app'), id).toMatch(/is no bundle id/);
    }
  });
});
