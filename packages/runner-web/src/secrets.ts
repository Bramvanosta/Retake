import { collectSecretRefs, redact, secretForms } from '@retake/core';
import { resolveSecretRef } from '@retake/core/io';
import type { RunProgress, RunRecord, SecretResolver, Timeline } from '@retake/core';

/**
 * Where a run file keeps its strings as written (R-RUN-17), key by key along the file's shape: `keep` keeps the subtree
 * — ids, enums, paths, files and timestamps the CLI and the editor join on (a short secret that happens to occur in
 * one must not corrupt it), what validation keeps secrets out of (captions, cards, interstitials, overlay slots and
 * params, page labels, the video block, tutorial switches) and `artefacts` (captured emails, documents and texts are
 * the app's own content, kept as captured; the email image shows them anyway) — and `all` redacts every string below.
 * A key not listed is `all`: target specs and descriptions, camera targets, emit data, eval values, transition params,
 * URLs, messages. A function picks by the value (a transition written as a name, or as {component, params}). Numbers
 * and booleans are never changed. A new timeline or RunRecord field holding an id, an enum or a file belongs here.
 */
export type RedactPolicy = 'keep' | 'all' | { readonly [key: string]: RedactPolicy } | ((value: unknown) => RedactPolicy);

const K = 'keep';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A transition into a scene or a card: its kind or component id; never its params. */
const TRANSITION: RedactPolicy = (v) => (typeof v === 'string' ? K : { component: K });
const PAGE_SEGMENT: RedactPolicy = { id: K };
/** The data of a step event: what the actions record (notifications too); emit `data`, `value`s and texts redacted. */
const EVENT_DATA: RedactPolicy = (v) =>
  isRecord(v)
    ? {
        name: K, artefact: K, file: K, path: K, page: K, how: K, via: K, mime: K, clear: K, rate: K, close: K, key: K,
        delivered: K, days: K, quick_runs: K, park: K, clicks: { role: K, strategy: K }, navigation: { kind: K },
      }
    : 'all';

export const TIMELINE_POLICY: RedactPolicy = {
  version: K, run_id: K, project: K, scenario: K, created_at: K, mode: K, capture: K, video: K,
  scenes: {
    id: K, kind: K, page: K, caption: K, transition: TRANSITION, frame: K, interstitial: K, card: { '*': K, transition: TRANSITION },
    tutorial: K, status: K, pages: { id: K, page: K, label: K, viewport: K, track: K },
  },
  events: {
    scene: K, id: K, action: K, mark: K, caption: K, tutorial: K, page: K, status: K, strategy: K,
    camera: { ease: K, until: K, target: (v) => (v === 'cursor' || v === 'step' ? K : 'all') },
    overlay: { component: K, slots: K, params: K, at: K, box: K },
    data: EVENT_DATA,
  },
  markers: { name: K, scene: K, page: K },
  pages: PAGE_SEGMENT,
  cursor_effects: K,
  loading: K,
  artefacts: { '*': K, target: 'all', url: 'all' },
  tracks: { id: K, file: K, frames_file: K, preset: K, pages: PAGE_SEGMENT, cursor_effects: K, loading: K },
  // L1.7: names, enums, the display bases (literal in project.yaml) and the clock are kept; the real URLs of the
  // display table and of the writes, and the patterns that matched them, are redacted like any URL.
  environment: {
    name: K, production: K, access: K, allow_writes: K, display: { page: K, display: K }, clock: K,
    writes: { t: K, method: K, operation: K, outcome: K, status: K, via: K, protected_by: K },
    // L1.8: names, enums, numbers and the seed hash of the sandbox reset made before the take.
    sandbox: K,
  },
};

export const RECORD_POLICY: RedactPolicy = {
  version: K, id: K, project: K, scenario: K, mode: K, status: K, started_at: K, finished_at: K, dir: K, env: K, options: K, current: K,
  capture: K, timeline: K, screenshots: K, hooks: K, stopped_at: K, error: { scene: K, action: K, screenshot: K, dom: K },
  environment: K, engine: K,
};

/** Progress events (log.jsonl, the terminal): a hook's `name` is its name, else its description (redacted by hooks). */
export const PROGRESS_POLICY: RedactPolicy = {
  type: K, phase: K, name: K, status: K, scene: K, action: K, level: K, run: RECORD_POLICY,
};

/**
 * The secret values of a run (`{{env:…}}` / `{{keychain:…}}` in steps, the mailbox headers): resolved once before the
 * browser opens, then masked as *** — in every form they can take (core secretForms) — where the run writes:
 * log.jsonl and the progress events, run.json, timeline.json, error-*.html and the returned RunRecord.
 */
export class RunSecrets {
  private readonly cache = new Map<string, string>();
  private readonly values = new Set<string>();
  /** Every form of every value, longest first (so overlapping secrets are fully masked). */
  private forms: string[] = [];

  constructor(private readonly resolve: (ref: string) => Promise<string> = resolveSecretRef) {}

  /** Resolve every secret reference of `value` not resolved yet (env, keychain: may prompt on macOS). */
  async prefetch(value: unknown): Promise<void> {
    for (const ref of collectSecretRefs(value)) {
      if (this.cache.has(ref)) continue;
      const v = await this.resolve(ref);
      this.cache.set(ref, v);
      this.register(v);
    }
  }

  /** The synchronous lookup of TemplateContext.secrets: a prefetched value, else the environment; each one registered. */
  readonly resolver: SecretResolver = (ref) => {
    const v = this.cache.get(ref) ?? (ref.startsWith('env:') ? process.env[ref.slice(4)] : undefined);
    if (v !== undefined) this.register(v);
    return v;
  };

  /**
   * A value that is a secret as written (a sandbox account's plain password, L1.8): masked from now on like a resolved
   * {{env:…}} value.
   */
  addValue(value: string): void {
    this.register(value);
  }

  private register(value: string): void {
    if (this.values.has(value) || secretForms(value).length === 0) return;
    this.values.add(value);
    this.forms = [...new Set([...this.forms, ...secretForms(value)])].sort((a, b) => b.length - a.length);
  }

  /** Whether `text` holds a secret value as is (a type step typing one). */
  contains(text: string): boolean {
    for (const v of this.values) if (v.length >= 3 && text.includes(v)) return true;
    return false;
  }

  redactText(text: string): string {
    return this.forms.length ? redact(text, this.forms) : text;
  }

  /**
   * A copy of a JSON value with its strings redacted where `policy` says (default: every string — a step about to be
   * described, so no cut of the description keeps part of a secret); the value itself when there is no secret.
   */
  redactDeep<T>(value: T, policy: RedactPolicy = 'all'): T {
    if (!this.forms.length) return value;
    return this.walk(value, policy) as T;
  }

  redactTimeline(tl: Timeline): Timeline {
    return this.redactDeep(tl, TIMELINE_POLICY);
  }

  redactRecord<R extends RunRecord>(r: R): R {
    return this.redactDeep(r, RECORD_POLICY);
  }

  redactProgress(e: RunProgress): RunProgress {
    return this.redactDeep(e, PROGRESS_POLICY);
  }

  private walk(value: unknown, policy: RedactPolicy): unknown {
    if (typeof policy === 'function') return this.walk(value, policy(value));
    if (policy === K) return value;
    if (typeof value === 'string') return this.redactText(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, policy));
    if (isRecord(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = policy === 'all' ? 'all' : Object.hasOwn(policy, k) ? policy[k] : Object.hasOwn(policy, '*') ? policy['*'] : 'all';
        out[k] = this.walk(v, sub);
      }
      return out;
    }
    return value;
  }
}
