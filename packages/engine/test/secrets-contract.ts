/**
 * The Secrets port's contract (src/secrets/secrets.ts): what every adapter does with a reference — run on the
 * product's (system-secrets.ts, over an environment the test hands: no keychain item is read) and the memory one
 * (secrets.test.ts). The refusals are core's TemplateError in the words of core io resolveSecretRef.
 */
import { describe, expect, it } from 'vitest';
import { TemplateError } from '@retake/core';
import type { Secrets } from '../src/index.js';

/** `make(values)`: an adapter that knows the `env:` references of `values` (`env:VAR` → value) and nothing else. */
export function secretsContract(adapter: string, make: (values: Record<string, string>) => Secrets): void {
  describe(`the Secrets contract: ${adapter}`, () => {
    it('an env: reference is its value; `secret:` before it is the same reference', async () => {
      const s = make({ 'env:SHOP_TOKEN': 's3cret', 'env:EMPTY': '' });
      expect(await s.resolve('env:SHOP_TOKEN')).toBe('s3cret');
      expect(await s.resolve('secret:env:SHOP_TOKEN')).toBe('s3cret');
      expect(await s.resolve('env:EMPTY')).toBe('');
    });

    it('a variable not set is refused (a TemplateError naming it)', async () => {
      const s = make({});
      const e = await s.resolve('env:RETAKE_CONTRACT_NOT_SET').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as Error).message).toBe('environment variable RETAKE_CONTRACT_NOT_SET is not set');
    });

    it('a reference of no known kind is refused, in the same words', async () => {
      const e = await make({})
        .resolve('vault:a/b')
        .catch((x: unknown) => x);
      expect(e).toBeInstanceOf(TemplateError);
      expect((e as Error).message).toBe('unsupported secret reference "vault:a/b" (use env:VAR or keychain:service/account)');
    });
  });
}
