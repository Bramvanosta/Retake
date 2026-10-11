import type { ReactNode } from 'react';
import { Background, darkLight } from '@demo-studio/components/kit';
import type { ComponentProps } from '@demo-studio/components/kit';

/** The capture edge to edge (the theme background shows only where a capture of another aspect leaves room). */
export default function LayoutRaw({ theme, screen }: ComponentProps) {
  return (
    <Background theme={theme}>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {screen ? (screen as ReactNode) : <div style={{ position: 'absolute', inset: 0, background: darkLight(theme).light }} />}
      </div>
    </Background>
  );
}
