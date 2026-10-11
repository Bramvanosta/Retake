// In-memory state of the fixture + every business operation the API exposes.
// Time-based behaviour (imports, enrichment) is evaluated lazily from wall-clock timestamps,
// so there are no timers to clean up and a reset is instantaneous.

import {
  BAG_KG,
  BAG_SIZES,
  BUYER,
  DEMO_DATE,
  DEMO_START_TIME,
  GRIND_OPTIONS,
  IMPORT_RESULTS,
  LABEL_LANGUAGES,
  ORGANIZATIONS,
  SHIPPING_EUR,
  SUPPLIER_USER,
  VAT_RATE,
  buildSeed,
  pricesFor,
  registryEntries,
} from './seed.mjs';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

/** "2026-11-02T10:24:00" (demo-local wall time, no zone) ↔ epoch ms, treating the string as UTC. */
const toMs = (local) => Date.parse(`${local}Z`);
const toLocal = (ms) => new Date(ms).toISOString().slice(0, 19);

/** Lower-case, accents stripped: "Paraíso" → "paraiso". */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function slugify(s) {
  return fold(s)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const IMPORT_STAGES = [
  [0.0, 'Reading price list'],
  [0.3, 'Matching lots to the catalogue'],
  [0.65, 'Building regional availability'],
];

const ENRICHMENT_STEPS = [
  [0.12, 'Registry record'],
  [0.38, 'Cupping scores & tasting notes'],
  [0.64, 'Producer & farm'],
  [0.9, 'Awards'],
];

/** Fields filled by enrichment: hidden (null) while it runs. */
const ENRICHED_FIELDS = ['notes', 'profile', 'awards', 'story', 'farm_facts', 'altitude', 'producer'];

export class Store {
  /**
   * @param {{ enrichMs?: number, importMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.enrichMs = opts.enrichMs ?? 4000;
    this.importMs = opts.importMs ?? 2000;
    this.registry = registryEntries();
    this.reset();
  }

  reset() {
    const seed = buildSeed();
    this.products = seed.products;
    this.imports = seed.imports;
    this.quotes = seed.quotes.map((q) => ({ ...q, proposal: q.proposal ? this.#computeProposal(q, q.proposal) : null }));
    this.notifications = seed.notifications;
    this.counters = seed.counters;
    /** Refs removed by DELETE /refs, per product, so POST /refs can restore them without a body. */
    this.removedRefs = new Map();
    this.autoProposal = null;
    this.clockStart = Date.now();
    this.resets = (this.resets ?? 0) + 1;
  }

  /** Demo wall clock: starts at DEMO_DATE DEMO_START_TIME on every reset and runs in real time. */
  now() {
    return toLocal(toMs(`${DEMO_DATE}T${DEMO_START_TIME}`) + (Date.now() - this.clockStart));
  }

  session() {
    return {
      today: DEMO_DATE,
      now: this.now(),
      supplier: { user: SUPPLIER_USER, organization: ORGANIZATIONS[0] },
      buyer: BUYER,
      options: { bag_sizes: BAG_SIZES, grind_options: GRIND_OPTIONS, label_languages: LABEL_LANGUAGES },
      vat_rate: VAT_RATE,
    };
  }

  organizations() {
    return ORGANIZATIONS;
  }

  // ── Products ───────────────────────────────────────────────────────────────

  #product(slug) {
    const p = this.products.find((x) => x.slug === slug);
    if (!p) throw new ApiError(404, 'not_found', `No product with slug "${slug}"`);
    return p;
  }

  #enrichmentState(p) {
    if (!p.enrichment) return { status: 'done', progress: 1, steps: ENRICHMENT_STEPS.map(([, label]) => ({ label, done: true })) };
    const progress = Math.min(1, (Date.now() - p.enrichment.started_ms) / p.enrichment.duration_ms);
    if (progress >= 1) {
      p.enrichment = null;
      if (p.status === 'enriching') p.status = 'draft';
      return this.#enrichmentState(p);
    }
    return {
      status: 'running',
      progress: round2(progress),
      steps: ENRICHMENT_STEPS.map(([at, label]) => ({ label, done: progress >= at })),
      remaining_ms: Math.round((1 - progress) * p.enrichment.duration_ms),
    };
  }

  #summary(p) {
    const enrichment = this.#enrichmentState(p);
    const markets = p.availability.filter((r) => r.status !== 'archived');
    return {
      slug: p.slug,
      name: p.name,
      lot_number: p.lot_number,
      farm: p.farm,
      producer: enrichment.status === 'done' ? p.producer : null,
      origin: p.origin,
      region: p.region,
      variety: p.variety,
      process: p.process,
      harvest_year: p.harvest_year,
      score: p.score,
      notes: enrichment.status === 'done' ? p.notes : null,
      palette: p.palette,
      prices: p.prices,
      badge: p.badge,
      shelves: p.shelves,
      status: p.status,
      created_at: p.created_at,
      markets: markets.length,
      active_markets: markets.filter((r) => r.status === 'active').length,
      enrichment: enrichment.status,
    };
  }

  listProducts({ q, status } = {}) {
    const needle = fold(q ?? '').trim();
    return this.products
      .filter((p) => !status || status === 'all' || p.status === status || (status === 'active' && p.status !== 'archived'))
      .filter((p) => !needle || fold([p.name, p.farm, p.producer, p.origin, p.region, p.variety, p.lot_number].join(' ')).includes(needle))
      .map((p) => this.#summary(p));
  }

  getProduct(slug) {
    const p = this.#product(slug);
    const enrichment = this.#enrichmentState(p);
    const out = { ...structuredClone(p), enrichment };
    if (enrichment.status === 'running') for (const f of ENRICHED_FIELDS) out[f] = null;
    out.organization = ORGANIZATIONS.find((o) => o.id === p.organization_id);
    return out;
  }

  /** Creates a draft product from a registry lot; refuses lots already referenced by a product. */
  createProductFromRegistry(ref) {
    if (typeof ref !== 'string' || !ref) throw new ApiError(400, 'invalid', '"registry_ref" is required');
    const entry = this.registry.find((r) => r.ref === ref);
    if (!entry) throw new ApiError(404, 'not_found', `No registry lot "${ref}"`);
    const existing = this.products.find((p) => p.registry_refs.includes(ref));
    if (existing) {
      throw new ApiError(409, 'duplicate', 'This coffee is already in your catalogue', {
        product: { slug: existing.slug, name: existing.name, status: existing.status },
      });
    }
    const base = slugify(entry.name);
    let slug = base;
    for (let n = 2; this.products.some((p) => p.slug === slug); n++) slug = `${base}-${n}`;
    const price5 = round2(Math.max(22, (entry.score - 80) * 5.2 + 12) * 10) / 10;
    const product = {
      slug,
      name: entry.name,
      lot_number: `NF-${String(entry.harvest_year).slice(2)}-${String(this.counters.lot++).padStart(3, '0')}`,
      organization_id: 'northfield-roasters',
      farm: entry.farm,
      producer: entry.producer,
      origin: entry.origin,
      region: entry.region,
      variety: entry.variety,
      process: entry.process,
      altitude: entry.altitude,
      harvest_year: entry.harvest_year,
      score: entry.score,
      notes: entry.notes,
      profile: entry.profile,
      awards: entry.awards,
      story: entry.story,
      farm_facts: entry.farm_facts,
      palette: entry.palette,
      prices: pricesFor(Math.round(price5 * 10) / 10),
      badge: null,
      shelves: [],
      registry_refs: [ref],
      status: 'enriching',
      created_at: this.now(),
      enrichment: { started_ms: Date.now(), duration_ms: this.enrichMs },
      availability: [],
    };
    this.products.unshift(product);
    return this.getProduct(slug);
  }

  publishProduct(slug) {
    const p = this.#product(slug);
    if (this.#enrichmentState(p).status === 'running') throw new ApiError(409, 'enriching', `"${p.name}" is still being enriched`);
    if (p.status === 'archived') throw new ApiError(409, 'archived', `"${p.name}" is archived`);
    p.status = 'published';
    return this.getProduct(slug);
  }

  removeRefs(slug) {
    const p = this.#product(slug);
    const removed = p.registry_refs;
    if (removed.length) this.removedRefs.set(slug, [...(this.removedRefs.get(slug) ?? []), ...removed]);
    p.registry_refs = [];
    return { slug, removed, registry_refs: [] };
  }

  restoreRefs(slug, refs) {
    const p = this.#product(slug);
    let add = refs;
    if (add === undefined) add = this.removedRefs.get(slug) ?? [];
    if (!Array.isArray(add) || add.some((r) => typeof r !== 'string')) {
      throw new ApiError(400, 'invalid', '"refs" must be an array of registry refs');
    }
    this.removedRefs.delete(slug);
    p.registry_refs = [...new Set([...p.registry_refs, ...add])];
    return { slug, registry_refs: p.registry_refs };
  }

  searchRegistry(q) {
    const needle = fold(q ?? '').trim();
    if (needle.length < 2) return [];
    const scored = [];
    for (const r of this.registry) {
      const name = fold(r.name);
      const hay = fold([r.name, r.farm, r.producer, r.origin, r.region, r.variety, r.ref].join(' '));
      if (!hay.includes(needle)) continue;
      const rank = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;
      scored.push({ rank, r });
    }
    scored.sort((a, b) => a.rank - b.rank || b.r.harvest_year - a.r.harvest_year || a.r.name.localeCompare(b.r.name));
    return scored.slice(0, 8).map(({ r }) => ({
      ref: r.ref,
      name: r.name,
      producer: r.producer,
      origin: r.origin,
      region: r.region,
      variety: r.variety,
      process: r.process,
      harvest_year: r.harvest_year,
      score: r.score,
      palette: r.palette,
      in_catalogue: this.products.some((p) => p.registry_refs.includes(r.ref)),
    }));
  }

  // ── Availability ───────────────────────────────────────────────────────────

  getAvailability(slug) {
    const p = this.#product(slug);
    return { product: this.#summary(p), rows: structuredClone(p.availability) };
  }

  updateAvailability(slug, rowId, patch) {
    const p = this.#product(slug);
    const r = p.availability.find((x) => x.id === rowId);
    if (!r) throw new ApiError(404, 'not_found', `No availability row "${rowId}" for "${slug}"`);
    if (patch === null || typeof patch !== 'object') throw new ApiError(400, 'invalid', 'Expected a JSON object');
    const lists = { bag_sizes: BAG_SIZES, grind_options: GRIND_OPTIONS, label_languages: LABEL_LANGUAGES };
    for (const [key, allowed] of Object.entries(lists)) {
      if (patch[key] === undefined) continue;
      const v = patch[key];
      if (!Array.isArray(v) || v.some((x) => !allowed.includes(x))) {
        throw new ApiError(400, 'invalid', `"${key}" must be a list of: ${allowed.join(', ')}`);
      }
      r[key] = allowed.filter((x) => v.includes(x));
    }
    if (patch.status !== undefined) {
      if (!['active', 'paused', 'scheduled', 'archived'].includes(patch.status)) {
        throw new ApiError(400, 'invalid', '"status" must be active, paused, scheduled or archived');
      }
      r.status = patch.status;
    }
    if (patch.min_order_bags !== undefined) {
      const n = Number(patch.min_order_bags);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw new ApiError(400, 'invalid', '"min_order_bags" must be an integer between 1 and 50');
      r.min_order_bags = n;
    }
    return structuredClone(r);
  }

  // ── Imports ────────────────────────────────────────────────────────────────

  #materializeImport(imp) {
    if (imp.status !== 'processing') return imp;
    const progress = Math.min(1, (Date.now() - imp.started_ms) / imp.duration_ms);
    if (progress < 1) {
      const stage = [...IMPORT_STAGES].reverse().find(([at]) => progress >= at)[1];
      return { ...imp, progress: round2(progress), stage };
    }
    const summary = (IMPORT_RESULTS[imp.organization_id] ?? []).map(([region, offers]) => ({ region, offers }));
    Object.assign(imp, {
      status: 'completed',
      offers: summary.reduce((s, x) => s + x.offers, 0),
      regions: summary.length,
      summary,
      warnings: 0,
      progress: 1,
      stage: 'Done',
    });
    delete imp.started_ms;
    return imp;
  }

  #publicImport(imp) {
    const m = this.#materializeImport(imp);
    const org = ORGANIZATIONS.find((o) => o.id === m.organization_id);
    const { started_ms: _s, ...rest } = m;
    return { ...rest, organization: org ? { id: org.id, name: org.name, initials: org.initials, tone: org.tone } : null };
  }

  listImports() {
    return this.imports.map((i) => this.#publicImport(i));
  }

  getImport(id) {
    const imp = this.imports.find((i) => i.id === id);
    if (!imp) throw new ApiError(404, 'not_found', `No import "${id}"`);
    return this.#publicImport(imp);
  }

  createImport(input) {
    const org = ORGANIZATIONS.find((o) => o.id === input?.organization_id);
    if (!org) throw new ApiError(400, 'invalid', `"organization_id" must be one of: ${ORGANIZATIONS.map((o) => o.id).join(', ')}`);
    if (typeof input.file_name !== 'string' || !input.file_name.trim()) throw new ApiError(400, 'invalid', '"file_name" is required');
    const imp = {
      id: `imp-${String(this.counters.import++).padStart(4, '0')}`,
      file_name: input.file_name.trim(),
      file_size: Number(input.file_size) || 0,
      organization_id: org.id,
      created_at: this.now(),
      offers: 0,
      regions: 0,
      status: 'processing',
      warnings: 0,
      by: SUPPLIER_USER.name,
      started_ms: Date.now(),
      duration_ms: this.importMs,
      progress: 0,
      stage: IMPORT_STAGES[0][1],
    };
    this.imports.unshift(imp);
    return this.#publicImport(imp);
  }

  // ── Quotes ─────────────────────────────────────────────────────────────────

  #quote(id) {
    if (id === 'latest') {
      const latest = [...this.quotes].sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (!latest) throw new ApiError(404, 'not_found', 'There are no quotes yet');
      return latest;
    }
    const q = this.quotes.find((x) => x.id === id);
    if (!q) throw new ApiError(404, 'not_found', `No quote "${id}"`);
    return q;
  }

  #publicQuote(q) {
    const p = this.products.find((x) => x.slug === q.product_slug);
    const kg = q.bags * BAG_KG[q.bag_size];
    return {
      ...structuredClone(q),
      reference: `Q-${q.id}`,
      quantity_kg: kg,
      product: p ? { slug: p.slug, name: p.name, origin: p.origin, region: p.region, palette: p.palette, process: p.process, variety: p.variety } : null,
      supplier: ORGANIZATIONS[0].name,
    };
  }

  listQuotes({ buyer } = {}) {
    return [...this.quotes]
      .filter((q) => !buyer || q.buyer_id === buyer)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map((q) => this.#publicQuote(q));
  }

  getQuote(id) {
    return this.#publicQuote(this.#quote(id));
  }

  createQuote(input) {
    const i = input ?? {};
    const p = this.products.find((x) => x.slug === i.product_slug && x.status === 'published');
    if (!p) throw new ApiError(400, 'invalid', `"product_slug" must be a published product`);
    const bags = Number(i.bags);
    if (!Number.isInteger(bags) || bags < 1 || bags > 99) throw new ApiError(400, 'invalid', '"bags" must be an integer between 1 and 99');
    if (!BAG_SIZES.includes(i.bag_size)) throw new ApiError(400, 'invalid', `"bag_size" must be one of: ${BAG_SIZES.join(', ')}`);
    if (!GRIND_OPTIONS.includes(i.grind)) throw new ApiError(400, 'invalid', `"grind" must be one of: ${GRIND_OPTIONS.join(', ')}`);
    if (!LABEL_LANGUAGES.includes(i.label_language)) throw new ApiError(400, 'invalid', `"label_language" must be one of: ${LABEL_LANGUAGES.join(', ')}`);
    if (!isDate(i.window_start) || !isDate(i.window_end) || i.window_end < i.window_start) {
      throw new ApiError(400, 'invalid', '"window_start" and "window_end" must be YYYY-MM-DD dates, start ≤ end');
    }
    const q = {
      id: String(this.counters.quote++),
      buyer_id: BUYER.id,
      buyer_name: BUYER.name,
      buyer_country: BUYER.country,
      product_slug: p.slug,
      bags,
      bag_size: i.bag_size,
      grind: i.grind,
      label_language: i.label_language,
      window_start: i.window_start,
      window_end: i.window_end,
      message: typeof i.message === 'string' ? i.message.slice(0, 2000) : '',
      created_at: this.now(),
      status: 'requested',
      proposal: null,
    };
    this.quotes.push(q);
    if (this.autoProposal) {
      const cfg = this.autoProposal;
      if (!cfg.repeat) this.autoProposal = null;
      this.addProposal(q.id, cfg);
    }
    return this.getQuote(q.id);
  }

  #computeProposal(q, input) {
    const kg = q.bags * BAG_KG[q.bag_size];
    const shipping = input.shipping_eur ?? SHIPPING_EUR;
    let unit;
    let goods;
    let vat;
    let total;
    if (input.total_eur !== undefined) {
      total = round2(Number(input.total_eur));
      if (!(total > shipping)) throw new ApiError(400, 'invalid', `"total_eur" must be greater than the shipping (${shipping})`);
      const net = round2(total / (1 + VAT_RATE));
      vat = round2(total - net);
      goods = round2(net - shipping);
      unit = round2(goods / kg);
    } else {
      const product = this.products.find((x) => x.slug === q.product_slug);
      unit = input.unit_price_eur ?? product?.prices[q.bag_size];
      if (typeof unit !== 'number' || !(unit > 0)) throw new ApiError(400, 'invalid', '"unit_price_eur" must be a positive number');
      goods = round2(unit * kg);
      vat = round2((goods + shipping) * VAT_RATE);
      total = round2(goods + shipping + vat);
    }
    const created = input.created_at ?? this.now();
    return {
      from: ORGANIZATIONS[0].name,
      unit_price_eur: unit,
      quantity_kg: kg,
      goods_eur: goods,
      shipping_eur: shipping,
      net_eur: round2(goods + shipping),
      vat_rate: VAT_RATE,
      vat_eur: vat,
      total_eur: total,
      note: input.note ?? '',
      created_at: created,
      valid_until: input.valid_until ?? addDays(created.slice(0, 10), 14),
    };
  }

  /**
   * Adds the supplier's proposal to a quote ("latest" = most recent quote) and notifies the buyer.
   * `after_minutes` stamps the proposal that long after the request (for "a few hours later" stories).
   */
  addProposal(id, input = {}) {
    const q = this.#quote(id);
    const opts = { ...input };
    if (opts.after_minutes !== undefined) {
      const m = Number(opts.after_minutes);
      if (!Number.isFinite(m) || m < 0) throw new ApiError(400, 'invalid', '"after_minutes" must be a positive number');
      opts.created_at = toLocal(toMs(q.created_at) + m * 60_000);
    }
    q.proposal = this.#computeProposal(q, opts);
    q.status = 'proposal';
    const product = this.products.find((x) => x.slug === q.product_slug);
    this.notifications.unshift({
      id: `n-${String(this.counters.notification++).padStart(4, '0')}`,
      buyer_id: q.buyer_id,
      kind: 'proposal',
      title: `New proposal from ${q.proposal.from}`,
      body: `${product?.name ?? q.product_slug} · ${q.bags} × ${q.bag_size} — €${q.proposal.total_eur.toFixed(2)} incl. VAT`,
      href: `/quotes/${q.id}`,
      created_at: q.proposal.created_at,
      read: false,
    });
    return this.getQuote(q.id);
  }

  setQuoteStatus(id, status) {
    const q = this.#quote(id);
    if ((status === 'accepted' || status === 'declined') && !q.proposal) {
      throw new ApiError(409, 'no_proposal', `Quote Q-${q.id} has no proposal to ${status === 'accepted' ? 'accept' : 'decline'} yet`);
    }
    q.status = status;
    return this.getQuote(q.id);
  }

  armAutoProposal(input = {}) {
    const cfg = { after_minutes: 258, ...input };
    if (cfg.total_eur !== undefined && !(Number(cfg.total_eur) > 0)) throw new ApiError(400, 'invalid', '"total_eur" must be a positive number');
    this.autoProposal = cfg;
    return { armed: true, config: cfg };
  }

  disarmAutoProposal() {
    const was = this.autoProposal !== null;
    this.autoProposal = null;
    return { armed: false, was_armed: was };
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  listNotifications(buyer = BUYER.id) {
    const items = this.notifications
      .filter((n) => n.buyer_id === buyer)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((n) => structuredClone(n));
    return { unread: items.filter((n) => !n.read).length, items };
  }

  markNotificationsRead(ids, buyer = BUYER.id) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) {
      throw new ApiError(400, 'invalid', '"ids" must be an array of notification ids');
    }
    for (const n of this.notifications) {
      if (n.buyer_id === buyer && (!ids || ids.includes(n.id))) n.read = true;
    }
    return this.listNotifications(buyer);
  }
}

