import { describeTarget } from '@retake/core';
import type { AssertArgs, WaitForArgs } from '@retake/core';
import { StepError } from '../errors.js';
import { describePending, networkIdle } from '../network.js';
import { countMatches, poll } from '../resolve.js';
import type { StepContext } from '../runtime.js';
import { wallNow } from '../util.js';
import type { ActionResult } from './types.js';

/** Default wait_for timeout (seconds). */
export const DEFAULT_WAIT_FOR_S = 15;
/** Assertions re-check for this long before failing unless the step sets `timeout`. */
const ASSERT_GRACE_MS = 2000;

function urlMatches(url: string, pattern: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) return new RegExp(m[1], m[2]).test(url);
  return url.includes(pattern);
}

/** Descriptions of the conditions that are NOT met right now. */
async function unmet(ctx: StepContext, c: WaitForArgs & AssertArgs): Promise<string[]> {
  const { kit, page } = ctx.rt;
  const out: string[] = [];
  if (c.text !== undefined && !(await kit.hasText(c.text))) out.push(`text ${JSON.stringify(c.text)} is not visible`);
  if (c.not_text !== undefined && (await kit.hasText(c.not_text))) out.push(`text ${JSON.stringify(c.not_text)} is still visible`);
  if (c.target !== undefined && (await countMatches(ctx, c.target)) === 0) out.push(`${describeTarget(c.target)} is not visible`);
  if (c.gone !== undefined && (await countMatches(ctx, c.gone)) > 0) out.push(`${describeTarget(c.gone)} is still visible`);
  if (c.url !== undefined && !urlMatches(page.url(), c.url)) out.push(`URL ${page.url()} does not match ${c.url}`);
  if (c.title !== undefined) {
    const title = await page.title();
    if (!title.toLowerCase().includes(c.title.toLowerCase())) out.push(`title ${JSON.stringify(title)} does not contain ${JSON.stringify(c.title)}`);
  }
  if (c.count !== undefined) {
    const n = await countMatches(ctx, c.count.target);
    if (n !== c.count.equals) out.push(`${describeTarget(c.count.target)} matches ${n} visible elements, expected ${c.count.equals}`);
  }
  return out;
}

export async function wait(ctx: StepContext, args: { seconds: number }): Promise<ActionResult> {
  await ctx.rt.pause(args.seconds);
  return {};
}

export async function hold(ctx: StepContext, args: { seconds: number }): Promise<ActionResult> {
  await ctx.rt.pause(args.seconds);
  return { hold: true };
}

export async function waitFor(ctx: StepContext, args: WaitForArgs): Promise<ActionResult> {
  const timeoutMs = (args.timeout ?? ctx.step.timeout ?? ctx.rt.defaultTimeoutS ?? DEFAULT_WAIT_FOR_S) * 1000;
  const deadline = wallNow() + timeoutMs;
  if (args.network_idle) {
    // Re-armed on every call (network.ts): Playwright's networkidle fires once per document, then never waits again.
    const idle = await networkIdle(ctx.rt.page, { timeoutMs, signal: ctx.rt.signal });
    if (!idle.idle) throw new StepError(`wait_for: the network did not become idle within ${(timeoutMs / 1000).toFixed(1)} s (${describePending(idle.pending)})`);
  }
  let last: string[] = [];
  const ok = await poll(
    ctx,
    async () => {
      last = await unmet(ctx, args);
      return last.length === 0;
    },
    Math.max(0, deadline - wallNow()),
  );
  if (!ok) throw new StepError(`wait_for timed out after ${(timeoutMs / 1000).toFixed(1)} s: ${last.join('; ')}`);
  return { data: { waited_ms: Math.round(timeoutMs - (deadline - wallNow())) } };
}

export async function assert(ctx: StepContext, args: AssertArgs): Promise<ActionResult> {
  const timeoutMs = ctx.step.timeout !== undefined ? ctx.step.timeout * 1000 : ASSERT_GRACE_MS;
  let last: string[] = [];
  const ok = await poll(
    ctx,
    async () => {
      last = await unmet(ctx, args);
      return last.length === 0;
    },
    timeoutMs,
  );
  if (!ok) throw new StepError(`assert failed: ${last.join('; ')}`);
  return {};
}
