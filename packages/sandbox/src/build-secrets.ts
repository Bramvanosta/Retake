/**
 * Field feedback 2, point 30: the build secrets of a docker-compose sandbox's `up`. A compose file mounts a build
 * secret read from a variable (`secrets: {NPM_TOKEN: {environment: NPM_TOKEN}}`, a service's `build.secrets`, the
 * Dockerfile's `RUN --mount=type=secret,id=NPM_TOKEN,env=NPM_TOKEN`); docker compose passes it EMPTY, without a word,
 * when that variable is unset or empty in its environment (and its env file), and the build step that reads it fails
 * with one line. A job of the Studio, the desktop app or an MCP client never has a registry token of the person's
 * shell (engine worker-env WORKER_ENV_DROPPED, core agent-env childEnv), and an app opened from the Finder has no shell
 * profile at all.
 *
 * sandbox.yaml `compose.secrets` names them: `{NAME: "{{env:VAR}}" | "{{keychain:service/account}}" | false}`
 * (`false`: an optional build secret, which may stay empty). Before the up command:
 * - every name of `compose.secrets` must be read by a build secret (`secrets.<id>.environment` with `<id>` in a
 *   service's `build.secrets`), never by a secret a service mounts in its running container (its own `secrets:`), and
 *   its value may reach nothing else: `docker compose config` is read once more with a marker value for each name,
 *   and a marker anywhere in it (a container's `environment`, a build argument, a `${NAME}` of any compose file, an
 *   included one or the env file) refuses the up — every other compose command (ps, down, logs) reads the files
 *   without the value;
 * - the services this up builds (`--build`: every service with a `build:`; without it, those with
 *   `pull_policy: build` or whose image is not on this machine — docker compose builds those whatever their pull
 *   policy) and the variables their build secrets read are found; only the `compose.secrets` references those need
 *   are resolved (a plain up from the app, with images built beforehand, never reaches the keychain nor fails on a
 *   variable it does not need);
 * - each such variable must be non-empty for docker compose — `compose.secrets`' value, else the env file's, else the
 *   environment docker runs with — unless declared optional, or the up is refused, leading with the way that works
 *   from everywhere (a keychain reference). A value shorter than 3 characters is refused too: it could not be masked.
 * The values travel in the environment of the `up` command only (never argv, a file or another compose command), and
 * every line and message of that up is masked with them.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { collectSecretRefs, errorMessage } from '@retake/core/base';
import { envFileValues } from '@retake/core/sandbox';
import type { ComposeConfig } from './compose-parse.js';
import type { ComposeProjectRef } from './compose-project.js';
import { masker } from './seed.js';
import { SandboxError } from './errors.js';
import type { ProviderContext } from './provider.js';

/** What `up` hands docker compose for its build secrets, and how its output and messages are masked. */
export interface BuildSecrets {
  /** The values of `compose.secrets` this up needs, by name: added to the up command's environment only. */
  env: Record<string, string>;
  /** Masks every value a build secret of this up reads (declared, from the env file, inherited). */
  mask: (text: string) => string;
  /** The services this up builds among those whose build secrets read a variable (each one checked). */
  built: string[];
}

/** What the check reads besides the config: the images on this machine, the environment docker runs with. */
export interface BuildSecretsDeps {
  /** Whether an image is on this machine (`docker image inspect`). */
  hasImage: (image: string) => Promise<boolean>;
  /** `docker compose config --format json` with these variables added to its environment: its output. */
  configWith: (env: Record<string, string>) => Promise<string>;
  /** The environment docker compose runs with, before `compose.secrets` (core dockerEnv under the work's policy). */
  inherited: NodeJS.ProcessEnv;
  /** The work runs under the agent policy (a job of the Studio, the desktop app or an MCP client). */
  agent: boolean;
}

/** A shorter value cannot be masked (core secretForms): refused rather than printed. */
export const BUILD_SECRET_MIN_LENGTH = 3;

const NO_MASK = (text: string) => text;

/** The services this up builds: under `--build` every service with a build; else `pull_policy: build` ones and missing images. */
async function builtServices(cfg: ComposeConfig, build: boolean, deps: BuildSecretsDeps): Promise<string[]> {
  const services = Object.keys(cfg.builds);
  const built = await Promise.all(services.map(async (s) => build || cfg.pulls[s] === 'build' || !(await deps.hasImage(cfg.images[s]))));
  return services.filter((_, i) => built[i]);
}

/** How to give a build secret, for every refusal: the keychain first (it works from the Studio, the app and MCP alike). */
function howToGive(name: string, agent: boolean): string {
  const lines = [
    `give it in sandbox.yaml: \`compose.secrets: {${name}: "{{keychain:<service>/<account>}}"}\` — works from a terminal, the Studio, the app and MCP alike (\`security add-generic-password -s <service> -a <account> -w\` stores it) — or \`"{{env:${name}}}"\`; \`${name}: false\` if the build does without it`,
  ];
  if (agent) {
    lines.push(
      `a jobs worker the Studio, the app or an MCP client starts never has a registry or code-host token of your shell (NPM_TOKEN, GITHUB_TOKEN…) unless RETAKE_WORKER_KEEP_ENV=${name} is set where that client starts; an app opened from the Finder has no shell profile: use the keychain`,
    );
  }
  lines.push('an image once built with an empty secret stays in the build cache: `docker compose build --no-cache <service>` after the fix');
  return lines.map((l) => `\n  — ${l}`).join('');
}

