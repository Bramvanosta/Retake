/**
 * The compose subset a project archive hands over (engine project-archive): a compose file is read by Retake itself
 * and accepted only when every key and value is one of a small, documented set — anything else means the sandbox is not
 * handed over (the export refuses it, an import of a crafted archive is refused, a sandbox outside it never starts
 * through Retake). Listing dangerous features one by one loses: merge keys, interpolation, nested extends, provider
 * services, driver options, host-file secrets… — the subset fails closed instead.
 *
 * Refused anywhere in the file: a YAML directive (`%YAML`, `%TAG`), anchor, alias, merge key (`<<`) or any explicit tag
 * (`!reset`, `!!binary`…), a second document, and any `$` interpolation (`${…}`, `$NAME`; `$$` too) outside a
 * service's `environment` values. (`environment` may pass a variable of the host through — `[HOME]`, `${X}`: docker
 * gets only Retake's allow-list of the environment and the sandbox's env file.)
 *
 * Top level: `services`, `volumes` (each `null` or `{name, labels}`, its `name` its key: no driver, driver options or
 * external volume), `networks` (each `null` or `{name, labels, internal}`, its `name` its key), `name`,
 * `version`. Nothing else (`include`, `secrets`, `configs`, `models`, `x-…` included).
 *
 * A service: `image`, `build` (a string or `{context, dockerfile, args, target}`: the export replaces it with the
 * image it carries), `pull_policy`, `command`, `entrypoint`, `environment` (a map or a list), `env_file` (relative
 * literal paths), `ports`, `expose`, `depends_on`, `healthcheck`, `restart`, `working_dir`, `user`, `labels`,
 * `volumes` (named volumes declared at the top level, anonymous volumes, tmpfs, or binds whose source is a relative
 * literal path `./…` / `../…`, mode `ro`, `rw`, `z` or `Z` only), `networks` (names, with aliases), `tmpfs`, `stop_grace_period`, `init`, `platform`,
 * `hostname`. Nothing else (`privileged`, every `*_mode`, `pid`, `ipc`, `uts`, `cgroup*`, `cap_add`, `devices`,
 * `device_cgroup_rules`, `security_opt`, `sysctls`, `runtime`, `volumes_from`, `extends`, `provider`, `develop`,
 * `deploy`, `extra_hosts`, `secrets`, `configs`, `post_start`… included). Where the relative paths resolve — inside
 * the project, from the compose project's folder — is the caller's check (engine compose-read.ts).
 */
import { isAlias, isPair, isScalar, parseDocument, visit } from 'yaml';

/** One service as the subset reads it: what it runs and what it reads from the project. */
export interface SubsetService {
  name: string;
  image?: string;
  build?: string;
  pull_policy?: string;
  /** Its `env_file` paths, as written (relative). */
  env_files: string[];
  /** Its bind mounts: source as written (relative), target. */
  binds: Array<{ source: string; target: string }>;
  /** The named volumes it mounts. */
  volumes: string[];
  ports: string[];
  /** The other keys it sets (accepted): what the listing names. */
  keys: string[];
}

export interface SubsetRead {
  services: SubsetService[];
  /** Every key or value outside the subset, each with where it is and why. */
  problems: string[];
}

