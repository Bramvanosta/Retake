/**
 * R-ENV-06 / R-ENV-07: project.yaml's environments edited as text — only the range of the node changed moves, byte for
 * byte (comments, CRLF, a 4-space indent), the result read back and compared — and what in a change needs a person.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { EnvironmentEditError, editEnvironment, environmentEditAsks, environmentEditLines, pageOrigin, removeEnvironment } from '../src/index.js';
import type { EnvironmentEdit } from '../src/index.js';

const crlf = (lines: string[]) => lines.map((l) => `${l}\r\n`).join('');

/** A CRLF file with a 4-space indent, comments everywhere and a flow page. */
const FILE = crlf([
  '# Retake project "northfield"',
  'version: 1',
  'name: Northfield',
  'environments:     # where the videos are filmed',
  '    local:',
  '        console: http://localhost:4401   # the console',
  '        # the shop, shown under its public name',
  '        shop: {url: http://localhost:4402, display: shop.example.com}',
  '    staging:',
  '        production: true',
  '        pages:',
  '            console: https://console.staging.example.com',
  '        read_only:',
  '            hosts: [api.staging.example.com]',
  '    # more environments go here',
  'default_env: local   # the usual one',
  'capture:',
  '    width: 1280',
]);

const js = (text: string) => parseDocument(text).toJS() as Record<string, unknown>;

