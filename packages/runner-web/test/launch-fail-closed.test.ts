/**
 * The runner's browser checks fail closed (src/launch.ts): under the agent policy, a launch whose browser
 * playwright-core does not name (its registry moved or unreadable — as on the 1.65 bump, where the old private module
 * threw) is refused rather than started unchecked; and after a launch, a browser that does not report its command line
 * (no browser to ask, CDP refusing or failing) is closed and refused. No browser is launched here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { PERSON_POLICY, workPolicyFrom } from '@retake/core';

const registry = vi.hoisted(() => ({ answer: null as string | null }));
vi.mock('@retake/core/io', async (actual) => ({ ...(await actual<typeof import('@retake/core/io')>()), playwrightBrowser: () => registry.answer }));

const { RunnerError } = await import('../src/errors.js');
const { launchTarget, refuseUnsandboxed } = await import('../src/launch.js');

const AGENT = workPolicyFrom(['/ws-of-an-agent'], PERSON_POLICY.ffmpeg, PERSON_POLICY.render);

describe.skipIf(!!process.env.RETAKE_CHROMIUM)('launchTarget under the agent policy: a browser playwright-core does not name is not started', () => {
  it('refused for the channel and for the headless shell; a command a person types still launches the channel', () => {
    registry.answer = null;
    expect(() => launchTarget({}, { policy: AGENT })).toThrow(RunnerError);
    expect(() => launchTarget({}, { policy: AGENT })).toThrow(/^Chromium was not launched: playwright-core does not say which browser it would start for channel chromium, so it cannot be checked/);
    expect(() => launchTarget({ channel: 'headless-shell' }, { policy: AGENT })).toThrow(/for its headless shell, so it cannot be checked/);
    expect(launchTarget({}, { policy: PERSON_POLICY })).toEqual({ executablePath: undefined, channel: 'chromium' });
  });

  it('a browser it names outside the workspace launches the channel; one inside is refused', () => {
    registry.answer = '/opt/browsers/chromium';
    expect(launchTarget({}, { policy: AGENT })).toEqual({ executablePath: undefined, channel: 'chromium' });
    registry.answer = '/ws-of-an-agent/browsers/chromium';
    expect(() => launchTarget({}, { policy: AGENT })).toThrow(/lies inside the workspace/);
  });
});

/** A browser whose CDP session answers Browser.getBrowserCommandLine with `reply` (a function that may throw). */
function fakeBrowser(reply: () => unknown, o: { noSession?: boolean } = {}): Browser {
  return {
    newBrowserCDPSession: async () => {
      if (o.noSession) throw new Error('Target closed');
      return { send: async () => reply(), detach: async () => undefined };
    },
  } as unknown as Browser;
}

describe('refuseUnsandboxed: a browser that does not report its command line is refused', () => {
  const REFUSED = /^The capture browser was refused: it does not report its command line, so its sandbox and site isolation cannot be checked/;

  it.each([
    ['no browser to ask (a context without one)', null],
    ['CDP refuses the command line (no --enable-automation)', fakeBrowser(() => Promise.reject(new Error('Command line not returned because --enable-automation not set')))],
    ['no CDP session', fakeBrowser(() => ({ arguments: [] }), { noSession: true })],
  ])('%s: closed, then refused', async (_, browser) => {
    const close = vi.fn(async () => undefined);
    await expect(refuseUnsandboxed(browser, close, 'The capture browser')).rejects.toThrow(REFUSED);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a command line without a sandbox-off switch is kept; one with --no-sandbox is refused', async () => {
    const close = vi.fn(async () => undefined);
    await refuseUnsandboxed(
      fakeBrowser(() => ({ arguments: ['/x/chrome', '--enable-automation'] })),
      close,
    );
    expect(close).not.toHaveBeenCalled();
    await expect(
      refuseUnsandboxed(
        fakeBrowser(() => ({ arguments: ['/x/chrome', '--no-sandbox'] })),
        close,
      ),
    ).rejects.toThrow(/runs with --no-sandbox on its command line/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
