/** The environment of the run: the review's environment line, writes the guard stopped, hidden and local URLs. */
import { findLocalUrls } from '@retake/core/environment';
import type { TimelineWrite } from '@retake/core/environment';
import type { Timeline } from '@retake/core/run';
import { drawsUrl } from '@retake/editor/plan';
import type { EditPlan, ResolvedComponent } from '@retake/editor/plan';
import type { CheckContext } from './checks-base.js';
import { finding, fmtS, localPath, locate, outputFrameAtCapture, pathOf, shownUrl } from './checks-base.js';
import type { Finding, ReviewEnvironment } from './types.js';
import { isClip } from './spans.js';

/**
 * The environment line of a review (report.md, the CLI): from the run's timeline (the display URLs: those the edit
 * used, `plan.display`); undefined for an older run, which recorded none.
 */
export function reviewEnvironment(timeline: Timeline | undefined, plan?: Pick<EditPlan, 'display'>): ReviewEnvironment | undefined {
  const env = timeline?.environment;
  if (!env) return undefined;
  const writes = { blocked: 0, mocked: 0, allowed: 0, passed: 0 };
  for (const w of env.writes ?? []) if (w.outcome !== 'exempt') writes[w.outcome]++;
  const out: ReviewEnvironment = { name: env.name, access: env.access, writes };
  if (env.production) out.production = true;
  if (env.allow_writes) out.allow_writes = true;
  if (env.clock) out.clock = { at: env.clock.at, ...(env.clock.timezone ? { timezone: env.clock.timezone } : {}), ...(env.clock.freeze ? { freeze: true as const } : {}) };
  const display = (plan?.display ?? env.display ?? []).flatMap((d) => (d.display !== undefined ? [d.display] : []));
  if (display.length) out.display = display;
  return out;
}

/** "production · production · read-only · 1 write mocked · clock 2026-11-02T10:24:00" (report.md, the CLI). */
export function environmentLine(e: ReviewEnvironment): string {
  const parts = [e.name];
  if (e.production) parts.push('production');
  parts.push(e.access === 'read-only' ? 'read-only' : e.allow_writes ? 'read-write (--allow-writes)' : 'read-write');
  if (e.access !== 'read-only' && e.writes.blocked) parts.push(`${e.writes.blocked} stopped (hosts of read-only environments)`);
  if (e.access === 'read-only') {
    const w = e.writes;
    const said = [
      w.mocked ? `${w.mocked} write${w.mocked > 1 ? 's' : ''} mocked` : '',
      w.blocked ? `${w.blocked} stopped` : '',
      w.allowed ? `${w.allowed} allowed` : '',
      w.passed ? `${w.passed} to unguarded hosts` : '',
    ].filter(Boolean);
    parts.push(said.length ? said.join(', ') : 'no write');
  }
  if (e.clock) parts.push(`clock ${e.clock.at}${e.clock.timezone ? ` ${e.clock.timezone}` : ''}${e.clock.freeze ? ' (frozen)' : ''}`);
  return parts.join(' · ');
}

/**
 * The environment of the run (R-ENV-01/04): - `write-blocked` (warning): a write the read-only guard stopped (the app
 * saw a network error: an error state may be on screen) — one per method and path, at the output frame of its first one
 * when the video shows that moment; - `url-hidden` (warning): a clip whose layout draws the page URL (browser bar,
 * window bars, tab strip) while its page is at a local URL without a display URL — the bar shows no address there; -
 * `local-url-text` (warning): a caption, card, overlay, page label, intro or outro text naming a local URL (it is burnt
 * into the video): `{{page}}` with a display URL in project.yaml writes the public one. Named by its path only: a
 * report never names a local host.
 * URLs are named through the display table the edit used (`plan.display`), else the one the run recorded.
 */