describe('environments edited as text (R-ENV-06)', () => {
  it('adds an environment in short form after the last one: every other byte (comments, CRLF, 4 spaces) is the file as it was', () => {
    const e = editEnvironment(FILE, 'demo', { pages: { console: 'http://localhost:4401', shop: { url: 'http://localhost:4402', display: 'shop.example.com' } } }, 'add');
    expect(e.action).toBe('added');
    // Right after staging's last line, before the comment that closes the block: every other byte as it was.
    const at = FILE.indexOf('[api.staging.example.com]\r\n') + '[api.staging.example.com]\r\n'.length;
    const block = crlf(['    demo:', '        console: http://localhost:4401', '        shop: {url: http://localhost:4402, display: shop.example.com}']);
    expect(e.text).toBe(FILE.slice(0, at) + block + FILE.slice(at));
    expect((js(e.text).environments as Record<string, unknown>).demo).toEqual({ console: 'http://localhost:4401', shop: { url: 'http://localhost:4402', display: 'shop.example.com' } });
  });

  it('marks production: the short form becomes the long form, the page lines and their comments one level deeper, the rest untouched', () => {
    const e = editEnvironment(FILE, 'local', { production: true }, 'set');
    const start = FILE.indexOf('    local:\r\n') + '    local:\r\n'.length;
    const end = FILE.indexOf('    staging:');
    expect(e.text.slice(0, start)).toBe(FILE.slice(0, start));
    expect(e.text.slice(e.text.indexOf('    staging:'))).toBe(FILE.slice(end));
    expect(e.text.slice(start, e.text.indexOf('    staging:'))).toBe(
      crlf([
        '        production: true',
        '        pages:',
        '            console: http://localhost:4401   # the console',
        '            # the shop, shown under its public name',
        '            shop: {url: http://localhost:4402, display: shop.example.com}',
      ]),
    );
    expect(e.after).toEqual({ pages: { console: { url: 'http://localhost:4401' }, shop: { url: 'http://localhost:4402', display: 'shop.example.com' } }, production: true });
  });

  it("changes a page's URL in place (its comment stays), adds and removes pages, and keeps read_only as it is", () => {
    const e = editEnvironment(FILE, 'local', { pages: { console: 'http://localhost:4411' } }, 'set');
    expect(e.text).toBe(FILE.replace('console: http://localhost:4401   # the console', 'console: http://localhost:4411   # the console'));
    const s = editEnvironment(FILE, 'staging', { pages: { shop: 'https://shop.staging.example.com' } }, 'set');
    expect(s.text).toBe(FILE.replace('            console: https://console.staging.example.com\r\n', '            console: https://console.staging.example.com\r\n            shop: https://shop.staging.example.com\r\n'));
    const r = editEnvironment(FILE, 'local', { remove_pages: ['shop'] }, 'set');
    expect(r.text).toBe(FILE.replace('        shop: {url: http://localhost:4402, display: shop.example.com}\r\n', ''));
    expect((js(s.text).environments as Record<string, { read_only: unknown }>).staging.read_only).toEqual({ hosts: ['api.staging.example.com'] });
  });

  it('removes an environment, and default_env with it when it named it; default: true moves default_env in place', () => {
    const r = removeEnvironment(FILE, 'local');
    expect(r.text).toBe(
      FILE.replace(crlf(['    local:', '        console: http://localhost:4401   # the console', '        # the shop, shown under its public name', '        shop: {url: http://localhost:4402, display: shop.example.com}']), '').replace(
        'default_env: local   # the usual one\r\n',
        '',
      ),
    );
    expect(r.default_before).toBe('local');
    expect(r.default_after).toBe('staging');
    const d = editEnvironment(FILE, 'staging', { default: true }, 'set');
    expect(d.text).toBe(FILE.replace('default_env: local   # the usual one', 'default_env: staging   # the usual one'));
    const off = editEnvironment(FILE, 'local', { default: false }, 'set');
    expect(off.text).toBe(FILE.replace('default_env: local   # the usual one\r\n', ''));
  });

  it('writes default_env after environments when the file has none, and creates environments at the end when it is missing', () => {
    const text = 'version: 1\nname: N\nenvironments:\n  local:\n    app: http://localhost:4401\ncapture:\n  width: 1280\n';
    const d = editEnvironment(text, 'demo', { pages: { app: 'http://localhost:4401' }, default: true }, 'upsert');
    expect(d.text).toBe('version: 1\nname: N\nenvironments:\n  local:\n    app: http://localhost:4401\n  demo:\n    app: http://localhost:4401\ndefault_env: demo\ncapture:\n  width: 1280\n');
    const none = editEnvironment('version: 1\nname: N\nsandboxes:\n  sandbox: sandbox/sandbox.yaml\n', 'local', { pages: { app: 'http://localhost:4401' } }, 'add');
    expect(none.text).toBe('version: 1\nname: N\nsandboxes:\n  sandbox: sandbox/sandbox.yaml\nenvironments:\n  local:\n    app: http://localhost:4401\n');
  });

  it('writes an environment of a flow layout again whole, in block form at its own place', () => {
    const text = 'version: 1\nname: N\nenvironments:\n  local: {app: http://localhost:4401}   # one line\n  other:\n    app: http://localhost:4409\n';
    const e = editEnvironment(text, 'local', { production: true }, 'set');
    expect(e.text).toBe('version: 1\nname: N\nenvironments:\n  local:\n    production: true\n    pages:\n      app: http://localhost:4401\n  other:\n    app: http://localhost:4409\n');
  });

  it('refuses an alias, an anchor or a merge key where the edit lands, a missing environment for set and an existing one for add', () => {
    const anchored = 'version: 1\nname: N\nenvironments:\n  local: &pages\n    app: http://localhost:4401\n  demo: *pages\n';
    expect(() => editEnvironment(anchored, 'local', { production: true }, 'set')).toThrow(/alias, an anchor or a merge key/);
    expect(() => editEnvironment(anchored, 'demo', { production: true }, 'set')).toThrow(/alias, an anchor or a merge key/);
    const merged = 'version: 1\nname: N\nbase: &b {app: http://localhost:4401}\nenvironments:\n  local:\n    <<: *b\n';
    expect(() => editEnvironment(merged, 'local', { pages: { shop: 'http://localhost:4402' } }, 'set')).toThrow(/alias, an anchor or a merge key/);
    // An anchor elsewhere does not matter.
    const elsewhere = 'version: 1\nname: N\nvars: &v {a: b}\nenvironments:\n  local:\n    app: http://localhost:4401\n';
    expect(editEnvironment(elsewhere, 'local', { production: true }, 'set').action).toBe('changed');
    const err = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof EnvironmentEditError ? e.kind : 'other';
      }
      return 'none';
    };
    expect(err(() => editEnvironment(FILE, 'qa', { production: true }, 'set'))).toBe('not_found');
    expect(err(() => editEnvironment(FILE, 'local', { production: true }, 'add'))).toBe('conflict');
    expect(err(() => editEnvironment(FILE, 'local', { remove_pages: ['nope'] }, 'set'))).toBe('not_found');
    expect(err(() => removeEnvironment(FILE, 'qa'))).toBe('not_found');
  });

  it('refuses a result that does not read back as the input with only that change: nothing half-written', () => {
    // The whole document indented: a new top-level key at column 0 would not read back.
    const indented = '  version: 1\n  name: N\n  sandboxes:\n    sandbox: sandbox/sandbox.yaml\n';
    expect(() => editEnvironment(indented, 'local', { pages: { app: 'http://localhost:4401' } }, 'add')).toThrow(/could not be edited without changing something else: edit it by hand/);
  });

  it('production off keeps the read-only access it implied; only what was asked changes', () => {
    const e = editEnvironment(FILE, 'staging', { production: false }, 'set');
    expect(e.after).toMatchObject({ production: false, access: 'read-only' });
    expect(e.text).toBe(FILE.replace('        production: true\r\n', '        access: read-only\r\n        production: false\r\n'));
  });

  it('refuses an environment without pages, a number for a name (it would become the default) and a URL holding ",display="', () => {
    expect(() => editEnvironment(FILE, 'local', { remove_pages: ['console', 'shop'] }, 'set')).toThrow(/would have no page left: remove the environment instead/);
    expect(() => editEnvironment(FILE, 'demo', { production: true }, 'add')).toThrow(/needs at least one page/);
    expect(() => editEnvironment(FILE, '2026', { pages: { console: 'http://localhost:4401' } }, 'add')).toThrow(/is a number/);
    expect(() => editEnvironment(FILE, 'demo', { pages: { console: 'http://localhost:4401/?a=1,display=x' } }, 'add')).toThrow(/",display="/);
  });

  it('inserted lines take the line endings of the lines around them, not of a CRLF elsewhere in the file', () => {
    const mixed = 'version: 1\r\nname: N\nenvironments:\n  local:\n    app: http://localhost:4401\n';
    const e = editEnvironment(mixed, 'demo', { pages: { app: 'http://localhost:4401' }, default: true }, 'add');
    expect(e.text).toBe('version: 1\r\nname: N\nenvironments:\n  local:\n    app: http://localhost:4401\n  demo:\n    app: http://localhost:4401\ndefault_env: demo\n');
  });

  it('a change that changes nothing writes nothing', () => {
    const e = editEnvironment(FILE, 'staging', { production: true }, 'set');
    expect(e.action).toBe('unchanged');
    expect(e.text).toBe(FILE);
  });
});

