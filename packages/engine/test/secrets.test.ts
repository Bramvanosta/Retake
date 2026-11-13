/**
 * The Secrets port (src/secrets/): its contract on the product's adapter and the memory one; the ports bag's default
 * resolving on the environment its root hands; no silent fallback to this process's environment where a secret is
 * filled in (core interpolate, core io prefetchSecrets).
 */
import { describe, expect, it } from 'vitest';
import { TemplateError, interpolate } from '@retake/core';
import { prefetchSecrets } from '@retake/core/io';
import { MemorySecrets, enginePorts } from '../src/index.js';
import { systemSecrets } from '../src/secrets/system-secrets.js';
import { secretsContract } from './secrets-contract.js';

const envOf = (values: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(values).map(([k, v]) => [k.slice('env:'.length), v]));

secretsContract('system (on an environment handed)', (values) => systemSecrets(envOf(values)));
secretsContract('memory', (values) => new MemorySecrets(values));

describe('the Secrets port in the ports bag', () => {
  it("the default resolves on the environment the root hands, not this process's", async () => {
    const name = 'RETAKE_SECRETS_TEST_ONLY_HANDED';
    expect(process.env[name]).toBeUndefined();
    const ports = enginePorts({ env: { [name]: 'from-the-root' } });
    expect(await ports.secrets.resolve(`env:${name}`)).toBe('from-the-root');
    await expect(enginePorts({ env: {} }).secrets.resolve('env:HOME')).rejects.toThrow('environment variable HOME is not set');
    const given = new MemorySecrets();
    expect(enginePorts({ secrets: given }).secrets).toBe(given);
  });

  it('a secret reference is filled in by a resolver only: without one it is refused, never read from this process', async () => {
    expect(process.env.HOME).toBeDefined();
    expect(() => interpolate('{{env:HOME}}', {})).toThrow(TemplateError);
    expect(() => interpolate('{{env:HOME}}', {})).toThrow('{{env:HOME}} is a secret reference and no secret resolver was handed here');
    expect(interpolate('a {{env:X}}', { secrets: (ref) => (ref === 'env:X' ? 'x' : undefined) })).toBe('a x');
    // prefetchSecrets' resolver knows the references it resolved, through the resolver handed; no other.
    const asked = new MemorySecrets({ 'env:A': 'a' });
    const { resolver, values } = await prefetchSecrets({ url: '{{env:A}}' }, (ref) => asked.resolve(ref));
    expect([resolver('env:A'), values]).toEqual(['a', ['a']]);
    expect(resolver('env:HOME')).toBeUndefined();
    expect(asked.asked).toEqual(['env:A']);
  });
});
