/**
 * The ComponentRegistries port in memory (registries.ts), for tests: the registries it is given, by workspace root —
 * and by project folder (a project's registry, `load(root, {projectDir})`: the one given for that folder, else the
 * root's); a root it was not given is refused (an Error naming it), as the package's reader refuses a workspace it cannot read.
 * Every load is listed (`loads`), and the same registry object comes back each time (the package's reads the folders
 * again). Its catalogue answers what it was given by folder (`catalogue`: validations, preview states, source files);
 * a folder it was not given is no component (`validate`: not ok, one error), has no preview (`missing`) and no source
 * file; a scaffold writes a manifest, an entry and a README through the caller's `write` — no template is read, no code
 * compiled — under `<root>/components` (or `componentsDir`), refusing an id that is not "namespace/name" and a folder
 * it made before. Every catalogue call is listed (`asked`). The same contract runs on both adapters
 * (engine/test/registries-contract.ts).
 */
import { join, resolve } from 'node:path';
import { COMPONENT_ID_RE } from '@retake/core/model';
import type { ComponentCatalogue, ComponentRegistries } from './registries.js';
import type { ComponentManifest, ComponentRegistry, ComponentValidation, CreatedComponent, PreviewStatus, RegistryScope } from '@retake/components/geometry';

/** What a MemoryRegistries' catalogue answers, by component folder. */
export interface MemoryCatalogueSeed {
  validations?: Readonly<Record<string, ComponentValidation>>;
  previews?: Readonly<Record<string, PreviewStatus>>;
  files?: Readonly<Record<string, readonly string[]>>;
}

export class MemoryRegistries implements ComponentRegistries {
  /** The roots asked, in order (resolved). */
  readonly loads: string[] = [];
  /** The project folders asked with them, in order (resolved; '' for a workspace's registry). */
  readonly projects: string[] = [];
  /** The catalogue's calls, in order (`<member> <folder or root>`). */
  readonly asked: string[] = [];
  readonly #byRoot = new Map<string, ComponentRegistry>();
  readonly #made = new Set<string>();
  readonly catalogue: ComponentCatalogue;

  constructor(byRoot: Readonly<Record<string, ComponentRegistry>> = {}, seed: MemoryCatalogueSeed = {}) {
    for (const [root, registry] of Object.entries(byRoot)) this.#byRoot.set(resolve(root), registry);
    const at = <T>(m: Readonly<Record<string, T>> | undefined, dir: string): T | undefined => {
      const d = resolve(dir);
      return Object.entries(m ?? {}).find(([k]) => resolve(k) === d)?.[1];
    };
    this.catalogue = {
      validate: async (dir) => {
        this.asked.push(`validate ${resolve(dir)}`);
        return (
          at(seed.validations, dir) ?? {
            dir: resolve(dir),
            ok: false,
            issues: [{ severity: 'error', file: 'component.yaml', path: [], message: "component.yaml not found (not among the test's components)" }],
          }
        );
      },
      previewStatus: async (dir) => {
        this.asked.push(`previewStatus ${resolve(dir)}`);
        return at(seed.previews, dir) ?? { state: 'missing', reason: 'preview.png is missing', hash: '' };
      },
      sourceFiles: async (dir) => {
        this.asked.push(`sourceFiles ${resolve(dir)}`);
        return [...(at(seed.files, dir) ?? [])];
      },
      create: async (root, opts) => {
        this.asked.push(`create ${resolve(root)}`);
        if (!COMPONENT_ID_RE.test(opts.id)) throw new Error(`invalid component id "${opts.id}": use "namespace/name"`);
        const [ns, name] = opts.id.split('/') as [string, string];
        const dir = join(resolve(opts.componentsDir ?? join(root, 'components')), ns, name);
        if (this.#made.has(dir)) throw new Error(`${dir} already exists: pick another id or edit that component`);
        this.#made.add(dir);
        const manifest = { id: opts.id, kind: opts.kind, version: '0.1.0', name: opts.name ?? name, description: opts.description ?? `A ${opts.kind}.`, slots: {} } as unknown as ComponentManifest;
        const texts: Array<[string, string]> = [
          ['component.yaml', `id: ${opts.id}\nkind: ${opts.kind}\nversion: 0.1.0\nname: ${manifest.name}\ndescription: ${manifest.description}\n`],
          ['index.tsx', 'export default function Component() {\n  return null;\n}\n'],
          ['README.md', `# ${manifest.name}\n`],
        ];
        const files: string[] = [];
        for (const [file, text] of texts) {
          await opts.write(join(dir, file), text);
          files.push(join(dir, file));
        }
        const created: CreatedComponent = { manifest, dir, entry: join(dir, 'index.tsx'), source: opts.source ?? 'workspace', files, issues: [] };
        return created;
      },
    };
  }

  async load(root: string, o?: RegistryScope): Promise<ComponentRegistry> {
    const at = resolve(root);
    this.loads.push(at);
    const project = o?.projectDir === undefined ? '' : resolve(o.projectDir);
    this.projects.push(project);
    const registry = (project ? this.#byRoot.get(project) : undefined) ?? this.#byRoot.get(at);
    if (!registry) throw new Error(`no component registry for the workspace ${at} (not among the test's registries)`);
    return registry;
  }
}

/** A registry with no component (a test's stand-in where none is read: an in-memory render, a fake review). */
export function emptyRegistry(componentsDir = '/components'): ComponentRegistry {
  const none = (id: string): never => {
    throw new Error(`component "${id}" not found (an empty registry)`);
  };
  return {
    componentsDir,
    notices: [],
    list: () => [],
    has: () => false,
    get: none,
    resolve: (ref) => none(typeof ref === 'string' ? ref : ref.id),
    resolveTheme: () => {
      throw new Error('an empty registry resolves no theme');
    },
  };
}