describe('what in an environment change needs a person (R-ENV-07)', () => {
  const origins = ['http://localhost:4401', 'http://localhost:4402', 'https://console.staging.example.com'].map((u) => pageOrigin(u)!);
  const kinds = (e: EnvironmentEdit) => environmentEditAsks(e, origins).map((a) => a.kind);

  it('compares origins normalised: scheme, case, trailing dot, punycode and default ports', () => {
    expect(pageOrigin('HTTP://Stg.Example.com./a')).toBe('http://stg.example.com:80');
    expect(pageOrigin('https://console.staging.example.com:443/x')).toBe(pageOrigin('https://Console.Staging.Example.com.'));
    expect(pageOrigin('https://bücher.example')).toBe('https://xn--bcher-kva.example:443');
    expect(pageOrigin('http://console.staging.example.com')).not.toBe(pageOrigin('https://console.staging.example.com'));
    expect(pageOrigin('ftp://x.example.com')).toBeNull();
    expect(pageOrigin('HTTPS://X.example.com')).toBe('https://x.example.com:443');
  });

  it.each<[string, () => EnvironmentEdit, string[]]>([
    ['the same origins with another display', () => editEnvironment(FILE, 'demo', { pages: { console: { url: 'http://localhost:4401/', display: 'console.example.com' } } }, 'add'), []],
    ['an origin written another way', () => editEnvironment(FILE, 'demo', { pages: { console: 'https://CONSOLE.staging.example.com.:443/' } }, 'add'), []],
    ['a new host', () => editEnvironment(FILE, 'demo', { pages: { console: 'https://console.example.com' } }, 'add'), ['new_origin']],
    ['a new port', () => editEnvironment(FILE, 'local', { pages: { console: 'http://localhost:4409' } }, 'set'), ['new_origin']],
    ['marking production (tightening)', () => editEnvironment(FILE, 'local', { production: true, access: 'read-only' }, 'set'), []],
    ['a display on a protected environment', () => editEnvironment(FILE, 'staging', { pages: { console: { url: 'https://console.staging.example.com', display: 'console.example.com' } } }, 'set'), []],
    ['production removed (its read-only access stays)', () => editEnvironment(FILE, 'staging', { production: false }, 'set'), ['lowers']],
    [
      'a new production environment that allows writes',
      () => editEnvironment(FILE, 'demo', { pages: { console: 'http://localhost:4401' }, production: true, access: 'read-write' }, 'add'),
      ['lowers'],
    ],
    ['production with access read-write given to a read-write one', () => editEnvironment(FILE, 'local', { production: true, access: 'read-write' }, 'set'), ['lowers']],
    ['read-write on production', () => editEnvironment(FILE, 'staging', { access: 'read-write' }, 'set'), ['lowers']],
    ['a protected environment removed', () => removeEnvironment(FILE, 'staging'), ['lowers']],
    ['a page of a protected environment moved', () => editEnvironment(FILE, 'staging', { pages: { console: 'https://console.staging.example.com/v2' } }, 'set'), ['lowers']],
    ['default_env moved onto production', () => editEnvironment(FILE, 'staging', { default: true }, 'set'), ['default']],
    ['the default removed, a production one becomes the implicit default', () => removeEnvironment(FILE, 'local'), ['default']],
    ['sign-in details added to a page URL', () => editEnvironment(FILE, 'local', { pages: { console: 'http://demo:secret@localhost:4401' } }, 'set'), ['userinfo']],
  ])('%s', (_title, edit, expected) => {
    expect(kinds(edit())).toEqual(expected);
  });

  it('a first environment removed makes the next one the implicit default: asked when that one is protected', () => {
    const text = 'version: 1\nname: N\nenvironments:\n  local:\n    app: http://localhost:4401\n  prod:\n    production: true\n    pages:\n      app: https://app.example.com\n';
    const e = removeEnvironment(text, 'local');
    expect([e.default_before, e.default_after, e.default_protected_after]).toEqual(['local', 'prod', true]);
    expect(environmentEditAsks(e, ['http://localhost:4401', 'https://app.example.com'].map((u) => pageOrigin(u)!)).map((a) => a.kind)).toEqual(['default']);
  });

  it('the lines of a change never show a user:password@ and say the default before and after', () => {
    const e = editEnvironment(FILE, 'local', { pages: { console: 'http://demo:s3cret@localhost:4401' }, default: false }, 'set');
    const lines = environmentEditLines(e);
    expect(lines.join('\n')).not.toMatch(/s3cret|demo:/);
    expect(lines).toEqual(['change environment local', 'page console: http://localhost:4401 → http://localhost:4401 (with sign-in details)']);
    expect(environmentEditAsks(e, origins).map((a) => a.line).join('\n')).not.toMatch(/s3cret/);
  });
});
