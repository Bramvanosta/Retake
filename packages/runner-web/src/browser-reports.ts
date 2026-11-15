/** Chromium's own reports for a browser session: its version, its processes and its GPU. */
import type { BrowserContext, CDPSession } from 'playwright-core';
import { bestEffort } from '@retake/core/base';
import { gpuInfoOf } from '@retake/core/render';
import type { GpuInfo, SystemInfoReply } from '@retake/core/render';

/** A realm as the reports see it: its persona name and its context. */
export interface ReportedRealm {
  name: string;
  context: BrowserContext;
}

/** One process of a realm's browser, as Chromium reports it (run.json `perf`). */
export interface ProcessReport {
  realm: string;
  type: string;
  pid: number;
  cpu: number;
}

/**
 * The browser's version ("141.0.7390.37", run.json `engine.chromium`), read over CDP on a page of the session (a
 * persistent context has no Browser object); undefined when it cannot be read.
 */
export async function browserVersionOf(context: BrowserContext): Promise<string | undefined> {
  const page = context.pages()[0];
  if (!page) return undefined;
  try {
    const cdp = await context.newCDPSession(page);
    try {
      const { product } = await cdp.send('Browser.getVersion');
      return /\/(\S+)$/.exec(product)?.[1] ?? product;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

/** Chromium's process and GPU reports, over a browser-level CDP session per realm. */
export class BrowserReports {
  /** A browser-level CDP session per realm (Chromium's process and GPU reports), opened once. */
  private readonly browserCdp = new Map<ReportedRealm, Promise<CDPSession | null>>();

  private browserTarget(realm: ReportedRealm): Promise<CDPSession | null> {
    let p = this.browserCdp.get(realm);
    if (!p) {
      const browser = realm.context.browser();
      p = browser ? bestEffort(browser.newBrowserCDPSession(), 'a browser without a browser-level session is not measured', null) : Promise.resolve(null);
      this.browserCdp.set(realm, p);
    }
    return p;
  }

  /** Each realm's processes (BrowserSession.processInfo); realms that cannot answer are left out. */
  async processInfo(realms: readonly ReportedRealm[]): Promise<ProcessReport[]> {
    const out: ProcessReport[] = [];
    await Promise.all(
      realms.map(async (realm) => {
        const cdp = await this.browserTarget(realm);
        if (!cdp) return;
        try {
          const r = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number; cpuTime: number }> };
          for (const p of r.processInfo) out.push({ realm: realm.name, type: p.type, pid: p.id, cpu: p.cpuTime });
        } catch {
          /* closing, or an older browser */
        }
      }),
    );
    return out;
  }

  /** The GPU feature report of a realm's browser (BrowserSession.gpuInfo); undefined when it cannot be read. */
  async gpuInfo(realm: ReportedRealm | undefined): Promise<GpuInfo | undefined> {
    const cdp = realm ? await this.browserTarget(realm) : null;
    if (!cdp) return undefined;
    try {
      return gpuInfoOf((await cdp.send('SystemInfo.getInfo')) as SystemInfoReply);
    } catch {
      return undefined;
    }
  }
}
