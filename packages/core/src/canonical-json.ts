/**
 * JSON with object keys sorted at every level (code-unit order), undefined properties left out, arrays in their order:
 * a value's one canonical text. The input of the tool's hashes and fingerprints (hook approvals, sandbox seeds, steps,
 * job signatures) and of the scenario snapshot comparison — test/canonical-json.test.ts freezes them.
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
