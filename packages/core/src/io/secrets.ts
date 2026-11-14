/**
 * Secret references resolved where they are used: `{{env:VAR}}` from this process's environment, `{{keychain:…}}`
 * from the system's keychain (`security` on macOS, `secret-tool` elsewhere).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TemplateError, collectSecretRefs } from '../templating.js';
import type { SecretResolver } from '../templating.js';

const execFileP = promisify(execFile);

/**
 * Resolve one secret reference:
 *  - env:VAR
 *  - keychain:service/account → macOS `security find-generic-password -s service -a account -w`,
 *    Linux `secret-tool lookup service <service> account <account>`.
 */
export async function resolveSecretRef(ref: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  if (ref.startsWith('secret:')) ref = ref.slice(7);
  if (ref.startsWith('env:')) {
    const v = env[ref.slice(4)];
    if (v === undefined) throw new TemplateError(`environment variable ${ref.slice(4)} is not set`);
    return v;
  }
  if (ref.startsWith('keychain:')) {
    const spec = ref.slice('keychain:'.length);
    const slash = spec.indexOf('/');
    const service = slash >= 0 ? spec.slice(0, slash) : spec;
    const account = slash >= 0 ? spec.slice(slash + 1) : '';
    try {
      if (process.platform === 'darwin') {
        const args = ['find-generic-password', '-s', service, '-w'];
        if (account) args.splice(3, 0, '-a', account);
        const { stdout } = await execFileP('security', args);
        return stdout.replace(/\n$/, '');
      }
      const args = ['lookup', 'service', service];
      if (account) args.push('account', account);
      const { stdout } = await execFileP('secret-tool', args);
      return stdout.replace(/\n$/, '');
    } catch (e) {
      // One line: the tool's own reason (its last stderr line, without the "security: SecKeychain…:" prefixes).
      const err = e as NodeJS.ErrnoException & { stderr?: string };
      const tool = process.platform === 'darwin' ? 'security' : 'secret-tool';
      const said = (err.stderr ?? '').trim().split('\n').pop()?.split(': ').pop()?.trim();
      const why = err.code === 'ENOENT' ? `${tool} is not installed` : said || `${tool} exited with code ${String(err.code)}`;
      throw new TemplateError(`keychain item ${service}${account ? '/' + account : ''} not found (${why})`);
    }
  }
  throw new TemplateError(`unsupported secret reference "${ref}" (use env:VAR or keychain:service/account)`);
}

/**
 * Resolve every secret ref of `value` (through `resolve`: default resolveSecretRef on this process's environment) and
 * return a synchronous resolver for interpolate() that knows those refs only (another is unresolved, never read on the way).
 */
export async function prefetchSecrets(value: unknown, resolve: (ref: string) => Promise<string> = resolveSecretRef): Promise<{ resolver: SecretResolver; values: string[] }> {
  const refs = collectSecretRefs(value);
  const map = new Map<string, string>();
  for (const ref of refs) map.set(ref, await resolve(ref));
  return { resolver: (ref) => map.get(ref), values: [...map.values()] };
}
