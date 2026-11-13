/**
 * The fixture's Docker sandbox for real (L1.8, environment sandbox-docker), gated by RETAKE_TEST_DOCKER=1: a
 * running Docker with axllent/mailpit:v1.29.4 present and node:22-alpine present or pullable. The committed
 * sandbox.yaml + compose.yaml are copied to a temp project, moved to free ports, built from fixtures/wholesale, under
 * a compose project `retake-test-fixture-<run token>-*`; this run's compose projects and images are removed after
 * (shared base images are left alone; another run, and packages/sandbox/test/compose.test.ts, keep theirs: both files
 * may run at the same time).
 *
 * `retake sandbox up` builds the image and starts the fixture and Mailpit (seeded); a sign-up's confirmation mail is
 * relayed over SMTP to the real Mailpit and read with runner-web's MailboxClient (list, get, the cid: logo as an
 * inline part); the image prints no PDF (no Chromium); `retake sandbox reset` empties Mailpit (DELETE all); logs show
 * the relay; `down --volumes` leaves nothing with the project's label.
 */
import { resolveSecretRef } from '@retake/core/io';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadProject } from '@retake/core/io';
import { MailboxClient, inlineCids } from '@retake/runner-web';
import { dockerEnv, findDocker, openSandbox, probePort } from '@retake/sandbox';
import { EXIT, main, memoryIo } from '../src/index.js';
import { PERSON_POLICY, workPolicyFrom } from '@retake/core';
import type { WorkPolicy } from '@retake/core';
import { scratchHome } from '@retake/test-support/home';

/** The policy the work below runs under (core WorkPolicy): a command a person types until a test turns the agent policy on. */
let policy: WorkPolicy = PERSON_POLICY;

const ENABLED = process.env.RETAKE_TEST_DOCKER === '1';
const DOCKER = findDocker() ?? 'docker';
/** This run's compose projects and images: a token of its own (compose.test.ts and another run leave them alone). */
const PREFIX = `retake-test-fixture-${randomBytes(3).toString('hex')}-`;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = join(REPO, 'fixtures/wholesale');
const SOURCE = join(REPO, 'projects/northfield-fixture/sandbox/docker');
const PROJECT = 'northfield-docker';
const ENV = 'sandbox-docker';

