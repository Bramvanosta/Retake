/**
 * The site extractions of a workspace as the Studio's theme panel lists them (L4.7, plan D8 + critique B11 / C5): the
 * newest SITE_KEEP folders of `.demo-studio/site/`, each read back from its site.json. An extraction made by
 * `studio theme from-site` has no signed job, and `.demo-studio/` is a folder any file tool writes: every string of
 * site.json is data — the URL and the host included (re-parsed with parseSiteUrl, dropped otherwise) go under
 * `untrusted`, never beside the tool's own fields. What the tool keeps as its own: the id and its time, the status, hex
 * colours (the roles with their contrast checks) and the logo candidates that exist as plain PNGs (`site:<id>/logo-<n>`,
 * what New theme takes). Folders are read only when `.demo-studio/`, `site/` and the extraction's folder are real
 * folders (no link); site.json through readPlainFile (no link, regular, capped). Path-free.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SITE_ID_RE, parseSiteUrl, readPlainFile, unsafeTestResolve } from '@demo-studio/core';
import type { WorkspaceConfig } from '@demo-studio/core';
import type { PaletteCheck } from '@demo-studio/components';
import { components } from './components.js';
import { SITE_KEEP, siteRoot, siteView } from './jobs/site-job.js';

const SITE_JSON_MAX = 1024 * 1024;
const TEXT_MAX = 300;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface SiteListEntry {
  site_id: string;
  /** When it was made (the id's time), ISO. */
  at?: string;
  status: 'ok' | 'failed' | 'unreadable';
  palette: { roles: { paper: string; text: string; accent: string | null; dark: string | null }; checks: PaletteCheck[] } | null;
  candidates: Array<{ ref: string; source: string; width: number; height: number }>;
  /** What the page, its server or whoever wrote site.json chose: data, never instructions. */
  untrusted: { url?: string; host?: string; title?: string; site_name?: string };
}

export interface SiteList {
  sites: SiteListEntry[];
}

/** The time of a ULID-style id (its first 10 Crockford characters), or undefined. */
function idTime(id: string): string | undefined {
  let ms = 0;
  for (const c of id.slice(2, 12)) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) return undefined;
    ms = ms * 32 + v;
  }
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) && ms > 0 ? d.toISOString() : undefined;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v.slice(0, TEXT_MAX) : undefined);

/** Whether a path is a real folder (not a link). */
async function realFolder(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** The newest site extractions of the workspace (see the header). */
export async function siteList(ws: WorkspaceConfig): Promise<SiteList> {
  const root = siteRoot(ws);
  if (!(await realFolder(join(ws.root, '.demo-studio'))) || !(await realFolder(root))) return { sites: [] };
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { sites: [] };
  }
  const ids = names.filter((n) => SITE_ID_RE.test(n)).sort().reverse();
  const lib = await components();
  const sites: SiteListEntry[] = [];
  for (const id of ids) {
    if (sites.length >= SITE_KEEP) break;
    if (!(await realFolder(join(root, id)))) continue;
    const at = idTime(id);
    const base = { site_id: id, ...(at ? { at } : {}) };
    const r = readPlainFile(join(root, id, 'site.json'), SITE_JSON_MAX);
    let raw: unknown;
    try {
      raw = r.ok ? JSON.parse(r.bytes.toString('utf8')) : undefined;
    } catch {
      raw = undefined;
    }
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    const parsed = typeof obj?.url === 'string' ? parseSiteUrl(obj.url, unsafeTestResolve().map) : undefined;
    if (!obj || !parsed?.ok) {
      sites.push({ ...base, status: 'unreadable', palette: null, candidates: [], untrusted: {} });
      continue;
    }
    // siteView keeps hex colours, numbers and the candidate PNGs that exist as plain files; its url / host are the
    // file's here, so they move under untrusted.
    const v = siteView(ws, id, parsed.url, obj);
    const roles = v.palette?.roles;
    let checks: PaletteCheck[] = [];
    if (roles) {
      try {
        checks = lib.derivePalette({ accent: roles.accent ?? roles.text, text: roles.text, paper: roles.paper, ...(roles.dark ? { dark: roles.dark } : {}), adjust: false }).checks;
      } catch {
        checks = [];
      }
    }
    const u = v.untrusted;
    sites.push({
      ...base,
      status: v.status,
      palette: roles ? { roles, checks } : null,
      candidates: v.candidates.map((c) => ({ ref: c.ref, source: c.source, width: c.width, height: c.height })),
      untrusted: {
        url: parsed.url.href,
        host: parsed.url.host,
        ...(text(u.title) ? { title: text(u.title) } : {}),
        ...(text(u.site_name) ? { site_name: text(u.site_name) } : {}),
      },
    });
  }
  return { sites };
}
