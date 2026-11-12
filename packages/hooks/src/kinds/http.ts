import { STATUS_CODES } from 'node:http';
import { resolvePersonas } from '@retake/core/environment';
import { httpWriteReason } from '@retake/core/hooks';
import { personaAuthOriginProblem, personaPageOrigins } from '@retake/core/scenario';
import type { HttpHookSpec } from '@retake/core/model';
import { checkHostAllowed, checkWriteHosts } from '../allow-list.js';
import { describeHttp } from '../describe.js';
import { HookError, HookSecurityError, errorMessage } from '../errors.js';
import { addSecret, redactText } from '../secrets.js';
import { checkTokens, hookTemplateContext, renderDeep, snapshotFor, snapshotTemplateContext } from '../template.js';
import { journalsRollback } from '../types.js';
import type { HookContext, HttpRequestSpec, RollbackAction, SavedHttpResponse } from '../types.js';
import { oneLine } from '../util.js';
import { ignoreRollback } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';
import type { ShownAction } from '../shown.js';

/** Per request, including reading the body. */
export const HTTP_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Method = NonNullable<HttpHookSpec['method']>;

interface HttpCall {
  method: Method;
  /** Normalised (percent-encoded) URL sent to fetch. */
  url: string;
  /** The URL as templated, for descriptions. */
  display: string;
  headers: Record<string, string>;
  body?: string;
  expect?: number | number[];
  /** `auth: {persona}`: the persona whose session is added when the request is sent (withPersona). */
  persona?: string;
}

const hasHeader = (h: Record<string, string>, name: string) => Object.keys(h).some((k) => k.toLowerCase() === name);

function dropHeaders(h: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !names.includes(k.toLowerCase())));
}

/** Validate an interpolated request and turn it into a fetch call. */
function toCall(spec: HttpRequestSpec, ctx: HookContext): HttpCall {
  const method = (spec.method ?? 'GET').toUpperCase() as Method;
  if (spec.json !== undefined && spec.body !== undefined) {
    throw new HookError('http hook: set either `json` or `body`, not both');
  }
  const headers = { ...(spec.headers ?? {}) };
  let body: string | undefined;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!hasHeader(headers, 'content-type')) headers['content-type'] = 'application/json';
  } else if (spec.body !== undefined) {
    body = spec.body;
  }
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new HookError(`http hook: a ${method} request cannot have a body; set method: POST (or PUT / PATCH)`);
  }
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    const page = Object.keys(ctx.env.pages)[0] ?? 'page';
    throw new HookError(`http hook: "${spec.url}" is not an absolute URL; start it with a page key such as {{${page}}}/path`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HookError(`http hook: unsupported protocol ${url.protocol} (use http or https)`);
  }
  const persona = spec.auth?.persona;
  if (persona !== undefined) {
    const set = Object.keys(headers).find((h) => ['authorization', 'cookie'].includes(h.toLowerCase()));
    if (set) throw new HookError(`http hook: \`auth: {persona: ${persona}}\` sets the ${set} header from the persona's session: remove one of the two`);
    // Only the names are read: `home` places the session files, which no name depends on (as core checks/scenario.ts).
    const names = resolvePersonas(ctx.project, ctx.env.name, { home: '/' }).map((p) => p.name);
    if (!names.includes(persona)) {
      throw new HookError(`http hook: persona "${persona}" is not declared for environment "${ctx.env.name}" (personas: ${names.join(', ') || 'none'})`);
    }
  }
  return { method, url: url.toString(), display: spec.url, headers, body, expect: spec.expect, ...(persona !== undefined ? { persona } : {}) };
}

/**
 * Trust `mcp` (core agent-trust personaAuthOriginProblem): an http hook acting as a persona is sent only to that
 * persona's own pages' origins — checked on the URL as rendered, when the hook is prepared (before any approval or
 * request) and again before the session is read.
 */
function personaOriginGuard(call: Pick<HttpCall, 'persona' | 'url'>, ctx: HookContext): void {
  if (call.persona === undefined || ctx.trust !== 'mcp') return;
  const persona = call.persona;
  const p = resolvePersonas(ctx.project, ctx.env.name, { home: '/' }).find((x) => x.name === persona);
  const problem = personaAuthOriginProblem(persona, call.url, personaPageOrigins(p?.pages ?? [], ctx.env.pages), ctx.via);
  if (problem) throw new HookSecurityError(`http hook: ${problem}`, 'mcp');
}

/**
 * The request as its persona sends it (`auth: {persona}`): the cookies its saved session holds for the URL and its
 * bearer token (a product signed in with Firebase Auth), both registered as secrets. Dropped like any credential when
 * a redirect leaves the origin (send).
 */
