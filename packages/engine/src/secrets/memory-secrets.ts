/**
 * The Secrets port in memory (secrets.ts), for tests: the references it is given (`env:VAR`, `keychain:service/account`
 * → value); any other is refused in the product's words (core TemplateError), and every lookup is listed (`asked`).
 */
import { TemplateError } from '@retake/core/base';
import type { Secrets } from './secrets.js';

export class MemorySecrets implements Secrets {
  readonly asked: string[] = [];

  constructor(private readonly values: Readonly<Record<string, string>> = {}) {}

  async resolve(ref: string): Promise<string> {
    const r = ref.startsWith('secret:') ? ref.slice(7) : ref;
    this.asked.push(r);
    if (Object.hasOwn(this.values, r)) return this.values[r]!;
    if (r.startsWith('env:')) throw new TemplateError(`environment variable ${r.slice(4)} is not set`);
    if (r.startsWith('keychain:')) {
      const spec = r.slice('keychain:'.length);
      throw new TemplateError(`keychain item ${spec} not found (not among the test's secrets)`);
    }
    throw new TemplateError(`unsupported secret reference "${r}" (use env:VAR or keychain:service/account)`);
  }
}
