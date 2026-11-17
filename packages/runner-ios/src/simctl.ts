/**
 * `xcrun simctl`: the commands an iOS run sends to the simulator (through an Exec), and the pure readers of its JSON
 * lists (`list devices | devicetypes | runtimes -j`) — which device types and runtimes exist, which device is Retake's.
 */
import type { Exec, ProcResult, RunOpts } from './proc.js';
import { procProblem } from './proc.js';

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
  /** The runtime identifier it runs (the key of `list devices -j`). */
  runtime: string;
  deviceTypeIdentifier?: string;
}

export interface SimDeviceType {
  name: string;
  identifier: string;
  bundlePath: string;
  productFamily?: string;
}

export interface SimRuntime {
  name: string;
  identifier: string;
  version: string;
  platform: string;
  isAvailable: boolean;
  /** The device type identifiers it runs. */
  supported: string[];
}

/** An object of `text` (a JSON document), or the error. Pure. */
function jsonOf(text: string, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* below */
  }
  throw new Error(`simctl list ${what} -j gave no JSON object`);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `simctl list devices -j`: every device with the runtime it runs. Pure. */
export function parseDevices(text: string): SimDevice[] {
  const devices = jsonOf(text, 'devices').devices;
  if (devices === null || typeof devices !== 'object') return [];
  const out: SimDevice[] = [];
  for (const [runtime, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const d of list as Array<Record<string, unknown>>) {
      if (!d || typeof d.udid !== 'string') continue;
      out.push({
        udid: d.udid,
        name: str(d.name),
        state: str(d.state),
        isAvailable: d.isAvailable !== false,
        runtime,
        ...(typeof d.deviceTypeIdentifier === 'string' ? { deviceTypeIdentifier: d.deviceTypeIdentifier } : {}),
      });
    }
  }
  return out;
}

/** `simctl list devicetypes -j`. Pure. */
export function parseDeviceTypes(text: string): SimDeviceType[] {
  const list = jsonOf(text, 'devicetypes').devicetypes;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .filter((t) => t && typeof t.name === 'string' && typeof t.identifier === 'string')
    .map((t) => ({ name: str(t.name), identifier: str(t.identifier), bundlePath: str(t.bundlePath), ...(typeof t.productFamily === 'string' ? { productFamily: t.productFamily } : {}) }));
}

/** `simctl list runtimes -j`. Pure. */
export function parseRuntimes(text: string): SimRuntime[] {
  const list = jsonOf(text, 'runtimes').runtimes;
  if (!Array.isArray(list)) return [];
  return (list as Array<Record<string, unknown>>)
    .filter((r) => r && typeof r.identifier === 'string')
    .map((r) => ({
      name: str(r.name),
      identifier: str(r.identifier),
      version: str(r.version),
      platform: str(r.platform) || (str(r.name).startsWith('iOS') ? 'iOS' : ''),
      isAvailable: r.isAvailable !== false,
      supported: Array.isArray(r.supportedDeviceTypes) ? (r.supportedDeviceTypes as Array<Record<string, unknown>>).map((t) => str(t?.identifier)).filter(Boolean) : [],
    }));
}

