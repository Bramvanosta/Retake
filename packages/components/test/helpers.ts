import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ThemeTokens } from '@retake/components';

export async function tempDir(prefix = 'retake-components-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/** A small valid card manifest; `extra` lines are appended (YAML). */
export function cardManifest(id = 'acme/title-card', extra = ''): string {
  return [
    `id: ${id}`,
    'version: 1.0.0',
    'kind: card',
    'name: Title card',
    'description: A title on the theme background.',
    'slots:',
    '  title: {type: text, required: true, max_chars: 60}',
    '  kicker: {type: text}',
    'params:',
    '  type: object',
    '  properties:',
    '    align: {type: string, enum: [center, left], default: center}',
    '    size: {type: number, minimum: 20, maximum: 120, default: 84}',
    'duration: {default: 2.5, min: 1, max: 10}',
    'preview:',
    '  slots: {title: Hello}',
    extra,
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';
}

/** A minimal valid implementation. */
export const CARD_TSX = `import { useCurrentFrame } from 'remotion';
import { Background, FitText, fadeIn } from '@retake/components/kit';
import type { ComponentProps } from '@retake/components/kit';

export default function TitleCard({ theme, slots, unit, width, fps }: ComponentProps<{ align: string; size: number }>) {
  const frame = useCurrentFrame();
  return (
    <Background theme={theme}>
      <div style={{ opacity: fadeIn(frame, fps) }}>
        <FitText text={slots.title ?? ''} width={width * 0.8} maxFontSize={84 * unit} fontFamily={theme.fonts.display} color={theme.colors.text} />
      </div>
    </Background>
  );
}
`;

/** Theme tokens of a light editorial-like theme and a dark one (fictional). */
export const LIGHT: ThemeTokens = {
  name: 'light',
  colors: { accent: '#8a2332', text: '#1f1413', muted: '#6b605d', paper: '#f3eee8' },
  background: { type: 'radial', from: '#f8f4ef', to: '#ebe4dc' },
  fonts: { display: 'ds-light-display', body: 'ds-light-body' },
  brand: { name: 'Atelier', url: 'example.com' },
  wordmark: { text: 'Atelier' },
  cursor: { ripple_color: 'rgba(138, 35, 50, 0.45)' },
  style_bias: 'real',
  captions: {
    kicker: { font: 'ds-light-body', size: 15, weight: 600, uppercase: true, color: '#8a2332', letter_spacing: 0.14 },
    line: { font: 'ds-light-display', size: 35, color: '#1f1413' },
  },
  brandmark: { position: 'bottom-right', size: 30 },
  motion: { zoom_ease: [0.45, 0, 0.2, 1] },
};

export const DARK: ThemeTokens = {
  name: 'dark',
  colors: { accent: '#ff5c38', text: '#f5f6fa', muted: '#9ea3b5', paper: '#14161f' },
  background: { type: 'linear', from: '#1b1e2b', to: '#0d0f16' },
  fonts: { display: 'ds-dark-display', body: 'ds-dark-body' },
  brand: { name: 'Pulse', url: 'example.org' },
  logo: { url: 'http://assets.local/logo.svg' },
  wordmark: { url: 'http://assets.local/wordmark.svg', text: 'Pulse' },
  cursor: { ripple_color: 'rgba(255, 92, 56, 0.5)' },
  style_bias: 'motion',
  brandmark: { position: 'top-right', size: 24, opacity: 0.6 },
  motion: { zoom_ease: [0.2, 0, 0, 1] },
};
