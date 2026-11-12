/**
 * What a take costs (L5.7, R-FLD-23): CPU seconds per process group while the take runs, sampled every PERF_SAMPLE_MS —
 * Chromium's own process report (SystemInfo.getProcessInfo, per browser: one per persona) for its browser processes
 * (they encode the screencast's JPEG frames), GPU processes, page renderers and other helpers; the system's process
 * table (`ps -p`) for the encoders and the product's local servers (the processes listening on the environment's
 * localhost ports); Retake's own process from Node. The machine's load average is read on every sample. A process
 * that exits between two samples loses its last interval: a measure, not an account. A pause of the take (L4.4) counts
 * for nothing: neither its CPU nor its seconds (`pause()` / `resume()`).
 */
import { execFile } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import type { RunPerfCpu } from '@retake/core/model';

export const PERF_SAMPLE_MS = 2000;

type Group = 'browser' | 'gpu' | 'renderer' | 'chromium_other' | 'encoder' | 'product';

/** A Chromium process as SystemInfo.getProcessInfo reports it, with the realm (persona; "" = none) it belongs to. */
export interface ChromiumProcess {
  realm: string;
  type: string;
  pid: number;
  /** CPU seconds since it started. */
  cpu: number;
}

interface Tracked {
  group: Group;
  /** CPU seconds the take's share starts from, and at the last sample. */
  base: number;
  last: number;
  realm?: string;
}

/** `[[dd-]hh:]mm:ss[.cc]` (ps `time`) → seconds. */
export function parseCpuTime(s: string): number {
  const m = /^(?:(\d+)-)?([\d:.]+)$/.exec(s.trim());
  if (!m) return NaN;
  let sec = 0;
  for (const part of m[2].split(':')) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) return NaN;
    sec = sec * 60 + Number(part);
  }
  return sec + (m[1] ? Number(m[1]) * 86400 : 0);
}

/** The group of a Chromium process type ("browser", "GPU", "renderer", "network.mojom.NetworkService"…). */
export function chromiumGroup(type: string): Group {
  if (type === 'browser') return 'browser';
  if (type === 'GPU' || type === 'gpu-process') return 'gpu';
  if (type === 'renderer') return 'renderer';
  return 'chromium_other';
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 << 20, timeout: 5000 }, (err, stdout) => resolve(err ? stdout || '' : stdout));
  });
}

/** CPU seconds of these pids now (`ps -o pid=,time= -p …`; gone pids are absent). */
async function psTimes(pids: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!pids.length || process.platform === 'win32') return out;
  const text = await run('ps', ['-o', 'pid=,time=', '-p', pids.join(',')]);
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)/);
    if (!m) continue;
    const cpu = parseCpuTime(m[2]);
    if (Number.isFinite(cpu)) out.set(Number(m[1]), cpu);
  }
  return out;
}

/** Pids listening on these local TCP ports (`lsof`; none when it is missing). */
export async function listeningPids(ports: readonly number[]): Promise<number[]> {
  if (!ports.length || process.platform === 'win32') return [];
  const out = await run('lsof', ['-nP', '-t', '-sTCP:LISTEN', ...ports.map((p) => `-iTCP:${p}`)]);
  return [
    ...new Set(
      out
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid),
    ),
  ];
}

