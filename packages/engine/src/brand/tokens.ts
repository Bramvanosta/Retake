/**
 * A theme draft from a design-token file (R-FLD-47: template_from_tokens / `retake theme from-tokens`): the file read
 * with the brand-file rules (files.ts readBrandFile, kind `tokens`: a workspace file outside hidden, components and
 * agent-writable folders through MCP; `.json` / `.tokens`, ≤ 1 MB), its colours and font families parsed (core
 * brand-tokens.ts), a role proposed for each theme colour (names first, then colour) — or the token a `map` names — and
 * the draft brand input for template_create_from_brand with the template.yaml it would make. Nothing is written.
 *
 * Token names and font families are the file's text: they come back under `untrusted` only (the colours list and the
 * roles name a token by its index), and so do the nearest names of a `map` entry that names no colour token.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { zNewThemeName, zThemeName } from '@retake/core/ids';
import { TEMPLATE_FILE, TOKEN_ROLES, TokenFileError, brandFileRefSchema, contrast, nearestNames, parseTokenFile, proposeRoles } from '@retake/core/theme';
import type { LoadedTemplate, ProposedRole, TemplateFile, TokenFile, TokenRole } from '@retake/core/theme';
import { parseYaml } from '@retake/core/base';
import { stampOf } from '../clock.js';
import type { Clock } from '../clock.js';
import { EngineError } from '../errors.js';
import { componentCalls } from '../registries/component-calls.js';
import type { OpenedWorkspace } from '../workspace.js';
import { readBrandFile } from './files.js';
import type { BrandTrust } from './files.js';

const tokenName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/, 'a token name as the file writes it (printable)');

export const TokensInputSchema = z.strictObject({
  tokens: brandFileRefSchema.describe('The design-token file, relative to the workspace root (e.g. brand/tokens.json): a list format or DTCG (W3C) JSON, .json or .tokens, at most 1 MB.'),
  map: z
    .strictObject(Object.fromEntries(TOKEN_ROLES.map((r) => [r, tokenName.optional()])) as Record<TokenRole, z.ZodOptional<typeof tokenName>>)
    .optional()
    .describe('Role → token name, exactly as the file names it (e.g. {accent: "color.brand.primary"}): overrides the proposal for that role.'),
  base: zThemeName('a theme name').optional().describe('Base theme of the draft (default: motion for a dark paper, else editorial).'),
  name: zNewThemeName('a new theme name: lower-case letters, digits and "-"').optional().describe("The draft's theme name (default from the file's name)."),
});

/** The author's own input (`retake theme from-tokens`): the file may be any local path. */
export const AuthorTokensInputSchema = TokensInputSchema.extend({ tokens: z.string().min(1).max(4096) });

export interface TokensDraft {
  file: string;
  format: TokenFile['format'];
  counts: { tokens: number; colours: number; families: number; skipped_alpha: number; skipped_unsupported: number; skipped_unresolved: number };
  /** The colours by index (their names are under untrusted.colours, index for index). */
  colours: Array<{ index: number; hex: string }>;
  /** The role of each theme colour: the token's index and hex, why (its name, its colour, the map), its contrast with the paper. */
  roles: Partial<Record<TokenRole, ProposedRole & { contrast_on_paper?: number }>>;
  /** What derivePalette makes of the roles (every check and change) — what template_create_from_brand would report. */
  palette: { tone: 'light' | 'dark'; colors: Record<string, string>; checks: Array<{ check: string; ratio: number; min: number; ok: boolean }> } | null;
  draft: { base: string; brand_input: Record<string, unknown>; template_yaml: string } | null;
  notes: string[];
  untrusted: { colours: Array<{ index: number; name: string }>; families: Array<{ index: number; name: string; family: string }> };
}