async function withPersona(call: HttpCall, ctx: HookContext): Promise<HttpCall> {
  const persona = call.persona;
  if (persona === undefined) return call;
  if (!ctx.personaAuth) {
    throw new HookError(`http hook: \`auth: {persona: ${persona}}\` needs the saved session of the persona, and none exists here (a sandbox seed runs before anyone signs in): sign in with the product's own API and {{accounts.${persona}.password}}`);
  }
  personaOriginGuard(call, ctx);
  const auth = await ctx.personaAuth(persona, call.url);
  if (!auth.authorization && !auth.cookie) {
    throw new HookError(
      `http hook: the session of persona ${persona} holds nothing to send to ${new URL(call.url).origin}: no cookie for this URL, and no Firebase Auth user in its pages — ` +
        `sign in with the product's own API and pass its token in \`headers\``,
    );
  }
  const headers = { ...call.headers };
  if (auth.authorization) {
    addSecret(ctx, auth.authorization);
    addSecret(ctx, auth.authorization.replace(/^\S+\s+/, ''));
    headers.authorization = auth.authorization;
  }
  if (auth.cookie) {
    for (const pair of auth.cookie.split('; ')) addSecret(ctx, pair.slice(pair.indexOf('=') + 1));
    headers.cookie = auth.cookie;
  }
  return { ...call, headers };
}

function expected(expect: number | number[] | undefined, status: number): boolean {
  if (expect === undefined) return status >= 200 && status < 300;
  return Array.isArray(expect) ? expect.includes(status) : expect === status;
}

function expectLabel(expect: number | number[] | undefined): string {
  if (expect === undefined) return '2xx';
  return Array.isArray(expect) ? expect.join(' or ') : String(expect);
}

export function statusLine(status: number): string {
  const text = STATUS_CODES[status];
  return text ? `${status} ${text}` : String(status);
}

function fetchFailure(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return `timed out after ${HTTP_TIMEOUT_MS / 1000} s`;
  }
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.message ?? cause?.code;
  return detail ? `${errorMessage(e)} (${detail})` : errorMessage(e);
}

async function readResponse(res: Response): Promise<SavedHttpResponse> {
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let json: unknown;
  const type = res.headers.get('content-type') ?? '';
  const looksJson = /json/i.test(type) || /^\s*[[{]/.test(body);
  if (looksJson && body.trim()) {
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status, headers, body, json };
}

/**
 * fetch with the allow-list checked before every hop: redirects are followed manually (at most 5),
 * credentials are dropped when the origin changes, 303 (and 301/302 after POST) switch to GET.
 */
async function send(call: HttpCall, ctx: HookContext): Promise<SavedHttpResponse> {
  let { method, url, headers, body } = call;
  for (let hop = 0; ; hop++) {
    checkHostAllowed(url, ctx.project);
    // Every hop that writes (a redirect, a rollback replayed later): never to another read-only environment's host.
    const writes = httpWriteReason({ method, body });
    if (writes) checkWriteHosts([new URL(url).hostname], writes, ctx.access);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch (e) {
      throw new HookError(`${method} ${url} failed: ${fetchFailure(e)}`);
    }
    const location = res.headers.get('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location || expected(call.expect, res.status)) {
      try {
        return await readResponse(res);
      } catch (e) {
        throw new HookError(`${method} ${url}: reading the response failed: ${fetchFailure(e)}`);
      }
    }
    await res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new HookError(`${call.method} ${call.url}: more than ${MAX_REDIRECTS} redirects`);
    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) headers = dropHeaders(headers, ['authorization', 'cookie', 'proxy-authorization']);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'HEAD') method = 'GET';
      body = undefined;
      headers = dropHeaders(headers, ['content-type', 'content-length']);
    }
    url = next.toString();
  }
}

async function sendChecked(plain: HttpCall, ctx: HookContext): Promise<SavedHttpResponse> {
  const call = await withPersona(plain, ctx);
  const res = await send(call, ctx);
  if (!expected(call.expect, res.status)) {
    const snippet = res.body.trim() ? `: ${oneLine(res.body, 300)}` : '';
    throw new HookError(`${call.method} ${call.url}: expected ${expectLabel(call.expect)}, got ${statusLine(res.status)}${snippet}`);
  }
  return res;
}

async function rollbackAction(
  ctx: HookContext,
  template: HttpRequestSpec,
  response: SavedHttpResponse,
): Promise<RollbackAction> {
  const tpl = await hookTemplateContext(ctx, template, { response });
  const call = toCall(renderDeep(template, tpl), ctx);
  checkHostAllowed(call.url, ctx.project);
  return {
    kind: 'http',
    request: template,
    data: snapshotFor(ctx, template, tpl),
    description: redactText(ctx, describeHttp(call.method, call.display) + asPersona(call)),
  };
}