function docker(args: string[]): string {
  return execFileSync(DOCKER, args, { encoding: 'utf8', env: dockerEnv(policy), stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}

/** Names of a compose project's resources of one kind (by its label). */
function labelled(kind: 'container' | 'volume' | 'network', project: string): string[] {
  const args = kind === 'container' ? ['ps', '-a'] : [kind, 'ls'];
  return docker([...args, '--filter', `label=com.docker.compose.project=${project}`, '--format', kind === 'container' ? '{{.Names}}' : '{{.Name}}'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Images built by this run (`retake-test-fixture-<token>-*`), as repository:tag. */
function testImages(): string[] {
  return docker(['images', '--filter', `reference=${PREFIX}*`, '--format', '{{.Repository}}:{{.Tag}}'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Remove this run's compose projects (containers, networks, volumes) and the images they built. */
function sweep(): void {
  const projects = new Set<string>();
  for (const p of JSON.parse(docker(['compose', 'ls', '-a', '--format', 'json']) || '[]') as Array<{ Name: string }>) if (p.Name.startsWith(PREFIX)) projects.add(p.Name);
  for (const kind of ['volume', 'network'] as const) {
    for (const line of docker([kind, 'ls', '--filter', 'label=com.docker.compose.project', '--format', '{{.Label "com.docker.compose.project"}}']).split('\n')) {
      if (line.trim().startsWith(PREFIX)) projects.add(line.trim());
    }
  }
  for (const p of projects) {
    docker(['compose', '-p', p, 'down', '--volumes', '--remove-orphans']);
    for (const v of labelled('volume', p)) docker(['volume', 'rm', '-f', v]);
    for (const n of labelled('network', p)) docker(['network', 'rm', n]);
  }
  const images = testImages();
  if (images.length) docker(['image', 'rm', ...images]);
}

/** `n` free ports away from the usual ones (45xx stay a developer's sandboxes). */
async function freePorts(n: number): Promise<number[]> {
  const out: number[] = [];
  while (out.length < n) {
    const port = 47_000 + Math.floor(Math.random() * 1800);
    if (!out.includes(port) && !(await probePort(port))) out.push(port);
  }
  return out;
}

let ws = '';
let home = '';
const retakeHome = scratchHome();
let dir = '';
let ports: number[] = [];
const name = `${PREFIX}${randomBytes(3).toString('hex')}`;

async function retake(args: string[]) {
  const io = memoryIo();
  const code = await main(['node', 'retake', '--root', ws, ...args], io);
  return { code, out: io.stdout(), err: io.stderr() };
}

describe.skipIf(!ENABLED)("the fixture's Docker sandbox for real (RETAKE_TEST_DOCKER=1)", () => {
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'studio-docker-home-'));
    retakeHome.use(home);
    // The image copies the UI bundle built on this machine.
    const build = (await import(join(FIXTURE, 'build.mjs'))) as { bundleState(): Promise<{ fresh: boolean }>; build(): Promise<unknown> };
    if (!(await build.bundleState()).fresh) await build.build();
    ports = await freePorts(5);
    ws = await mkdtemp(join(tmpdir(), 'studio-docker-'));
    await writeFile(join(ws, 'retake.yaml'), `projects_dir: projects\ntemplates_dir: ${JSON.stringify(join(REPO, 'templates'))}\n`);
    dir = join(ws, 'projects', PROJECT);
    await mkdir(join(dir, 'sandbox', 'docker'), { recursive: true });
    await writeFile(
      join(dir, 'project.yaml'),
      ['name: Northfield Docker sandbox test', 'environments:', '  local: {console: "http://localhost:9", shop: "http://localhost:9"}', 'sandboxes:', `  ${ENV}: sandbox/docker/sandbox.yaml`, ''].join(
        '\n',
      ),
    );
    // The committed files: free ports, the build context as an absolute path, a compose project name of the tests.
    const move = (text: string) => ['4511', '4512', '4513', '4514', '4525'].reduce((t, p, i) => t.replaceAll(p, String(ports[i])), text);
    const compose = move(await readFile(join(SOURCE, 'compose.yaml'), 'utf8')).replace('build: ../../../../fixtures/wholesale', `build: ${JSON.stringify(FIXTURE)}`);
    expect(compose).toContain(`build: ${JSON.stringify(FIXTURE)}`);
    expect(compose).toContain(`"127.0.0.1:${ports[4]}:8025"`);
    await writeFile(join(dir, 'sandbox', 'docker', 'compose.yaml'), compose);
    const manifest = move(await readFile(join(SOURCE, 'sandbox.yaml'), 'utf8')).replace('  files: [compose.yaml]', `  files: [compose.yaml]\n  project: ${name}`);
    expect(manifest).toContain(`project: ${name}`);
    await writeFile(join(dir, 'sandbox', 'docker', 'sandbox.yaml'), manifest);
  });

  afterAll(async () => {
    try {
      if (dir) await openSandbox(await loadProject(dir), ENV, policy, resolveSecretRef).down({ volumes: true });
    } catch {
      /* not started */
    }
    sweep();
    // Back to the run's scratch home (vitest.config.ts), never none: a later test's main() would look at the real one.
    retakeHome.restore();
    await rm(ws, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('up builds the image and starts the fixture and Mailpit; a sign-up mail reaches the real Mailpit over SMTP and MailboxClient reads it; reset empties Mailpit; down --volumes leaves nothing', async () => {
    const [consolePort, shopPort, , , mailPort] = ports;
    const t0 = Date.now();
    const up = await retake(['sandbox', 'up', PROJECT, '--env', ENV]);
    expect(up.code, up.err).toBe(EXIT.ok);
    expect(up.err).toMatch(/services {2}started fixture, mailpit · healthy 2\/2/);
    expect(up.err).toMatch(/seed {6}reseed \d+ ms · seed 1 step \(\d+ ms\) · mailbox emptied/);
    const upMs = Date.now() - t0;
    const image = `${name}-fixture`;
    expect(testImages()).toEqual([`${image}:latest`]);
    const size = Number(docker(['image', 'inspect', '--format', '{{.Size}}', image]).trim());
    const st = await retake(['sandbox', 'status', PROJECT, '--env', ENV, '--json']);
    expect(st.code, st.err).toBe(EXIT.ok);
    expect(JSON.parse(st.out)).toMatchObject({
      state: 'up',
      services: [
        { name: 'fixture', state: 'running', healthy: true },
        { name: 'mailpit', state: 'running', healthy: true },
      ],
      seed: { current: true },
    });

    // A café signs up: the fixture sends its confirmation (600 ms later), relayed to Mailpit over SMTP.
    const res = await fetch(`http://localhost:${consolePort}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cafe: 'Café Lumen', name: 'Noa Brandt', email: 'noa@cafe-lumen.example' }),
    });
    expect(res.status).toBe(201);
    const project = await loadProject(dir);
    const mailbox = new MailboxClient({ provider: 'mailpit', url: `http://localhost:${mailPort}` }, project);
    let list = await mailbox.list();
    for (let i = 0; i < 60 && !list.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      list = await mailbox.list();
    }
    expect(list).toEqual([
      {
        id: expect.any(String),
        from: { name: 'Northfield', address: 'hello@northfield.example' },
        to: [{ name: 'Noa Brandt', address: 'noa@cafe-lumen.example' }],
        subject: 'Confirm your email to open your café account',
        date: expect.any(String),
      },
    ]);
    const mail = await mailbox.get(list[0].id);
    expect(mail.text).toContain(`Confirm my email: http://localhost:${shopPort}/signup/confirm?token=confirm-0001`);
    expect(mail.html).toContain('<img src="cid:northfield-logo"');
    const { LOGO_SVG } = (await import(join(FIXTURE, 'server/email.mjs'))) as { LOGO_SVG: string };
    expect(mail.inline.map((p) => [p.cid, p.mime])).toEqual([['northfield-logo', 'image/svg+xml']]);
    expect(Buffer.from(mail.inline[0].data.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8')).toBe(LOGO_SVG);
    expect(inlineCids(mail.html, mail.inline)).not.toContain('cid:');

    // No Chromium in the image: the quote PDF is refused (a quote with a proposal).
    const quotes = (await (await fetch(`http://localhost:${consolePort}/api/quotes`)).json()) as Array<{ id: string; proposal: unknown }> | { items?: Array<{ id: string; proposal: unknown }> };
    const withProposal = (Array.isArray(quotes) ? quotes : (quotes.items ?? [])).find((q) => q.proposal);
    expect(withProposal).toBeDefined();
    const pdf = await fetch(`http://localhost:${shopPort}/quotes/${withProposal!.id}/quote.pdf`);
    expect(pdf.status).toBe(500);
    expect(await pdf.text()).toContain('The PDF could not be printed');

    // The fixture's log shows the relay.
    const logs = await retake(['sandbox', 'logs', PROJECT, 'fixture', '--env', ENV, '--lines', '40']);
    expect(logs.code, logs.err).toBe(EXIT.ok);
    expect(logs.out).toContain('Northfield fixture is running');
    expect(logs.out).toContain('SMTP     every mail is also delivered to mailpit:1025');
    expect(logs.out).toMatch(/mail "Confirm your email to open your café account" to noa@cafe-lumen\.example delivered over SMTP to mailpit:1025/);

    // A reset empties Mailpit (DELETE /api/v1/messages) and the fixture's own mailbox (its reset API).
    const t1 = Date.now();
    const reset = await retake(['sandbox', 'reset', PROJECT, '--env', ENV]);
    expect(reset.code, reset.err).toBe(EXIT.ok);
    expect(reset.err).toMatch(/sandbox sandbox-docker reset: reseed \d+ ms · seed 1 step \(\d+ ms\) · mailbox emptied/);
    const resetMs = Date.now() - t1;
    expect(await mailbox.list()).toEqual([]);
    expect(((await (await fetch(`http://localhost:${consolePort}/mailbox/api/v1/messages`)).json()) as { total: number }).total).toBe(0);

    const down = await retake(['sandbox', 'down', PROJECT, '--env', ENV, '--volumes']);
    expect(down.code, down.err).toBe(EXIT.ok);
    expect(down.err).toMatch(/sandbox sandbox-docker stopped: (fixture, mailpit|mailpit, fixture)/);
    expect(labelled('container', name)).toEqual([]);
    expect(labelled('volume', name)).toEqual([]);
    expect(labelled('network', name)).toEqual([]);
    // down never removes images: the test removes the one it built.
    expect(testImages()).toEqual([`${image}:latest`]);
    docker(['image', 'rm', image]);
    expect(testImages()).toEqual([]);
    console.log(`[fixture docker] up (build included) ${upMs} ms · image ${(size / 1e6).toFixed(0)} MB · reset ${resetMs} ms`);
  });
});