function slugOf(file: string): string {
  const s = basename(file, extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return /^[a-z0-9]/.test(s) && !['default', 'editorial', 'motion', 'tokens', 'design-tokens'].includes(s) ? s : 'brand';
}

/** The draft of a token file (see the module comment). EngineError invalid: a refused file, a `map` naming no colour token. */
export async function tokensDraft(ws: OpenedWorkspace, raw: unknown, o: { trust: BrandTrust; clock: Clock; cwd?: string }): Promise<TokensDraft> {
  const parsedInput = (o.trust === 'mcp' ? TokensInputSchema : AuthorTokensInputSchema).safeParse(raw);
  if (!parsedInput.success) throw new EngineError('invalid', `invalid input: ${parsedInput.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ')}`);
  const input = parsedInput.data;
  const f = await readBrandFile(ws, input.tokens, 'tokens', { trust: o.trust, ...(o.cwd ? { cwd: o.cwd } : {}) });
  let parsed: TokenFile;
  try {
    parsed = parseTokenFile(new TextDecoder('utf-8', { fatal: true }).decode(f.bytes));
  } catch (e) {
    if (e instanceof TokenFileError) throw new EngineError('invalid', `token file ${input.tokens}: ${e.message}`);
    if (e instanceof TypeError) throw new EngineError('invalid', `token file ${input.tokens}: not UTF-8 text`);
    throw e;
  }
  const notes: string[] = [];
  const roles: TokensDraft['roles'] = proposeRoles(parsed.colours, notes);
  for (const role of TOKEN_ROLES) {
    const want = input.map?.[role];
    if (want === undefined) continue;
    const c = parsed.colours.find((x) => x.name === want);
    if (!c) {
      const named = parsed.colours.map((x) => x.name);
      throw new EngineError('invalid', `map.${role} names no colour token of the file (its ${parsed.colours.length} colour tokens and the nearest names are in details.untrusted)`, {
        details: { untrusted: { map: { [role]: want }, near: nearestNames(want, named) } },
      });
    }
    // A token mapped to a role leaves any other role it had.
    for (const r of TOKEN_ROLES) if (roles[r]?.index === c.index && r !== role) delete roles[r];
    roles[role] = { index: c.index, hex: c.hex, why: 'map' };
  }
  const paper = roles.paper?.hex;
  if (paper) for (const r of TOKEN_ROLES) if (r !== 'paper' && roles[r]) roles[r] = { ...roles[r]!, contrast_on_paper: Math.round(contrast(roles[r]!.hex, paper) * 100) / 100 };
  if (!roles.accent) notes.push('no accent found (by name or by a saturated colour with 3:1 on the paper): give map.accent, or the accent yourself');
  if (parsed.skipped.alpha) notes.push(`${parsed.skipped.alpha} translucent colours skipped (a theme colour is opaque)`);
  if (parsed.skipped.unsupported) notes.push(`${parsed.skipped.unsupported} colour values not read (only #hex and DTCG srgb components)`);
  if (parsed.skipped.unresolved) notes.push(`${parsed.skipped.unresolved} aliases name no token of the file`);
  if (parsed.families.length) notes.push(`${parsed.families.length} font families named (untrusted.families): font files come from brand/, or open-licence fonts by fontsource id through font_fetch with the user's approval`);

  let palette: TokensDraft['palette'] = null;
  let draft: TokensDraft['draft'] = null;
  if (roles.accent) {
    const lib = await componentCalls();
    const colors = Object.fromEntries((['accent', 'text', 'paper', 'muted', 'dark'] as const).filter((r) => roles[r]).map((r) => [r, roles[r]!.hex])) as { accent: string } & Record<string, string>;
    const tone = lib.paletteTone(colors.paper ?? '#ffffff');
    const baseName = input.base ?? (tone === 'dark' ? 'motion' : 'editorial');
    const p = lib.derivePalette({ ...colors, adjust: true, tone });
    palette = { tone, colors: { ...p.colors }, checks: p.checks.map((c) => ({ check: c.check, ratio: c.ratio, min: c.min, ok: c.ok })) };
    let base: LoadedTemplate | undefined;
    try {
      base = await ws.reads.loadTemplate(baseName, ws.root, { files: ws.reads.fileFacts(ws.policy) });
    } catch {
      notes.push(`base theme ${baseName} could not be loaded: no template.yaml drafted`);
    }
    const name = input.name ?? slugOf(input.tokens);
    const brand_input = { name, base: baseName, colors, logo: '<the logo file, e.g. brand/logo.svg>' };
    if (base) {
      const baseFile = parseYaml(await readFile(join(base.dir, TEMPLATE_FILE), 'utf8')).value as TemplateFile;
      const generated = lib.generateThemeFile({
        base: baseFile,
        baseName,
        name,
        palette: p,
        logo: 'logo.svg',
        fonts: { display: `fonts/${basename(base.assets.display)}`, body: base.assets.body.map((b) => `fonts/${basename(b)}`) },
        date: stampOf(o.clock).slice(0, 10),
      });
      draft = { base: baseName, brand_input, template_yaml: generated.yaml };
    } else draft = { base: baseName, brand_input, template_yaml: '' };
  }
  return {
    file: input.tokens,
    format: parsed.format,
    counts: {
      tokens: parsed.tokens,
      colours: parsed.colours.length,
      families: parsed.families.length,
      skipped_alpha: parsed.skipped.alpha,
      skipped_unsupported: parsed.skipped.unsupported,
      skipped_unresolved: parsed.skipped.unresolved,
    },
    colours: parsed.colours.map((c) => ({ index: c.index, hex: c.hex })),
    roles,
    palette,
    draft,
    notes,
    untrusted: { colours: parsed.colours.map((c) => ({ index: c.index, name: c.name })), families: parsed.families.map((x) => ({ ...x })) },
  };
}
