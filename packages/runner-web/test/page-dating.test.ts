/**
 * How the filmed pages write dates (R-MAIL-05): the browser's Intl defaults cleaned before a mail card hands them to
 * Intl in the render, and the run's settings or the machine's zone when the browser said nothing.
 */
import { describe, expect, it } from 'vitest';
import { cleanLocale, cleanZone, settleDating } from '../src/page-dating.js';

describe('page dating (R-MAIL-05)', () => {
  it('a locale is kept canonical, without extensions that change the calendar or the digits, and short', () => {
    expect(cleanLocale('en-US')).toBe('en-US');
    expect(cleanLocale('EN-us')).toBe('en-US');
    expect(cleanLocale('th-TH-u-ca-buddhist-nu-thai')).toBe('th-TH');
    expect(cleanLocale('en-US-x-private')).toBe('en-US');
    expect(cleanLocale('not a locale!')).toBeUndefined();
    expect(cleanLocale(`en-${'a'.repeat(8)}-${'b'.repeat(8)}-${'c'.repeat(8)}-${'d'.repeat(8)}`)).toBeUndefined();
    expect(cleanLocale(42)).toBeUndefined();
  });

  it('a zone is kept when Intl knows it', () => {
    expect(cleanZone('Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(cleanZone('Mars/Olympus')).toBeUndefined();
    expect(cleanZone('')).toBeUndefined();
    expect(cleanZone(`Europe/${'x'.repeat(80)}`)).toBeUndefined();
  });

  it("what the browser said wins; else the run's browser settings; else, for the zone, the machine's", () => {
    expect(settleDating({ timezone: 'Asia/Tokyo', locale: 'fr-CA' }, { timezone: 'Europe/Paris', locale: 'en-US' }, 'UTC')).toEqual({ timezone: 'Asia/Tokyo', locale: 'fr-CA' });
    expect(settleDating({}, { timezone: 'Europe/Paris', locale: 'en-US' }, 'UTC')).toEqual({ timezone: 'Europe/Paris', locale: 'en-US' });
    expect(settleDating({}, undefined, 'UTC')).toEqual({ timezone: 'UTC' });
    expect(settleDating({}, { locale: 'bad tag!' }, undefined)).toEqual({});
  });
});
