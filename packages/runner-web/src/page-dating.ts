/**
 * How the filmed pages write dates (R-MAIL-05): the time zone and locale of the browser's Intl defaults, recorded on a
 * captured mail so a mail card writes its date the same way. BrowserSession reads them once, when it opens, from a
 * page that has loaded nothing yet: no product page is asked (its own scripts cannot answer, a busy page cannot slow a
 * take) and every mail of a run gets the same values.
 */
import type { Page } from 'playwright-core';
import type { BrowserConfig } from '@retake/core/project';

/** The time zone (IANA) and locale (BCP 47) the filmed pages write dates in. */
export interface PageDating {
  timezone?: string;
  locale?: string;
}

/** How long the blank page is given to answer. */
export const DATING_TIMEOUT_MS = 2000;

/** The longest locale tag kept (a language, a script, a region and a variant fit). */
const LOCALE_MAX = 35;

/**
 * A locale tag as a card may hand it to Intl: canonical, without extensions (`-u-ca-buddhist` would change the
 * calendar, `-x-…` is private), at most LOCALE_MAX characters; undefined for anything else.
 */
export function cleanLocale(tag: unknown): string | undefined {
  if (typeof tag !== 'string' || !tag) return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(tag)[0];
    const base = canonical?.split(/-[a-wyzA-WYZ0-9]-|-x-/)[0];
    return base && base.length <= LOCALE_MAX ? base : undefined;
  } catch {
    return undefined;
  }
}

/** An IANA zone name this Node.js knows (at most 64 characters); undefined for anything else. */
export function cleanZone(zone: unknown): string | undefined {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** The Intl defaults of `page` (a page that has loaded nothing), or {} when it does not answer within DATING_TIMEOUT_MS. */
export async function readPageDating(page: Page | undefined): Promise<PageDating> {
  if (!page || page.isClosed()) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const asked = page.evaluate(() => {
    const r = Intl.DateTimeFormat().resolvedOptions();
    return { timezone: r.timeZone, locale: r.locale };
  });
  asked.catch(() => undefined);
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), DATING_TIMEOUT_MS);
  });
  try {
    const o = await Promise.race([asked, late]);
    if (!o) return {};
    const timezone = cleanZone(o.timezone);
    const locale = cleanLocale(o.locale);
    return { ...(timezone ? { timezone } : {}), ...(locale ? { locale } : {}) };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** What the browser said, else the run's browser settings, else (the zone) the machine's. */
export function settleDating(read: PageDating, browser: BrowserConfig | undefined, machineZone: string | undefined): PageDating {
  const timezone = read.timezone ?? cleanZone(browser?.timezone) ?? cleanZone(machineZone);
  const locale = read.locale ?? cleanLocale(browser?.locale);
  return { ...(timezone ? { timezone } : {}), ...(locale ? { locale } : {}) };
}
