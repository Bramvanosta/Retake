/**
 * The pre-flight of an environment's pages (L5.8, R-FLD-33): before a take — sandbox or not — every page of the
 * environment must answer, so a page that moved to another port or a dev server that stopped fails the run up front,
 * naming the page and its URL, instead of a blank or an error page filmed at the first step that opens it.
 *
 * One GET per distinct URL (redirects not followed, the body never read), all at once, PAGE_PREFLIGHT_TIMEOUT_MS each.
 * Any HTTP answer counts — a sign-in redirect, a 404 at the root — except the gateway errors (502, 503, 504) a proxy
 * gives when the app behind it is down. Nothing is sent but the request: no cookie, no persona.
 */
import { errorMessage } from './errors.js';

/** How long a page has to answer (ms). */
export const PAGE_PREFLIGHT_TIMEOUT_MS = 5_000;
/** HTTP answers that say the app behind a proxy does not answer. */
const GATEWAY_ERRORS = new Set([502, 503, 504]);

export interface PageProbe {
  /** Environment page keys with this URL. */
  keys: string[];
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

/** GET each distinct page URL once (see the module comment). */
export async function probePages(pages: Record<string, string>, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PageProbe[]> {
  const byUrl = new Map<string, string[]>();
  for (const [key, url] of Object.entries(pages)) byUrl.set(url, [...(byUrl.get(url) ?? []), key]);
  return Promise.all(
    [...byUrl].map(async ([url, keys]): Promise<PageProbe> => {
      const t0 = Date.now();
      const timeout = AbortSignal.timeout(o.timeoutMs ?? PAGE_PREFLIGHT_TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout });
        await res.body?.cancel().catch(() => undefined);
        const ok = !GATEWAY_ERRORS.has(res.status);
        return { keys, url, ok, status: res.status, ...(ok ? {} : { error: `HTTP ${res.status}` }), ms: Date.now() - t0 };
      } catch (e) {
        if (o.signal?.aborted) throw e;
        const why = timeout.aborted ? `no answer within ${+((o.timeoutMs ?? PAGE_PREFLIGHT_TIMEOUT_MS) / 1000).toFixed(1)} s` : fetchFailure(e);
        return { keys, url, ok: false, error: why, ms: Date.now() - t0 };
      }
    }),
  );
}

/** Why a fetch got no answer, in words: its system error code (one per address tried: `localhost` has two), else its message. */
function fetchFailure(e: unknown): string {
  const cause = (e as { cause?: unknown }).cause as { code?: string; errors?: Array<{ code?: string }>; message?: string } | undefined;
  const code = cause?.code ?? cause?.errors?.find((x) => x?.code)?.code;
  if (code === 'ECONNREFUSED') return 'connection refused (nothing listens on that port)';
  if (code === 'ENOTFOUND') return 'unknown host';
  if (code) return code;
  return (cause?.message || errorMessage(e)) || 'no answer';
}

/** The refusal of a take whose pages do not all answer: each page and URL, and what to do. */
export function preflightRefusal(env: string, failed: readonly PageProbe[], o: { sandbox?: string } = {}): string {
  const list = failed.map((p) => `page ${p.keys.join(' / ')} (${p.url}): ${p.error ?? 'no answer'}`).join('; ');
  const fix = o.sandbox
    ? `start the sandbox (${o.sandbox}) and check its ports`
    : 'start the product (or check that its dev server still listens on that port: ports can move between two takes), then run again';
  return `environment ${env}: ${failed.length === 1 ? 'a page does not answer' : `${failed.length} pages do not answer`} — ${list}. Nothing was filmed: ${fix}`;
}
