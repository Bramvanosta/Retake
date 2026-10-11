import type { LoadedProject, ResolvedEnvironment } from './types.js';

export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/** Pick an environment: explicit name → project.default_env → the first one declared. */
export function resolveEnvironment(project: Pick<LoadedProject, 'config'>, env?: string): ResolvedEnvironment {
  const envs = project.config.environments ?? {};
  const names = Object.keys(envs);
  const name = env ?? project.config.default_env ?? names[0];
  if (!name) throw new EnvironmentError('project has no environments');
  const pages = envs[name];
  if (!pages) throw new EnvironmentError(`unknown environment "${name}" (available: ${names.join(', ') || 'none'})`);
  return { name, pages: { ...pages } };
}

/** Hosts declared by every environment of the project (lower-case hostnames). */
export function environmentHosts(project: Pick<LoadedProject, 'config'>): string[] {
  const hosts = new Set<string>();
  for (const pages of Object.values(project.config.environments ?? {})) {
    for (const url of Object.values(pages)) {
      try {
        hosts.add(new URL(url).hostname.toLowerCase());
      } catch {
        /* ignore malformed */
      }
    }
  }
  return [...hosts];
}