/** The names of `compose.secrets` checked against the compose files (see the module comment). Throws SandboxError. */
async function checkDeclared(where: string, declared: Record<string, string | false>, cfg: ComposeConfig, deps: BuildSecretsDeps): Promise<void> {
  const buildIds = new Set(Object.values(cfg.builds).flat());
  const readByBuild = new Set(Object.entries(cfg.secretEnv).flatMap(([id, variable]) => (buildIds.has(id) ? [variable] : [])));
  for (const name of Object.keys(declared)) {
    if (!readByBuild.has(name)) {
      throw new SandboxError(
        `${where}: compose.secrets.${name} — no build secret of the compose files reads ${name} (a top-level \`secrets: {<id>: {environment: ${name}}}\` mounted by a service's \`build.secrets\`): compose.secrets holds build secrets only — remove it, or declare the secret in the compose file`,
      );
    }
    for (const [service, ids] of Object.entries(cfg.runtimeSecrets)) {
      const id = ids.find((i) => cfg.secretEnv[i] === name);
      if (id !== undefined) {
        throw new SandboxError(
          `${where}: compose.secrets.${name} — service ${service} mounts secret ${id} (read from ${name}) in its running container (its own \`secrets:\`): the value would be in that container at /run/secrets/${id} — compose.secrets holds build secrets only: mount it in \`build.secrets\` alone`,
        );
      }
    }
  }
  // A marker value for each name: wherever docker compose puts it, the real value would go too.
  const markers = Object.fromEntries(Object.entries(declared).flatMap(([name, v]) => (v === false ? [] : [[name, `retake-marker-${randomBytes(8).toString('hex')}`]])));
  if (!Object.keys(markers).length) return;
  const text = await deps.configWith(markers);
  for (const [name, marker] of Object.entries(markers)) {
    if (text.includes(marker)) {
      throw new SandboxError(
        `${where}: compose.secrets.${name} — the compose files put ${name}'s value outside a build secret (a container's \`environment\`, a build argument, or a \`\${${name}}\` in a compose file, an included one or the env file): it would reach a running container or an image's history — read it through a build secret only (\`secrets.<id>.environment: ${name}\`, \`RUN --mount=type=secret\`)`,
      );
    }
  }
}

/**
 * The build secrets of this up, checked (see the module comment). Throws SandboxError before anything is built; the
 * values never appear in a message.
 */
export async function buildSecrets(ctx: ProviderContext, ref: ComposeProjectRef, cfg: ComposeConfig, build: boolean, deps: BuildSecretsDeps): Promise<BuildSecrets> {
  const where = `sandbox ${ctx.sandbox.env}`;
  const declared = ctx.sandbox.manifest.compose?.secrets ?? {};
  await checkDeclared(where, declared, cfg, deps);
  // Only the services whose build reads a variable are looked at (no image inspected for the others).
  const reading: ComposeConfig = { ...cfg, builds: Object.fromEntries(Object.entries(cfg.builds).filter(([, ids]) => ids.some((id) => cfg.secretEnv[id]))) };
  const built = await builtServices(reading, build, deps);
  const needs = new Map<string, Array<{ service: string; id: string }>>();
  for (const service of built) {
    for (const id of cfg.builds[service]) {
      const variable = cfg.secretEnv[id];
      if (variable) needs.set(variable, [...(needs.get(variable) ?? []), { service, id }]);
    }
  }
  if (!needs.size) return { env: {}, mask: NO_MASK, built };
  let fileValues: Record<string, string> | null = {};
  if (ref.envFile) {
    try {
      fileValues = envFileValues(readFileSync(ref.envFile, 'utf8'));
    } catch {
      fileValues = null; // docker compose says so
    }
  }
  const env: Record<string, string> = {};
  const values: string[] = [];
  for (const [variable, uses] of needs) {
    const by = uses.map((u) => `service ${u.service} builds with secret ${u.id}`).join(', ');
    const head = `${where}: ${by}, read from ${variable}`;
    const own = declared[variable];
    let value: string | undefined;
    let from: string;
    if (typeof own === 'string') {
      const refs = [...collectSecretRefs(own)];
      from = `compose.secrets.${variable} (${own.trim()})`;
      try {
        value = refs.length === 1 ? await ctx.resolveSecret(refs[0]) : undefined;
      } catch (e) {
        throw new SandboxError(`${head}: ${from} cannot be read (${errorMessage(e)})${howToGive(variable, deps.agent)}`);
      }
      if (value) env[variable] = value;
    } else if (ref.envKeys?.includes(variable)) {
      value = fileValues?.[variable];
      from = fileValues ? `the env file (${variable}=)` : 'the env file, which cannot be read';
    } else {
      value = deps.inherited[variable];
      from = deps.agent ? 'the environment of this job (it has no such variable unless compose.secrets gives it)' : 'the environment of this command';
    }
    if (!value) {
      if (own === false) continue; // optional: the build does without it
      throw new SandboxError(
        `${head}, which is empty for docker compose (${from}): docker compose would pass the secret empty, and the build step that reads it would fail${howToGive(variable, deps.agent)}`,
      );
    }
    if (value.length < BUILD_SECRET_MIN_LENGTH) throw new SandboxError(`${head}: its value (${from}) is shorter than ${BUILD_SECRET_MIN_LENGTH} characters — it could not be masked in the logs`);
    values.push(value);
  }
  return { env, mask: masker(values), built };
}