export function checkEnvironment(ctx: CheckContext): Finding[] {
  const out: Finding[] = [];
  const table = ctx.plan.display ?? ctx.timeline?.environment?.display ?? [];
  const seen = new Map<string, { first: TimelineWrite; count: number }>();
  for (const w of ctx.timeline?.environment?.writes ?? []) {
    if (w.outcome !== 'blocked') continue;
    let path = w.url;
    try {
      const u = new URL(w.url);
      path = `${u.origin}${u.pathname}`;
    } catch {
      /* keep the URL */
    }
    const key = `${w.method} ${path}`;
    const s = seen.get(key);
    if (s) s.count++;
    else seen.set(key, { first: w, count: 1 });
  }
  for (const { first: w, count } of seen.values()) {
    const url = shownUrl(w.url.replace(/[?#].*$/, ''), table);
    const frame = w.t !== undefined ? outputFrameAtCapture(ctx, w.t) : undefined;
    const when = w.t === undefined ? ' before the capture started' : frame === undefined ? ` at capture ${fmtS(w.t)} (not in the video)` : '';
    out.push(
      finding(
        'warning',
        'write-blocked',
        `a write was stopped${when}: ${w.method} ${url}${w.operation ? ` (${w.operation})` : ''}${count > 1 ? ` ×${count}` : ''}${w.via === 'hook' ? ' from a js hook' : w.via === 'sign-in' ? ' from the automated sign-in' : ''} — ` +
          (w.protected_by
            ? `a host of read-only environment ${w.protected_by}: the app saw a network error and may show it (docs/guide/environments.md)`
            : 'the app saw a network error and may show it; add a mock (docs/guide/environments.md)'),
        frame !== undefined ? locate(ctx, frame) : undefined,
      ),
    );
  }
  for (const s of ctx.plan.segments) {
    if (!isClip(s)) continue;
    const lists: Array<{ urls: typeof s.urls; label: string }> = s.panes
      ? s.panes.flatMap((p, i) => (drawsUrl(s, i) ? [{ urls: p.urls, label: `${s.id} (${p.label ?? p.page})` }] : []))
      : drawsUrl(s)
        ? [{ urls: s.urls, label: s.id }]
        : [];
    for (const { urls, label } of lists) {
      const hidden = urls.find((u) => u.hidden);
      if (!hidden) continue;
      out.push(
        finding(
          'warning',
          'url-hidden',
          ctx.timeline?.environment?.sandbox
            ? `${label}: the browser bar shows no address while the page is at ${localPath(hidden.url)} — a local URL without a display URL: add display: to its page in the sandbox.yaml of sandbox ${ctx.timeline.environment.sandbox.name} (services.<service>.pages) and render again (docs/guide/sandbox.md)`
            : `${label}: the browser bar shows no address while the page is at ${localPath(hidden.url)} — a local URL without a display URL: add display: to its page in project.yaml environments and render again (docs/guide/environments.md)`,
          locate(ctx, s.from + Math.max(0, Math.min(hidden.frame, s.durationInFrames - 1))),
        ),
      );
    }
  }
  const text = (value: string | undefined, where: string, frame: number) => {
    if (!value) return;
    const found = findLocalUrls(value);
    if (found.length === 0) return;
    out.push(
      finding(
        'warning',
        'local-url-text',
        `${where} shows a local URL (${[...new Set(found.map(pathOf))].join(', ')}): it is burnt into the video — write {{page}} and give that page a display URL in ${ctx.timeline?.environment?.sandbox ? `the sandbox.yaml of sandbox ${ctx.timeline.environment.sandbox.name}` : 'project.yaml'}, or write the public address`,
        locate(ctx, frame),
      ),
    );
  };
  const slots = (c: ResolvedComponent, where: string, frame: number) => {
    for (const [name, v] of Object.entries(c.slots)) text(v, `${where} ("${name}")`, frame);
  };
  for (const s of ctx.plan.segments) {
    if (isClip(s)) {
      const seen = new Set<string>();
      for (const cue of s.cues) {
        const key = `${cue.kicker ?? ''}|${cue.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        text(cue.kicker, `caption kicker of ${s.id}`, s.from + cue.from);
        text(cue.text, `caption of ${s.id}`, s.from + cue.from);
      }
      for (const o of s.overlays) slots(o.component, `overlay of ${s.id}`, s.from + o.from);
      for (const p of s.panes ?? []) text(p.label, `page label of ${s.id}`, s.from);
    } else {
      slots(s.component, `${s.kind} ${s.id}`, s.from);
    }
  }
  return out;
}
