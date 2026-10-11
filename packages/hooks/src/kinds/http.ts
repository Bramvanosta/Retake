import { STATUS_CODES } from 'node:http';
import type { HttpHookSpec } from '@demo-studio/core';
import { checkHostAllowed } from '../allow-list.js';
import { describeHttp } from '../describe.js';
import { HookError, errorMessage } from '../errors.js';
import { redactText } from '../secrets.js';
import { checkTokens, hookTemplateContext, renderDeep, snapshotFor, snapshotTemplateContext } from '../template.js';
import type { HookContext, HttpRequestSpec, RollbackAction, SavedHttpResponse } from '../types.js';
import { oneLine } from '../util.js';
import { ignoreRollback } from './common.js';
import type { KindEnv, PreparedHook, RollbackEnv } from './common.js';

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
  return { method, url: url.toString(), display: spec.url, headers, body, expect: spec.expect };
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

async function sendChecked(call: HttpCall, ctx: HookContext): Promise<SavedHttpResponse> {
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
    description: redactText(ctx, describeHttp(call.method, call.display)),
  };
}

export async function prepareHttp(spec: HttpHookSpec, k: KindEnv): Promise<PreparedHook> {
  const { ctx } = k;
  const { rollback, save_as, ...request } = spec;
  const tpl = await hookTemplateContext(ctx, request);
  const call = toCall(renderDeep(request, tpl), ctx);
  checkHostAllowed(call.url, ctx.project);
  ignoreRollback(k, rollback !== undefined);
  const rollbackTemplate = k.phase === 'setup' ? rollback : undefined;
  if (rollbackTemplate) checkTokens(rollbackTemplate, await hookTemplateContext(ctx, rollbackTemplate), ['response']);
  return {
    description: redactText(ctx, describeHttp(call.method, call.display) + (save_as ? ` → hooks.${save_as}` : '')),
    destructive: call.method === 'DELETE' ? 'HTTP DELETE' : null,
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
  const tpl = await snapshotTemplateContext(ctx, action.data, action.request);
  const call = toCall(renderDeep(action.request, tpl), ctx);
  const res = await sendChecked(call, ctx);
  return statusLine(res.status);
}
