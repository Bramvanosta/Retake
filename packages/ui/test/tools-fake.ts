/**
 * A fake installer's world for the Studio's Tools tests (tools-ops.ts, the Set-up item, the Tools page): the three
 * small fixture Tools (test-support toolFixtures), a fake app bundle naming them (the engine's `tools.bundle`), and a
 * download served from memory whose behaviour a test switches while it runs — `hold` (the bodies wait: a download
 * under way), `wrong` (the browser's bytes are another file: a digest mismatch), `offline` (every request fails: no
 * connection), `slow` (one chunk at a time, a pause between). Never the network.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleInfo } from '@retake/core/io';
import type { ToolsFetch } from '@retake/engine/tools';
import { fakeToolsBundle, toolFixtures } from '@retake/test-support/tools';
import type { FixtureTools } from '@retake/test-support/tools';

export interface FakeNet {
  /** Bodies wait until `release()`. */
  hold: boolean;
  /** The browser's archive is served with other bytes (same size). */
  wrong: boolean;
  /** Every request fails (no connection). */
  offline: boolean;
  /** The URLs asked, in order. */
  calls: string[];
  release(): void;
  fetch: ToolsFetch;
}

export function fakeNet(fx: FixtureTools): FakeNet {
  let open: () => void = () => undefined;
  let gate = Promise.resolve();
  const net: FakeNet = {
    hold: false,
    wrong: false,
    offline: false,
    calls: [],
    release: () => open(),
    fetch: async (url, init) => {
      net.calls.push(url);
      if (net.offline) throw new TypeError('fetch failed: getaddrinfo ENOTFOUND (a test)');
      const t = fx.tools.find((x) => x.entry.url === url);
      if (!t) return new Response('not found', { status: 404 });
      let body = t.bytes;
      if (net.wrong && t.entry.id === 'browser') body = Buffer.alloc(t.bytes.length, 7);
      const m = /^bytes=(\d+)-$/.exec(init.headers.range ?? '');
      const from = m ? Number(m[1]) : 0;
      const part = body.subarray(from);
      const held = net.hold ? gate : null;
      let pulls = 0;
      const half = Math.max(1, Math.floor(part.length / 2));
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          pulls++;
          if (init.signal?.aborted) return c.error(new Error('aborted'));
          if (pulls === 1) return c.enqueue(new Uint8Array(part.subarray(0, half)));
          if (pulls === 2) {
            // Held until released, or until the download is stopped (a pause aborts it).
            if (held) await Promise.race([held, new Promise<void>((r) => init.signal?.addEventListener('abort', () => r(), { once: true }))]);
            if (init.signal?.aborted) return c.error(new Error('aborted'));
            return c.enqueue(new Uint8Array(part.subarray(half)));
          }
          c.close();
        },
      });
      const headers: Record<string, string> = { 'content-length': String(part.length) };
      if (from > 0) headers['content-range'] = `bytes ${from}-${body.length - 1}/${body.length}`;
      return new Response(stream, { status: from > 0 ? 206 : 200, headers });
    },
  };
  Object.defineProperty(net, 'hold', {
    get: () => holding,
    set: (v: boolean) => {
      holding = v;
      if (v) gate = new Promise((r) => (open = r));
      else open();
    },
  });
  let holding = false;
  return net;
}

/** The fixture Tools under `base`, a fake bundle naming them and a fake download over them. */
export async function fakeTools(
  base: string,
): Promise<{
  fx: FixtureTools;
  bundle: BundleInfo;
  net: FakeNet;
  engineTools: { bundle: BundleInfo; fetch: ToolsFetch; retry: { firstMs: number; capMs: number; attempts: number; maxMs: number }; sleep: () => Promise<void> };
}> {
  const fx = await toolFixtures(join(base, 'tool-fixtures'));
  const bundle = fakeToolsBundle(join(base, 'tools-app'), fx.entries);
  const net = fakeNet(fx);
  return { fx, bundle, net, engineTools: { bundle, fetch: (u, i) => net.fetch(u, i), retry: { firstMs: 1, capMs: 1, attempts: 2, maxMs: 1000 }, sleep: async () => undefined } };
}

/** A fake installed app as the set-up reads it (launcher, Node.js, guard, engine entry, plugin) under `dir`. */
export function fakeSetupApp(dir: string): BundleInfo {
  const sealed = join(dir, 'Retake.app');
  const root = join(sealed, 'Contents', 'Resources');
  for (const d of ['bin', 'node/bin', 'engine/dist', 'plugin/.claude-plugin', 'plugin/skills/.claude-plugin']) mkdirSync(join(root, d), { recursive: true });
  for (const [f, text] of [
    ['bin/retake', '#!/bin/sh\n'],
    ['node/bin/node', '#!/bin/sh\n'],
    ['node/guard.cjs', ''],
    ['engine/dist/bin.js', ''],
    ['plugin/.claude-plugin/marketplace.json', '{}'],
    ['plugin/skills/.claude-plugin/plugin.json', '{}'],
  ] as const)
    writeFileSync(join(root, f), text);
  chmodSync(join(root, 'bin/retake'), 0o755);
  return {
    root,
    sealed,
    manifest: {} as BundleInfo['manifest'],
    paths: { node: join(root, 'node/bin/node'), engine: join(root, 'engine'), ffmpeg: null, templates: join(root, 'engine/templates'), plugin: join(root, 'plugin') },
  };
}