const asPersona = (call: Pick<HttpCall, 'persona'>): string => (call.persona !== undefined ? ` as ${call.persona}` : '');

const RESPONSE_TOKEN = /\{\{\s*(response(?:\.[^}]*)?)\s*\}\}/g;

/** A rollback request with its `{{response.…}}` tokens written `<response.…>` (their values are known once the hook ran). */
function markResponse<T>(value: T): T {
  if (typeof value === 'string') return value.replace(RESPONSE_TOKEN, (_m, p: string) => `<${p.trim()}>`) as T;
  if (Array.isArray(value)) return value.map((v) => markResponse(v)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, markResponse(v)])) as T;
  return value;
}

/** A templated request, field by field (shown.ts). */
function shownRequest(r: HttpRequestSpec): ShownAction {
  return {
    kind: 'http',
    method: r.method ?? 'GET',
    url: r.url,
    ...(r.auth ? { auth: `persona ${r.auth.persona} (its saved session)` } : {}),
    ...(r.headers && Object.keys(r.headers).length ? { headers: r.headers } : {}),
    ...(r.json !== undefined ? { json: r.json } : {}),
    ...(r.body !== undefined ? { body: r.body } : {}),
  };
}

export async function prepareHttp(spec: HttpHookSpec, k: KindEnv): Promise<PreparedHook> {
  const { ctx } = k;
  const { rollback, save_as, ...request } = spec;
  const tpl = await hookTemplateContext(ctx, request);
  const rendered = renderDeep(request, tpl);
  const call = toCall(rendered, ctx);
  if (call.persona !== undefined && k.phase === 'seed') {
    throw new HookError(`http hook: \`auth: {persona: ${call.persona}}\` is not available in a sandbox seed (no persona is signed in while the data is being built): sign in with the product's own API and {{accounts.${call.persona}.password}}`);
  }
  checkHostAllowed(call.url, ctx.project);
  personaOriginGuard(call, ctx);
  ignoreRollback(k, rollback !== undefined);
  const rollbackTemplate = journalsRollback(k.phase) ? rollback : undefined;
  if (rollbackTemplate) checkTokens(rollbackTemplate, await hookTemplateContext(ctx, rollbackTemplate), ['response']);
  const rollbackWrites = rollbackTemplate ? httpWriteReason(rollbackTemplate) : null;
  // Its request as an approval shows it: templated, the response's values (known once the hook ran) as <response.…>.
  const rollbackMarked = rollbackTemplate ? markResponse(rollbackTemplate) : undefined;
  const rollbackRendered = rollbackMarked ? renderDeep(rollbackMarked, await hookTemplateContext(ctx, rollbackMarked)) : undefined;
  const rollbackShown = rollbackRendered?.url ?? '';
  return {
    description: redactText(ctx, describeHttp(call.method, call.display) + asPersona(call) + (save_as ? ` → hooks.${save_as}` : '')),
    shown: shownRequest(rendered),
    destructive: call.method === 'DELETE' ? 'HTTP DELETE' : null,
    writes: httpWriteReason({ method: call.method, body: call.body }) ?? (rollbackWrites ? `its rollback: ${rollbackWrites}` : null),
    hosts: [new URL(call.url).hostname],
    ...(rollbackTemplate
      ? {
          rollback: {
            description: redactText(ctx, describeHttp((rollbackTemplate.method ?? 'GET').toUpperCase(), rollbackShown) + (rollbackTemplate.auth ? ` as ${rollbackTemplate.auth.persona}` : '')),
            reason: (rollbackTemplate.method ?? 'GET').toUpperCase() === 'DELETE' ? 'HTTP DELETE' : null,
            shown: shownRequest(rollbackRendered!),
          },
        }
      : {}),
    async execute() {
      const res = await sendChecked(call, ctx);
      if (save_as) ctx.saved[save_as] = res;
      const message = statusLine(res.status);
      if (!rollbackTemplate) return { message };
      try {
        return { message, rollback: await rollbackAction(ctx, rollbackTemplate, res) };
      } catch (e) {
        return { message, rollbackError: errorMessage(e) };
      }
    },
  };
}

export async function rollbackHttp(action: Extract<RollbackAction, { kind: 'http' }>, r: RollbackEnv): Promise<string> {
  const { ctx } = r;
  const tpl = await snapshotTemplateContext(ctx, action.data, action.request, r.env);
  const call = toCall(renderDeep(action.request, tpl), ctx);
  const res = await sendChecked(call, ctx);
  return statusLine(res.status);
}