const TOP = new Set(['services', 'volumes', 'networks', 'name', 'version']);
const SERVICE = new Set([
  'image',
  'build',
  'pull_policy',
  'command',
  'entrypoint',
  'environment',
  'env_file',
  'ports',
  'expose',
  'depends_on',
  'healthcheck',
  'restart',
  'working_dir',
  'user',
  'labels',
  'volumes',
  'networks',
  'tmpfs',
  'stop_grace_period',
  'init',
  'platform',
  'hostname',
]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const INTERPOLATION = /\$(?!\$)(\{|[A-Za-z_])/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isScalarValue = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** `$` interpolation in a value (strings anywhere under it), outside a service's `environment`. */
function interpolated(v: unknown, path: string, out: string[]): void {
  if (isStr(v)) {
    if (INTERPOLATION.test(v)) out.push(`${path}: interpolation (\`$…\`) outside a service's environment values`);
  } else if (Array.isArray(v)) v.forEach((x, i) => interpolated(x, `${path}[${i}]`, out));
  else if (isObj(v))
    for (const [k, x] of Object.entries(v)) {
      if (INTERPOLATION.test(k)) out.push(`${path}: interpolation in a key`);
      interpolated(x, `${path}.${k}`, out);
    }
}

/** A short volume `source:target[:mode]`, or a long one: its kind. */
function volumeOf(v: unknown, at: string, problems: string[]): { bind?: { source: string; target: string }; named?: string } {
  if (isStr(v)) {
    const parts = v.split(':');
    if (parts.length === 1) return {}; // an anonymous volume
    const [source, target = ''] = parts as [string, string];
    if (parts.length > 3) problems.push(`${at}: a volume that does not read (${v})`);
    const mode = parts[2];
    if (mode !== undefined && !mode.split(',').every((m) => ['ro', 'rw', 'z', 'Z'].includes(m))) problems.push(`${at}: a volume mode other than ro, rw, z, Z (${mode}: no propagation)`);
    if (source.startsWith('./') || source.startsWith('../') || source === '.' || source === '..') return { bind: { source, target } };
    if (source.startsWith('/') || source.startsWith('~') || source.includes('\\') || /^[A-Za-z]:/.test(source)) {
      problems.push(`${at}: a bind of a host path (${source}): only relative paths inside the project`);
      return {};
    }
    if (!NAME.test(source)) problems.push(`${at}: a volume source that is neither a named volume nor a relative path (${source})`);
    return { named: source };
  }
  if (!isObj(v)) {
    problems.push(`${at}: a volume that does not read`);
    return {};
  }
  const keys = new Set(['type', 'source', 'target', 'read_only', 'volume', 'bind', 'tmpfs']);
  for (const k of Object.keys(v)) if (!keys.has(k)) problems.push(`${at}.${k}: not a volume setting an archive hands over`);
  if (isObj(v.volume)) for (const k of Object.keys(v.volume)) if (k !== 'nocopy') problems.push(`${at}.volume.${k}: not a volume setting an archive hands over`);
  if (isObj(v.bind)) for (const k of Object.keys(v.bind)) if (k !== 'create_host_path') problems.push(`${at}.bind.${k}: not a bind setting an archive hands over (propagation, SELinux relabelling…)`);
  const target = isStr(v.target) ? v.target : '';
  if (v.type === 'tmpfs') return {};
  if (v.type === 'volume') {
    if (v.source === undefined) return {};
    if (!isStr(v.source) || !NAME.test(v.source)) problems.push(`${at}.source: not a named volume`);
    return isStr(v.source) ? { named: v.source } : {};
  }
  if (v.type === 'bind') {
    const s = isStr(v.source) ? v.source : '';
    if (!(s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..')) {
      problems.push(`${at}.source: a bind of a host path (${s || 'none'}): only relative paths inside the project`);
      return {};
    }
    return { bind: { source: s, target } };
  }
  problems.push(`${at}.type: ${String(v.type)} is not a volume type an archive hands over`);
  return {};
}

/** A service's `env_file`: relative paths only (where they resolve is the caller's check). */
function envFiles(x: unknown, p: string, s: SubsetService, problems: string[]): void {
  for (const e of Array.isArray(x) ? x : [x]) {
    const path = isStr(e) ? e : isObj(e) && isStr(e.path) ? e.path : undefined;
    if (isObj(e)) for (const ek of Object.keys(e)) if (!['path', 'required', 'format'].includes(ek)) problems.push(`${p}.${ek}: not an env_file setting an archive hands over`);
    if (path === undefined || path.startsWith('/') || path.startsWith('~') || path.includes('\\')) problems.push(`${p}: an env file that is not a relative path (${String(path)})`);
    else s.env_files.push(path);
  }
}

/** A service's `ports`: values, or long forms of the usual keys. */
function portsOf(x: unknown, p: string, s: SubsetService, problems: string[]): void {
  const keys = ['target', 'published', 'host_ip', 'protocol', 'mode', 'name', 'app_protocol'];
  for (const [i, q] of (Array.isArray(x) ? x : [x]).entries()) {
    if (isScalarValue(q) && q !== null) s.ports.push(String(q));
    else if (isObj(q) && Object.keys(q).every((pk) => keys.includes(pk))) s.ports.push(`${q.host_ip ? `${String(q.host_ip)}:` : ''}${String(q.published ?? '')}:${String(q.target)}`);
    else problems.push(`${p}[${i}]: not a port setting an archive hands over`);
  }
}

/** A service's `volumes`: binds and named volumes collected (a named one must be declared). */
function volumesOf(x: unknown, p: string, s: SubsetService, declared: ReadonlySet<string>, problems: string[]): void {
  for (const [i, q] of (Array.isArray(x) ? x : [x]).entries()) {
    const r = volumeOf(q, `${p}[${i}]`, problems);
    if (r.bind) s.binds.push(r.bind);
    if (!r.named) continue;
    if (!declared.has(r.named)) problems.push(`${p}[${i}]: the named volume ${r.named} is not declared at the top level`);
    s.volumes.push(r.named);
  }
}

/** The top-level `volumes` and `networks`: names, without drivers, driver options or external ones. */
function sections(v: Record<string, unknown>, file: string, problems: string[]): void {
  for (const k of ['volumes', 'networks'] as const) {
    if (v[k] === undefined || v[k] === null) continue;
    if (!isObj(v[k])) {
      problems.push(`${file}: ${k}: not a mapping`);
      continue;
    }
    const allowed = k === 'volumes' ? ['name', 'labels'] : ['name', 'labels', 'internal'];
    for (const [n, d] of Object.entries(v[k] as Record<string, unknown>)) {
      if (!NAME.test(n)) problems.push(`${file}: ${k}.${n}: a name of other characters`);
      if (d === null) continue;
      if (!isObj(d)) {
        problems.push(`${file}: ${k}.${n}: not a mapping`);
        continue;
      }
      if (d.name !== undefined && d.name !== n)
        problems.push(`${file}: ${k}.${n}.name: ${String(d.name)} — a name other than its key (it could pick an existing ${k === 'volumes' ? 'volume' : 'network'} of this machine)`);
      const bad = Object.keys(d).filter((dk) => !allowed.includes(dk));
      for (const dk of bad) problems.push(`${file}: ${k}.${n}.${dk}: not a ${k === 'volumes' ? 'volume' : 'network'} setting an archive hands over (no driver, driver options or external one)`);
      interpolated(d, `${file}: ${k}.${n}`, problems);
    }
  }
}

/** A service's keys and values, checked; what it runs collected. */
function service(name: string, v: unknown, at: string, declared: ReadonlySet<string>, problems: string[]): SubsetService {
  const s: SubsetService = { name, env_files: [], binds: [], volumes: [], ports: [], keys: [] };
  if (!NAME.test(name)) problems.push(`${at}: a service name of other characters`);
  if (!isObj(v)) {
    problems.push(`${at}: not a mapping`);
    return s;
  }
  for (const [k, x] of Object.entries(v)) {
    const p = `${at}.${k}`;
    if (!SERVICE.has(k)) {
      problems.push(`${p}: not a service setting an archive hands over`);
      continue;
    }
    if (k !== 'environment') interpolated(x, p, problems);
    if (k === 'image' || k === 'pull_policy' || k === 'restart' || k === 'working_dir' || k === 'user' || k === 'platform' || k === 'hostname' || k === 'stop_grace_period') {
      if (!isScalarValue(x) || x === null) problems.push(`${p}: not a plain value`);
      else if (k === 'image') s.image = String(x);
      else if (k === 'pull_policy') s.pull_policy = String(x);
      else s.keys.push(k);
    } else if (k === 'init') {
      if (typeof x !== 'boolean') problems.push(`${p}: not true or false`);
      else s.keys.push(k);
    } else if (k === 'build') {
      if (isStr(x)) s.build = x;
      else if (isObj(x)) {
        for (const b of Object.keys(x)) if (!['context', 'dockerfile', 'args', 'target'].includes(b)) problems.push(`${p}.${b}: not a build setting an archive hands over`);
        s.build = isStr(x.context) ? x.context : '.';
      } else problems.push(`${p}: not a build that reads`);
    } else if (k === 'command' || k === 'entrypoint' || k === 'tmpfs' || k === 'expose') {
      if (!(isScalarValue(x) || (Array.isArray(x) && x.every(isScalarValue)))) problems.push(`${p}: not a value or a list of values`);
      else s.keys.push(k);
    } else if (k === 'environment' || k === 'labels') {
      const ok = Array.isArray(x) ? x.every(isStr) : isObj(x) && Object.values(x).every(isScalarValue);
      if (!ok) problems.push(`${p}: not a map or a list of values`);
      else s.keys.push(k === 'environment' ? `environment (${Array.isArray(x) ? x.length : Object.keys(x as object).length})` : k);
    } else if (k === 'env_file') {
      envFiles(x, p, s, problems);
    } else if (k === 'ports') {
      portsOf(x, p, s, problems);
    } else if (k === 'depends_on') {
      const ok = Array.isArray(x)
        ? x.every(isStr)
        : isObj(x) && Object.values(x).every((d) => d === null || (isObj(d) && Object.keys(d).every((dk) => ['condition', 'restart', 'required'].includes(dk))));
      if (!ok) problems.push(`${p}: not a list or map of services`);
      else s.keys.push(k);
    } else if (k === 'healthcheck') {
      if (!isObj(x) || !Object.keys(x).every((h) => ['test', 'interval', 'timeout', 'retries', 'start_period', 'start_interval', 'disable'].includes(h)))
        problems.push(`${p}: not a healthcheck an archive hands over`);
      else s.keys.push(k);
    } else if (k === 'networks') {
      const ok = Array.isArray(x) ? x.every(isStr) : isObj(x) && Object.values(x).every((n) => n === null || (isObj(n) && Object.keys(n).every((nk) => nk === 'aliases')));
      if (!ok) problems.push(`${p}: not network names (with aliases)`);
      else s.keys.push(k);
    } else if (k === 'volumes') {
      volumesOf(x, p, s, declared, problems);
    }
  }
  return s;
}

/** A compose file read against the subset (the module's header): its services, and every problem with where it is. */
export function readComposeSubset(text: string, file: string): SubsetRead {
  const problems: string[] = [];
  if (/^\s*%/m.test(text)) problems.push(`${file}: a YAML directive (%YAML, %TAG): not in an archive's compose subset`);
  const doc = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: false });
  if (doc.errors.length) return { services: [], problems: [`${file}: does not read as YAML (${doc.errors[0]!.message.split('\n')[0]})`] };
  visit(doc, {
    Alias() {
      problems.push(`${file}: a YAML alias (*…): not in an archive's compose subset`);
    },
    Node(_k, node) {
      if (!isAlias(node) && (node as { anchor?: string }).anchor) problems.push(`${file}: a YAML anchor (&${(node as { anchor?: string }).anchor}): not in an archive's compose subset`);
      const tag = (node as { tag?: string }).tag;
      if (tag) problems.push(`${file}: a YAML tag (${tag}): not in an archive's compose subset`);
    },
    Pair(_k, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === '<<') problems.push(`${file}: a YAML merge key (<<): not in an archive's compose subset`);
    },
  });
  let v: unknown;
  try {
    v = doc.toJS({ maxAliasCount: 0 }) as unknown;
  } catch {
    return { services: [], problems };
  }
  if (!isObj(v)) return { services: [], problems: [...problems, `${file}: not a compose mapping`] };
  for (const k of Object.keys(v)) if (!TOP.has(k)) problems.push(`${file}: ${k}: not a top-level key an archive hands over`);
  for (const k of ['name', 'version']) if (v[k] !== undefined && !isStr(v[k])) problems.push(`${file}: ${k}: not a string`);
  sections(v, file, problems);
  const declared = new Set(isObj(v.volumes) ? Object.keys(v.volumes) : []);
  const services: SubsetService[] = [];
  if (v.services !== undefined && !isObj(v.services)) problems.push(`${file}: services: not a mapping`);
  for (const [name, svc] of Object.entries(isObj(v.services) ? v.services : {})) services.push(service(name, svc, `${file}: services.${name}`, declared, problems));
  return { services, problems };
}