/** a < b on dotted versions ("18.2" < "26.5"). Pure. */
export function versionLess(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** The newest available iOS runtime that runs the device type `typeId` (null: none). Pure. */
export function newestRuntimeFor(runtimes: readonly SimRuntime[], typeId: string): SimRuntime | null {
  let best: SimRuntime | null = null;
  for (const r of runtimes) {
    if (!r.isAvailable || r.platform !== 'iOS' || !r.supported.includes(typeId)) continue;
    if (!best || versionLess(best.version, r.version)) best = r;
  }
  return best;
}

/** The name of Retake's own device of a type and runtime: ASCII only ("Retake - iPhone 17 Pro - iOS 26.5"). Pure. */
export function retakeDeviceName(type: string, runtime: string): string {
  const ascii = (s: string) => s.replace(/[^ -~]/g, '-');
  return `Retake - ${ascii(type)} - ${ascii(runtime)}`;
}

/** A device type by its name, compared without case and surrounding spaces. Pure. */
export function deviceTypeNamed(types: readonly SimDeviceType[], name: string): SimDeviceType | null {
  const want = name.trim().toLowerCase();
  return types.find((t) => t.name.toLowerCase() === want) ?? null;
}

/** The simctl commands of a run, through `exec`, with the run's cancel. */
export class Simctl {
  constructor(
    private readonly exec: Exec,
    private readonly xcrun: string,
    private readonly signal?: AbortSignal,
  ) {}

  /** Run `simctl <args>`; its result, never throwing. */
  raw(args: readonly string[], o: RunOpts = {}): Promise<ProcResult> {
    return this.exec.run(this.xcrun, ['simctl', ...args], { timeoutMs: 60_000, ...(this.signal ? { signal: this.signal } : {}), ...o });
  }

  /** Run `simctl <args>`; its stdout, or an Error naming what failed. */
  async ok(args: readonly string[], o: RunOpts = {}): Promise<string> {
    const r = await this.raw(args, o);
    const problem = procProblem(r, `simctl ${args[0]}`);
    if (problem) throw new Error(problem);
    return r.stdout;
  }

  async devices(): Promise<SimDevice[]> {
    return parseDevices(await this.ok(['list', 'devices', '-j']));
  }

  async deviceTypes(): Promise<SimDeviceType[]> {
    return parseDeviceTypes(await this.ok(['list', 'devicetypes', '-j']));
  }

  async runtimes(): Promise<SimRuntime[]> {
    return parseRuntimes(await this.ok(['list', 'runtimes', '-j']));
  }

  async create(name: string, typeId: string, runtimeId: string): Promise<string> {
    const udid = (await this.ok(['create', name, typeId, runtimeId])).trim();
    if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new Error(`simctl create gave no device id (${udid.slice(0, 80)})`);
    return udid;
  }

  async boot(udid: string): Promise<void> {
    const r = await this.raw(['boot', udid], { timeoutMs: 180_000 });
    // "Unable to boot device in current state: Booted": booted already.
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw new Error(procProblem(r, 'simctl boot') ?? 'simctl boot failed');
  }

  async bootStatus(udid: string): Promise<void> {
    await this.ok(['bootstatus', udid, '-b'], { timeoutMs: 300_000 });
  }

  async shutdown(udid: string): Promise<void> {
    const r = await this.raw(['shutdown', udid], { timeoutMs: 60_000 });
    if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw new Error(procProblem(r, 'simctl shutdown') ?? 'simctl shutdown failed');
  }

  /** `simctl spawn <udid> defaults write -g <key> <value…>` (the device's own preferences). */
  async writeGlobalDefault(udid: string, key: string, value: readonly string[]): Promise<void> {
    await this.ok(['spawn', udid, 'defaults', 'write', '-g', key, ...value]);
  }

  /** `simctl spawn <udid> defaults read -g <key>`: the device's own preference, or null when it has none. */
  async readGlobalDefault(udid: string, key: string): Promise<string | null> {
    const r = await this.raw(['spawn', udid, 'defaults', 'read', '-g', key]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async install(udid: string, app: string): Promise<void> {
    await this.ok(['install', udid, app], { timeoutMs: 180_000 });
  }

  /** Whether the app `bundleId` is installed on the device. */
  async installed(udid: string, bundleId: string): Promise<boolean> {
    return (await this.raw(['get_app_container', udid, bundleId])).code === 0;
  }

  /** Stop an app (an app not running: nothing). */
  async terminate(udid: string, bundleId: string): Promise<void> {
    await this.raw(['terminate', udid, bundleId], { timeoutMs: 20_000 });
  }

  async statusBar(udid: string, time: string): Promise<void> {
    await this.ok([
      'status_bar',
      udid,
      'override',
      '--time',
      time,
      '--dataNetwork',
      'wifi',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
    ]);
  }

  async clearStatusBar(udid: string): Promise<void> {
    await this.raw(['status_bar', udid, 'clear'], { timeoutMs: 20_000 });
  }

  async screenshot(udid: string, file: string): Promise<void> {
    await this.ok(['io', udid, 'screenshot', '--type=png', file], { timeoutMs: 30_000 });
  }
}