/** Local ports of page URLs (localhost, 127.0.0.1, [::1], *.localhost). */
export function localPorts(urls: readonly string[]): number[] {
  const out = new Set<number>();
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (!/^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(url.hostname)) continue;
      out.add(Number(url.port || (url.protocol === 'https:' ? 443 : 80)));
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

export interface PerfSamplerOptions {
  /** Chromium's process report (BrowserSession.processInfo). */
  chromium: () => Promise<ChromiumProcess[]>;
  /** The realms (personas; "" = none) a recorder films now: the others' CPU counts as unfilmed (R-FLD-25). */
  filmed?: () => ReadonlySet<string>;
  intervalMs?: number;
}

/** Above this many cores while not filmed, a persona's browser is worth a run warning (R-FLD-25). */
export const UNFILMED_WARN_CORES = 0.25;

/** Samples the take's CPU (see the module comment): `start()`, then `stop()` returns the totals. */
export class PerfSampler {
  private readonly procs = new Map<string, Tracked>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private samples = 0;
  private t0 = 0;
  private own0 = 0;
  private loads: number[] = [];
  private readonly encoderPids = new Set<number>();
  private readonly productPids = new Set<number>();
  private chromiumSeen = false;
  private lastSampleAt = 0;
  /** Per realm: CPU seconds and wall seconds while no recorder filmed it. */
  private readonly unfilmed = new Map<string, { cpu: number; seconds: number }>();
  /** A pause of the take (L4.4): when it began (0: none), Retake's own CPU then, the wall ms of the pauses so far. */
  private pausedAt = 0;
  private ownAtPause = 0;
  private pausedMs = 0;

  constructor(private readonly opts: PerfSamplerOptions) {}

  addEncoder(pid: number | undefined): void {
    if (pid) this.encoderPids.add(pid);
  }

  addProduct(pids: readonly number[]): void {
    for (const p of pids) this.productPids.add(p);
  }

  start(): void {
    this.t0 = Date.now();
    this.own0 = cpuSeconds(process.cpuUsage());
    this.tick();
    this.lastSampleAt = Date.now();
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? PERF_SAMPLE_MS);
    this.timer.unref?.();
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.sample().finally(() => (this.running = null));
  }

  /** The take pauses (L4.4): what ran up to now is sampled; from now until `resume` nothing counts. */
  async pause(): Promise<void> {
    if (this.pausedAt || !this.t0) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    await this.sample();
    this.pausedAt = Date.now();
    this.ownAtPause = cpuSeconds(process.cpuUsage());
  }

  /** The take goes on: the CPU every process used during the pause, and its seconds, are left out. */
  async resume(): Promise<void> {
    if (!this.pausedAt) return;
    await this.sample(true);
    this.pausedMs += Date.now() - this.pausedAt;
    this.own0 += cpuSeconds(process.cpuUsage()) - this.ownAtPause;
    this.pausedAt = 0;
    this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? PERF_SAMPLE_MS);
    this.timer.unref?.();
  }

  /** A process seen at the first sample counts from then; one that started later, from its start (during the take). */
  /** Returns the CPU seconds the process used since the previous sample (`skip`: the end of a pause — none counts). */
  private track(key: string, group: Group, cpu: number, realm?: string, skip = false): number {
    const t = this.procs.get(key);
    if (t) {
      const d = Math.max(0, cpu - t.last);
      if (skip) t.base += d;
      t.last = Math.max(t.last, cpu);
      return skip ? 0 : d;
    }
    const base = this.samples === 0 || skip ? cpu : 0;
    this.procs.set(key, { group, base, last: cpu, ...(realm !== undefined ? { realm } : {}) });
    return Math.max(0, cpu - base);
  }

  /** `skip`: the sample that ends a pause — what every process used since the previous sample does not count. */
  private async sample(skip = false): Promise<void> {
    try {
      if (!skip) this.loads.push(loadavg()[0]);
      const [chromium, times] = await Promise.all([this.opts.chromium().catch(() => []), psTimes([...this.encoderPids, ...this.productPids])]);
      if (chromium.length) this.chromiumSeen = true;
      const now = Date.now();
      const filmed = this.opts.filmed?.();
      const used = new Map<string, number>();
      for (const p of chromium) used.set(p.realm, (used.get(p.realm) ?? 0) + this.track(`c${p.pid}`, chromiumGroup(p.type), p.cpu, p.realm, skip));
      // What each realm used since the previous sample while nobody filmed it.
      if (filmed && this.samples > 0 && !skip) {
        for (const [realm, cpu] of used) {
          if (filmed.has(realm)) continue;
          const u = this.unfilmed.get(realm) ?? { cpu: 0, seconds: 0 };
          u.cpu += cpu;
          u.seconds += (now - this.lastSampleAt) / 1000;
          this.unfilmed.set(realm, u);
        }
      }
      this.lastSampleAt = now;
      for (const [pid, cpu] of times) this.track(`p${pid}`, this.encoderPids.has(pid) ? 'encoder' : 'product', cpu, undefined, skip);
      this.samples++;
    } catch {
      /* a sample lost */
    }
  }

  async stop(): Promise<RunPerfCpu | undefined> {
    // Stopped while paused (a cancel): the pause counts for nothing either.
    if (this.pausedAt) await this.resume();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
    await this.sample();
    const seconds = Math.max(0.001, (Date.now() - this.t0 - this.pausedMs) / 1000);
    if (!this.chromiumSeen) return undefined;
    const list = [...this.procs.values()];
    const sum = (f: (p: Tracked) => boolean) => round2(list.filter(f).reduce((n, p) => n + Math.max(0, p.last - p.base), 0));
    const out: RunPerfCpu = {
      browser: sum((p) => p.group === 'browser'),
      gpu: sum((p) => p.group === 'gpu'),
      renderer: sum((p) => p.group === 'renderer'),
      chromium_other: sum((p) => p.group === 'chromium_other'),
      retake: round2(cpuSeconds(process.cpuUsage()) - this.own0),
      encoder: sum((p) => p.group === 'encoder'),
      total: 0,
      cores: 0,
    };
    if (this.productPids.size) out.product = sum((p) => p.group === 'product');
    out.total = round2(out.browser + out.gpu + out.renderer + out.chromium_other + out.retake + out.encoder + (out.product ?? 0));
    out.cores = round2(out.total / seconds);
    const realms = [...new Set(list.filter((p) => p.realm !== undefined).map((p) => p.realm!))];
    if (realms.length > 1) {
      out.browsers = realms.map((r) => {
        const u = this.unfilmed.get(r);
        return { ...(r ? { persona: r } : {}), cpu: sum((p) => p.realm === r), ...(u && u.seconds > 0 ? { unfilmed: { cpu: round2(u.cpu), seconds: round2(u.seconds) } } : {}) };
      });
    }
    return out;
  }

  /** The machine during the take: logical CPUs and the 1-minute load average (mean, highest). */
  machine(): { cpus: number; load_mean: number; load_max: number } {
    const l = this.loads.length ? this.loads : [loadavg()[0]];
    return { cpus: cpus().length || 1, load_mean: round2(l.reduce((a, b) => a + b, 0) / l.length), load_max: round2(Math.max(...l)) };
  }
}

function cpuSeconds(u: NodeJS.CpuUsage): number {
  return (u.user + u.system) / 1e6;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
