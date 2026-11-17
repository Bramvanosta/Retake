/**
 * The readers of `xcrun simctl list … -j` (devices, device types, runtimes): which runtime runs a device type, the
 * name of Retake's own device, a profile.plist's screen — pure, on recorded shapes of Xcode 26's output.
 */
import { describe, expect, it } from 'vitest';
import { screenOfProfile } from '../src/device.js';
import { deviceTypeNamed, newestRuntimeFor, parseDevices, parseDeviceTypes, parseRuntimes, retakeDeviceName, versionLess } from '../src/simctl.js';

const DEVICES = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: '41AF386A-4285-4D75-BA81-036AAB8F7CD7', name: 'iPhone 17 Pro', state: 'Shutdown', isAvailable: true, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' },
      { udid: '0E0E0E0E-0000-4000-8000-000000000001', name: 'Retake - iPhone 17 Pro - iOS 26.5', state: 'Booted', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [{ udid: '0E0E0E0E-0000-4000-8000-000000000002', name: 'iPhone 16', state: 'Shutdown', isAvailable: false }],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-2': 'not a list',
  },
});

const TYPES = JSON.stringify({
  devicetypes: [
    {
      name: 'iPhone 16',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 16.simdevicetype',
      productFamily: 'iPhone',
    },
    {
      name: 'iPhone 17 Pro',
      identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
      bundlePath: '/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype',
      productFamily: 'iPhone',
    },
    { identifier: 'no.name' },
  ],
});

const RUNTIMES = JSON.stringify({
  runtimes: [
    {
      name: 'iOS 18.2',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-2',
      version: '18.2',
      platform: 'iOS',
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' }],
    },
    {
      name: 'iOS 26.5',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
      version: '26.5',
      platform: 'iOS',
      isAvailable: true,
      supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16' }, { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }],
    },
    {
      name: 'iOS 27.0',
      identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0',
      version: '27.0',
      platform: 'iOS',
      isAvailable: false,
      supportedDeviceTypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro' }],
    },
    { name: 'watchOS 11.2', identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-2', version: '11.2', platform: 'watchOS', isAvailable: true, supportedDeviceTypes: [] },
  ],
});

describe('simctl list -j', () => {
  it('devices: each with its runtime and state; a list that is no list is skipped', () => {
    const d = parseDevices(DEVICES);
    expect(d).toHaveLength(3);
    expect(d[1]).toEqual({
      udid: '0E0E0E0E-0000-4000-8000-000000000001',
      name: 'Retake - iPhone 17 Pro - iOS 26.5',
      state: 'Booted',
      isAvailable: true,
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    });
    expect(d[2].isAvailable).toBe(false);
    expect(() => parseDevices('[1]')).toThrow(/no JSON object/);
  });

  it('device types by name (case and spaces aside); runtimes with the types they run', () => {
    const types = parseDeviceTypes(TYPES);
    expect(types.map((t) => t.name)).toEqual(['iPhone 16', 'iPhone 17 Pro']);
    expect(deviceTypeNamed(types, '  iphone 17 pro ')?.identifier).toBe('com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
    expect(deviceTypeNamed(types, 'iPhone 99')).toBeNull();
    const rt = parseRuntimes(RUNTIMES);
    expect(rt[1].supported).toContain('com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro');
  });

  it('the newest available iOS runtime that runs the type (an unavailable newer one is not it)', () => {
    const rt = parseRuntimes(RUNTIMES);
    expect(newestRuntimeFor(rt, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16')?.name).toBe('iOS 26.5');
    expect(newestRuntimeFor(rt, 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro')?.name).toBe('iOS 26.5');
    expect(newestRuntimeFor(rt, 'com.apple.CoreSimulator.SimDeviceType.iPad')).toBeNull();
    expect(versionLess('18.2', '26.5')).toBe(true);
    expect(versionLess('26.10', '26.5')).toBe(false);
    expect(versionLess('26.5', '26.5.0')).toBe(false);
  });

  it("Retake's device name is ASCII only", () => {
    expect(retakeDeviceName('iPhone 17 Pro', 'iOS 26.5')).toBe('Retake - iPhone 17 Pro - iOS 26.5');
    expect(retakeDeviceName(`iPhone${String.fromCharCode(0xa0)}17 Pro`, 'iOS 26.5')).toBe('Retake - iPhone-17 Pro - iOS 26.5');
  });

  it("a profile.plist's screen: points and scale", () => {
    expect(screenOfProfile(JSON.stringify({ mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3 }), 'iPhone 17 Pro')).toEqual({ width: 402, height: 874, scale: 3 });
    expect(() => screenOfProfile('{}', 'x')).toThrow(/no screen size/);
    expect(() => screenOfProfile('nope', 'x')).toThrow(/no JSON/);
  });
});
