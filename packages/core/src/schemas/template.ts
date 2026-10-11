import { z } from 'zod';
import type { Template, TextStyle } from '../types.js';
import { FrameStyleSchema, TransitionSchema, nonEmpty, positiveSeconds, seconds } from './primitives.js';

const FONT_RE = /\.(ttf|otf|woff2?)$/i;
const IMAGE_RE = /\.(svg|png|jpe?g|webp)$/i;

const fontFile = () =>
  z.string().regex(FONT_RE, { error: 'expected a font file (.ttf, .otf, .woff or .woff2) relative to the template dir' });
const imageFile = () =>
  z.string().regex(IMAGE_RE, { error: 'expected an image file (.svg, .png, .jpg or .webp) relative to the template dir' });

const colorsShape = {
  accent: nonEmpty().describe('Accent colour (CSS).'),
  text: nonEmpty().describe('Main text colour.'),
  muted: nonEmpty().describe('Secondary text colour.'),
  paper: nonEmpty().describe('Background / paper colour.'),
};

const textStyleShape = {
  font: z.enum(['display', 'body']),
  weight: z.number().int().min(100).max(1000).optional(),
  size: z.number().gt(0).describe('Font size in px at 1920×1080.'),
  uppercase: z.boolean().optional(),
  color: nonEmpty().describe('Colour key (accent/text/muted/paper) or CSS colour.').optional(),
  letter_spacing: z.number().optional(),
};

const TextStyleSchema = z.strictObject(textStyleShape) satisfies z.ZodType<TextStyle>;

const sections = {
  fonts: z.strictObject({
    display: fontFile().describe('Display font file.'),
    body: z.array(fontFile()).min(1).describe('Body font files (regular, semibold, bold…).'),
  }),
  background: z.strictObject({
    type: z.enum(['solid', 'radial', 'linear']),
    from: nonEmpty().optional(),
    to: nonEmpty().optional(),
    color: nonEmpty().optional(),
  }),
  frame: z.strictObject({
    style: FrameStyleSchema,
    width: z.number().int().gt(0).describe('Frame width in px at 1920×1080.'),
    radius: z.number().min(0),
    shadow: z.enum(['none', 'soft', 'strong']),
  }),
  intro: z.strictObject({
    duration: positiveSeconds(),
    layout: z.enum(['logo-kicker-title', 'kicker-title', 'logo-only']),
  }),
  outro: z.strictObject({
    duration: positiveSeconds(),
    layout: z.enum(['logo-wordmark-tagline-url', 'logo-tagline', 'logo-only']),
    url: z.string().optional(),
    tagline: z.string().optional(),
  }),
  interstitial: z.strictObject({
    style: z.enum(['dark-clock', 'paper', 'dark']),
    duration: positiveSeconds().optional(),
  }),
  transitions: z.strictObject({ between_scenes: TransitionSchema, duration: seconds() }),
  cursor: z.strictObject({
    style: z.enum(['arrow-dark', 'arrow-light', 'debug']),
    ripple_color: nonEmpty(),
    size: z.number().gt(0).optional(),
  }),
  motion: z.strictObject({
    default_zoom: z.union([z.literal('none'), z.number().min(1).max(3)]),
    max_zoom: z.number().min(1).max(3),
    zoom_ease: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('cubic-bezier [x1, y1, x2, y2].'),
  }),
  brandmark: z.strictObject({
    position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'none']),
    opacity: z.number().min(0).max(1).optional(),
    size: z.number().gt(0).optional(),
  }),
};

const styleBias = z.enum(['real', 'balanced', 'motion']).describe('How much motion design is added: real | balanced | motion.');

/** A complete template (after merging over DEFAULT_TEMPLATE). */
export const TemplateSchema = z.strictObject({
  name: nonEmpty().optional(),
  colors: z.object(colorsShape).catchall(z.string()),
  fonts: sections.fonts,
  logo: imageFile(),
  wordmark: imageFile().optional(),
  background: sections.background,
  frame: sections.frame,
  captions: z.strictObject({
    position: z.enum(['below', 'above', 'overlay', 'none']),
    kicker: TextStyleSchema,
    line: TextStyleSchema,
  }),
  intro: sections.intro,
  outro: sections.outro,
  interstitial: sections.interstitial,
  transitions: sections.transitions,
  cursor: sections.cursor,
  motion: sections.motion,
  style_bias: styleBias,
  brandmark: sections.brandmark.optional(),
}) satisfies z.ZodType<Template>;

/** templates/<name>/template.yaml: every section optional, merged over DEFAULT_TEMPLATE. */
export const TemplateFileSchema = z
  .strictObject({
    name: nonEmpty().optional(),
    colors: z.object(colorsShape).partial().catchall(z.string()).describe('Brand colours (extra keys allowed).').optional(),
    fonts: sections.fonts.partial().describe('Font files relative to the template dir.').optional(),
    logo: imageFile().describe('Logo file relative to the template dir.').optional(),
    wordmark: imageFile().describe('Wordmark image (outro).').optional(),
    background: sections.background.partial().optional(),
    frame: sections.frame.partial().optional(),
    captions: z
      .strictObject({
        position: z.enum(['below', 'above', 'overlay', 'none']).optional(),
        kicker: TextStyleSchema.partial().optional(),
        line: TextStyleSchema.partial().optional(),
      })
      .optional(),
    intro: sections.intro.partial().optional(),
    outro: sections.outro.partial().optional(),
    interstitial: sections.interstitial.partial().optional(),
    transitions: sections.transitions.partial().optional(),
    cursor: sections.cursor.partial().optional(),
    motion: sections.motion.partial().optional(),
    style_bias: styleBias.optional(),
    brandmark: sections.brandmark.partial().optional(),
  })
  .meta({
    id: 'Template',
    title: 'Demo Studio template',
    description: 'Brand & motion style (templates/<name>/template.yaml), merged over the default template.',
  });
