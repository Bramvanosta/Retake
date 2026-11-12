/**
 * The Studio's theme ops (L4.7, R-UI-07 / R-DEC-04; critique B1, B7, B9–B11, B14, B15). Not MCP tools: MCP never edits a
 * theme (template_list's wording stays true); Claude makes new ones with template_create_from_brand.
 *
 * theme_list, theme_view, theme_edit, theme_copy, theme_create, brand_files and site_list are the engine's operations
 * (L7.17: packages/engine/src/operations/themes.ts, with theme_edit's caller rule and the writes' one-at-a-time key);
 * this file keeps the theme editor's live preview, which needs this server's player origin and leases, and names the
 * answer types the app reads.
 *
 * - `theme_preview {project, theme, target, draft?, lease}`: the theme editor's live preview — the editor's
 *   ComponentPreviewSpec (motion mode) of the theme's intro, its layout with its caption over the sample screen (`clip`),
 *   its outro, or one component in the theme, built by the engine (buildThemePreview) with every file served by the
 *   player origin under the project's capability (the theme's fonts / logo, the sample screens), and published here as
 *   a `component-preview` (the `forbid` scan of every string); `draft` colours apply in memory, never written. A
 *   workspace component the spec renders is held out of the frame's bundle until the person allows it
 *   (`preview_held`, the timeline's Allow card: preview_allow). A theme whose intro / outro is its own video, image or
 *   Lottie (B10) is not previewed here — said. The page's lease is one of the timeline's (timeline_leave ends it).
 */
import { homedir } from 'node:os';
import { z } from 'zod';
import { EngineError, buildThemePreview, firstErrorLine, pathFree } from '@retake/engine';
import type { Engine } from '@retake/engine';
import { THEME_ARGS, defineTool } from '@retake/engine/contract';
import type { PreviewLeases, PreviewHeld } from './preview-leases.js';
import type { PlayerServer } from './player.js';
import type { PreviewAllowList } from './preview-allow.js';

/** The answers of the engine's theme operations the app reads (L7.17: defined with them). */
export type { SiteListAnswer, ThemeListAnswer } from '@retake/engine/contract';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const { project, theme, componentId, hex, background } = THEME_ARGS;
const lease = z.string().regex(/^[A-Za-z0-9_-]{16,43}$/, 'a random lease id of the page (16 to 43 base64url characters)');

const draftColors = z.strictObject({ accent: hex.optional(), text: hex.optional(), muted: hex.optional(), paper: hex.optional(), dark: hex.optional() });
const PreviewInput = z.strictObject({
  project,
  theme,
  target: z
    .union([z.enum(['intro', 'clip', 'outro']), z.strictObject({ component: componentId })])
    .describe("The theme's intro, its layout with its caption over the sample screen (clip), its outro, or one component in the theme."),
  draft: z
    .strictObject({ colors: draftColors.optional(), background: background.optional() })
    .optional()
    .describe('Colours being changed (in memory only, never written): the page sends at most 5 a second.'),
  // Required (review A N2): a scope no lease holds would lose its URLs when the last timeline page leaves.
  lease: lease.describe("The page's lease (timeline_leave ends it): the project's preview URLs are revoked once no page holds one."),
});

/**
 * What theme_preview answers: the preview's capability URLs, its length, and `frame` (the moment a still of it shows:
 * where to load / settle) — or why it shows nothing (`not_previewed`, `preview_error`).
 */
export type ThemePreviewAnswer = { theme: string; target: { kind: string; component?: string } } & PreviewHeld &
  ({ frame_url: string; plan_url: string; frames: number; fps: number; frame: number } | { not_previewed: string } | { preview_error: string });

export interface ThemeOpsOptions {
  /** The player origin (theme_preview). */
  player?: () => PlayerServer;
  /** Folders no string of a preview may name (the workspace, the home folder). */
  forbid?: () => readonly string[];
  /** The workspace components the person allowed in the preview this session. */
  allow?: PreviewAllowList;
  /** The preview pages' leases (shared with timeline_view / timeline_leave). */
  leases?: PreviewLeases;
}

export function themeOps(o: ThemeOpsOptions = {}) {
  const preview = defineTool({
    name: 'theme_preview',
    title: "A theme's live preview",
    description: "The theme editor's live preview of the theme's intro, its layout with its caption (clip), its outro or one component in the theme — with colours being changed applied in memory — as the preview frame's capability URLs.",
    input: PreviewInput,
    annotations: READ,
    async run(a, { engine }) {
      if (!o.player) throw new EngineError('unavailable', 'this server has no preview origin');
      const r = await themePreview(engine, a, o);
      const head = `${a.theme}: ${'component' in r.target && r.target.component ? r.target.component : r.target.kind}`;
      const summary = 'frame_url' in r ? `${head}, ${r.frames} frames` : 'not_previewed' in r ? `${head}: not previewed (${r.not_previewed})` : `${head}: no preview`;
      return { summary, data: r };
    },
  });

  return [preview] as const;
}

/** The workspace components among `ids` that the person has not allowed in the preview (empty without an allow-list). */
async function heldOf(registry: Parameters<typeof import('../player/bundle-player.js')['workspaceComponents']>[0], ids: readonly string[], allow: PreviewAllowList | undefined): Promise<NonNullable<PreviewHeld['preview_held']>> {
  if (!allow) return [];
  const used = new Set(ids);
  const { workspaceComponents } = await import('../player/bundle-player.js');
  return (await workspaceComponents(registry)).filter((c) => used.has(c.id) && !allow.has(c.id, c.hash));
}

/** theme_preview (see the header): the engine builds the spec, this server serves and publishes it. */
export async function themePreview(engine: Engine, a: z.infer<typeof PreviewInput>, o: ThemeOpsOptions): Promise<ThemePreviewAnswer> {
  const ws = engine.workspace;
  const scope = a.project;
  let player: PlayerServer | undefined;
  const r = await buildThemePreview(ws, a, {
    start: () => {
      const p = o.player!();
      player = p;
      o.leases?.prune();
      o.leases?.hold(scope, a.lease);
      return (file, within) => p.register(file, within, scope);
    },
  });
  if ('answer' in r) return r.answer;
  const { base, spec, components, registry, folders } = r.built;
  const held = await heldOf(registry, components, o.allow);
  const heldPart: PreviewHeld = held.length ? { preview_held: held } : {};
  try {
    const forbid = [...(o.forbid?.() ?? [ws.root, homedir()]), ...folders];
    const pub = await player!.publishPreview(spec, { forbid, scope });
    return { ...base, ...heldPart, frame_url: pub.frame_url, plan_url: pub.plan_url, frames: spec.durationInFrames, fps: spec.fps, frame: spec.frame };
  } catch (e) {
    return { ...base, ...heldPart, preview_error: firstErrorLine(pathFree(e instanceof Error ? e.message : String(e), ws.root)) };
  }
}

/** The theme ops' names. */
export const THEME_OPS = ['theme_list', 'theme_view', 'theme_edit', 'theme_copy', 'theme_create', 'brand_files', 'site_list', 'theme_preview'] as const;
