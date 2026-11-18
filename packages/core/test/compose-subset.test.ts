/**
 * R-SHR-46: the compose subset an archive hands over (core compose-subset.ts), one rule at a time: a file within it reads
 * with no problem; each case below breaks exactly one rule and is named for it.
 */
import { describe, expect, it } from 'vitest';
import { readComposeSubset } from '../src/compose-subset.js';

const GOOD = [
  'name: demo',
  'volumes:',
  '  db: {}',
  'networks:',
  '  inner: {internal: true}',
  'services:',
  '  app:',
  '    image: busybox:1.38.0',
  '    build: {context: ../app-src, dockerfile: Dockerfile}',
  '    pull_policy: never',
  '    command: ["httpd", "-f"]',
  '    environment: {GREETING: "${GREETING:-none}", A: 1}',
  '    env_file: [app.env, {path: more.env, required: false}]',
  '    ports: ["127.0.0.1:4635:8080", {target: 80, published: 4636}]',
  '    depends_on: {db: {condition: service_healthy}}',
  '    healthcheck: {test: ["CMD", "true"], interval: 5s}',
  '    volumes: ["../data:/data:ro", "db:/var/lib/db", "/anonymous", {type: tmpfs, target: /tmp}]',
  '    networks: [inner]',
  '    init: true',
  '  db:',
  '    image: postgres:17-alpine',
  '    networks: {inner: {aliases: [database]}}',
  '',
].join('\n');

const problems = (text: string) => readComposeSubset(text, 'compose.yaml').problems;

describe('the compose subset (core compose-subset.ts)', () => {
  it('a file within the subset reads with no problem: its env files, binds and named volumes collected', () => {
    const r = readComposeSubset(GOOD, 'compose.yaml');
    expect(r.problems).toEqual([]);
    expect(r.services.find((s) => s.name === 'app')).toMatchObject({
      image: 'busybox:1.38.0',
      build: '../app-src',
      env_files: ['app.env', 'more.env'],
      binds: [{ source: '../data', target: '/data' }],
      volumes: ['db'],
    });
  });

  it('refuses each rule broken alone, naming it', () => {
    const cases: Array<[string, string, RegExp]> = [
      ['a merge key', 'services:\n  a:\n    <<: {image: x}\n', /a YAML merge key \(<<\)/],
      ['an anchor', 'services:\n  a: &x {image: busybox}\n', /a YAML anchor \(&x\)/],
      ['an alias', 'services:\n  a: &x {image: busybox}\n  b: *x\n', /a YAML alias/],
      ['a custom tag', 'services:\n  a: {image: busybox, build: !reset null}\n', /a YAML tag \(!reset\)/],
      ['interpolation outside environment', 'services:\n  a: {image: "busybox:${TAG}"}\n', /services\.a\.image: interpolation/],
      ['$NAME interpolation', 'services:\n  a: {image: busybox, command: "echo $HOME"}\n', /services\.a\.command: interpolation/],
      ['a top-level include', 'include: [x.yaml]\nservices: {}\n', /include: not a top-level key/],
      ['a service key outside', 'services:\n  a: {image: busybox, privileged: true}\n', /services\.a\.privileged: not a service setting/],
      ['a host bind', 'services:\n  a: {image: busybox, volumes: ["/etc:/x"]}\n', /a bind of a host path \(\/etc\)/],
      ['a home bind', 'services:\n  a: {image: busybox, volumes: [{type: bind, source: ~/x, target: /x}]}\n', /a bind of a host path \(~\/x\)/],
      ['bind propagation', 'services:\n  a: {image: busybox, volumes: [{type: bind, source: ./x, target: /x, bind: {propagation: rshared}}]}\n', /bind\.propagation: not a bind setting/],
      ['a volume driver', 'volumes:\n  v: {driver: local}\nservices: {}\n', /volumes\.v\.driver: not a volume setting/],
      ['an external network', 'networks:\n  n: {external: true}\nservices: {}\n', /networks\.n\.external: not a network setting/],
      ['an undeclared named volume', 'services:\n  a: {image: busybox, volumes: ["v:/v"]}\n', /the named volume v is not declared/],
      ['an absolute env file', 'services:\n  a: {image: busybox, env_file: /etc/environment}\n', /an env file that is not a relative path/],
      ['a build setting outside', 'services:\n  a: {build: {context: ., network: host}}\n', /build\.network: not a build setting/],
      ['a duplicate key', 'services:\n  a: {image: busybox}\n  a: {image: x}\n', /does not read as YAML/],
      ['a standard tag', 'services:\n  a: {image: busybox, command: !!str echo}\n', /a YAML tag \(tag:yaml\.org,2002:str\)/],
      ['a binary tag', 'services:\n  a: {image: !!binary aGVsbG8=}\n', /a YAML tag/],
      ['a %YAML directive', '%YAML 1.1\n---\nservices:\n  a: {image: busybox, ports: [22:22]}\n', /a YAML directive \(%YAML, %TAG\)/],
      ['a %TAG directive', '%TAG ! tag:example.com,2000:\n---\nservices: {}\n', /a YAML directive/],
      ['two documents', 'services: {}\n---\nservices:\n  a: {image: busybox, privileged: true}\n', /does not read as YAML/],
      ['a volume named otherwise than its key', 'volumes:\n  v: {name: another-project_pgdata}\nservices: {}\n', /volumes\.v\.name: another-project_pgdata — a name other than its key/],
      ['a network named otherwise than its key', 'networks:\n  n: {name: bridge}\nservices: {}\n', /networks\.n\.name: bridge — a name other than its key/],
      ['a propagation mode', 'services:\n  a: {image: busybox, volumes: ["./data:/d:rshared,Z"]}\n', /a volume mode other than ro, rw, z, Z \(rshared,Z: no propagation\)/],
    ];
    for (const [what, text, w] of cases) {
      const p = problems(text);
      expect(p.join('\n'), what).toMatch(w);
    }
    // Names equal to their keys, and the modes allowed, pass.
    expect(problems(GOOD.replace('  db: {}', '  db: {name: db}').replace('../data:/data:ro', '../data:/data:ro,z'))).toEqual([]);
  });
});
