// JSON API shared by both apps (console and shop talk to the same in-memory store).
// Every route is listed in ROUTES; GET /api lists them (handy when writing http hooks).

import { compilePath, HttpError, readJson, sendError, sendJson, sendPreflight } from './http.mjs';
import { ApiError } from './store.mjs';

/** @typedef {{ store: import('./store.mjs').Store, urls: { console: string, shop: string } }} ApiContext */

class Created {
  constructor(value) {
    this.value = value;
  }
}
const created = (value) => new Created(value);

const ROUTES = [
  ['GET', '/api', 'This list', (_p, _b, _q, ctx) => ({ routes: ROUTES.map(([m, path, doc]) => ({ method: m, path, doc })), urls: ctx.urls })],
  ['GET', '/api/health', 'Liveness + app URLs', (_p, _b, _q, ctx) => ({ ok: true, name: 'northfield-fixture', urls: ctx.urls, now: ctx.store.now() })],
  ['POST', '/api/reset', 'Restore the seed data (and the demo clock)', (_p, _b, _q, ctx) => (ctx.store.reset(), { ok: true, now: ctx.store.now() })],
  ['GET', '/api/session', 'Demo date, signed-in supplier user and buyer account, option lists', (_p, _b, _q, ctx) => ctx.store.session()],
  ['GET', '/api/organizations', 'Supplier organisations', (_p, _b, _q, ctx) => ctx.store.organizations()],
  ['GET', '/api/products', 'Catalogue (?q=search&status=all|active|published|draft|archived)', (_p, _b, q, ctx) => ctx.store.listProducts({ q: q.get('q') ?? undefined, status: q.get('status') ?? undefined })],
  ['POST', '/api/products', 'Add a coffee from the registry: {registry_ref} → 201 | 409 duplicate', (_p, b, _q, ctx) => created(ctx.store.createProductFromRegistry(b?.registry_ref))],
  ['GET', '/api/products/:slug', 'Product detail (with enrichment state)', (p, _b, _q, ctx) => ctx.store.getProduct(p.slug)],
  ['POST', '/api/products/:slug/publish', 'Publish a draft product (visible in the shop)', (p, _b, _q, ctx) => ctx.store.publishProduct(p.slug)],
  ['DELETE', '/api/products/:slug/refs', 'Remove the product’s registry refs (lets the same lot be added again)', (p, _b, _q, ctx) => ctx.store.removeRefs(p.slug)],
  ['POST', '/api/products/:slug/refs', 'Restore registry refs: {refs?: [...]} (default: the ones removed)', (p, b, _q, ctx) => ctx.store.restoreRefs(p.slug, b?.refs)],
  ['GET', '/api/registry', 'Registry search (?q=, at least 2 characters)', (_p, _b, q, ctx) => ctx.store.searchRegistry(q.get('q'))],
  ['GET', '/api/availability/:slug', 'Availability rows by region', (p, _b, _q, ctx) => ctx.store.getAvailability(p.slug)],
  ['PATCH', '/api/availability/:slug/:row', 'Update a row: {bag_sizes?, grind_options?, label_languages?, status?, min_order_bags?}', (p, b, _q, ctx) => ctx.store.updateAvailability(p.slug, p.row, b)],
  ['GET', '/api/imports', 'Imports (newest first)', (_p, _b, _q, ctx) => ctx.store.listImports()],
  ['POST', '/api/imports', 'Start an import: {organization_id, file_name, file_size}', (_p, b, _q, ctx) => created(ctx.store.createImport(b))],
  ['GET', '/api/imports/:id', 'Import progress / result', (p, _b, _q, ctx) => ctx.store.getImport(p.id)],
  ['GET', '/api/quotes', 'Quotes (?buyer=demo-cafe)', (_p, _b, q, ctx) => ctx.store.listQuotes({ buyer: q.get('buyer') ?? undefined })],
  ['POST', '/api/quotes', 'Request a quote (buyer)', (_p, b, _q, ctx) => created(ctx.store.createQuote(b))],
  ['POST', '/api/quotes/auto-proposal', 'Arm a proposal for the NEXT quote request: {total_eur?, unit_price_eur?, shipping_eur?, note?, after_minutes? (258), repeat?}', (_p, b, _q, ctx) => ctx.store.armAutoProposal(b ?? {})],
  ['DELETE', '/api/quotes/auto-proposal', 'Disarm the automatic proposal', (_p, _b, _q, ctx) => ctx.store.disarmAutoProposal()],
  ['GET', '/api/quotes/:id', 'Quote detail (:id = number or "latest")', (p, _b, _q, ctx) => ctx.store.getQuote(p.id)],
  ['POST', '/api/quotes/:id/proposal', 'Supplier proposal + buyer notification: {total_eur?, unit_price_eur?, shipping_eur?, note?, after_minutes?} (:id may be "latest")', (p, b, _q, ctx) => ctx.store.addProposal(p.id, b ?? {})],
  ['POST', '/api/quotes/:id/accept', 'Buyer accepts the proposal', (p, _b, _q, ctx) => ctx.store.setQuoteStatus(p.id, 'accepted')],
  ['POST', '/api/quotes/:id/decline', 'Buyer declines the proposal', (p, _b, _q, ctx) => ctx.store.setQuoteStatus(p.id, 'declined')],
  ['GET', '/api/notifications', 'Buyer notifications {unread, items}', (_p, _b, _q, ctx) => ctx.store.listNotifications()],
  ['POST', '/api/notifications/read', 'Mark read: {ids?: [...]} (default: all)', (_p, b, _q, ctx) => ctx.store.markNotificationsRead(b?.ids)],
].map(([method, path, doc, handler]) => [method, path, doc, handler, compilePath(path)]);

/**
 * Handles /api/*. Always responds.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {URL} url
 * @param {ApiContext} ctx
 */
export async function handleApi(req, res, url, ctx) {
  if (req.method === 'OPTIONS') return sendPreflight(res);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const matching = ROUTES.map((r) => ({ r, params: r[4](url.pathname) })).filter((x) => x.params);
  if (matching.length === 0) return sendError(res, 404, 'not_found', `No API route ${req.method} ${url.pathname} (GET /api lists them)`);
  const hit = matching.find((x) => x.r[0] === method);
  if (!hit) {
    const allowed = [...new Set(matching.map((x) => x.r[0]))].join(', ');
    res.setHeader('allow', allowed);
    return sendError(res, 405, 'method_not_allowed', `${req.method} is not allowed on ${url.pathname} (allowed: ${allowed})`);
  }
  try {
    const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req);
    const out = hit.r[3](hit.params, body, url.searchParams, ctx);
    if (out instanceof Created) sendJson(res, 201, out.value);
    else sendJson(res, 200, out);
  } catch (err) {
    if (err instanceof ApiError || err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.details);
    console.error(`[northfield] ${req.method} ${url.pathname} failed:`, err);
    sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err));
  }
}
