/**
 * old-name: this whole file (the guard test allows it).
 *
 * L5.13 — the names from before the rename (core legacy.ts): nothing is read under them, they are only detected.
 * - H3: the old home's sign-ins, by stats only, none at all when RETAKE_HOME is set; the home is never the old one.
 * - M3: the old workspace file stops the lookup and refuses the load — only when it is this tool's.
 * - H1: the old tool folder stays a folder whose files are never run as code.
 * - H2: the outgoing variables under both names.
 * - L5.13a reviews: old variables set without their new twin are named (A M4 / B M4); never an old workspace file in
 *   the home folder itself (A L2); a session snapshot's old metadata key (A L4); a .gitignore naming only the old
 *   folder (B M1).
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  agentWritable,
  findWorkspaceRoot,
  gitignoreFix,
  gitignoreNamesOldDirOnly,
  legacyInfo,
  loadWorkspaceConfig,
  oldEnvNames,
  oldHomeDir,
  oldHomeLine,
  oldHomeState,
  oldKitImportMessage,
  oldSignInHints,
  oldVarsLine,
  oldVarsUnread,
  oldWorkspaceFileAt,
  projectFileProblem,
  retakeHome,
  snapshotMachine,
  withOldOutgoingEnv,
} from '../src/index.js';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'retake-legacy-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the old home (critique H3)', () => {
  const H = '/scratch/home';
  const tree = (...paths: string[]) => {
    const seen: string[] = [];
    const exists = (p: string) => (seen.push(p), paths.some((x) => p === join(H, x) || p.startsWith(`${join(H, x)}/`) || join(H, x).startsWith(`${p}/`)));
    return { exists, seen };
  };

  it('RETAKE_HOME set: null without looking at any path (tests never stat the real home: L10)', () => {
    const t = tree('.demo-studio/profiles');
    expect(oldHomeState({ RETAKE_HOME: '/scratch/elsewhere' }, H, t.exists)).toBeNull();
    expect(t.seen).toEqual([]);
  });

  it('the old home holds profiles/ or sessions/ and the new one neither: the move, or the swap when the new one exists', () => {
    const move = oldHomeState({}, H, tree('.demo-studio/profiles').exists);
    expect(move).toEqual({ old: join(H, '.demo-studio'), home: join(H, '.retake'), shown: '~/.demo-studio', homeExists: false, command: 'mv ~/.demo-studio ~/.retake' });
    expect(oldHomeLine(move!)).toBe(
      'Retake keeps sign-ins in ~/.retake; ~/.demo-studio (from before the rename) is not read — stop the Studio, MCP clients and the worker, then: mv ~/.demo-studio ~/.retake (retake doctor says more)',
    );
    // The first signed job, the HTTP token or the desktop app recreated ~/.retake: still told, with the swap.
    const swap = oldHomeState({ RETAKE_HOME: ' ' }, H, tree('.demo-studio/sessions', '.retake/approvals.key').exists);
    expect(swap?.command).toBe('mv ~/.retake ~/.retake.after-upgrade && mv ~/.demo-studio ~/.retake');
  });

  it('the old home variable set (RETAKE_HOME not): THAT folder is the old home — looked at and named (set RETAKE_HOME to it, or move it); the old default home is not looked at (L5.13a leftover)', () => {
    // The person had moved the home: their sign-ins are in the variable's folder, whatever ~/.demo-studio holds.
    const out = '/Volumes/disk/old-home';
    const t = { seen: [] as string[] };
    const exists = (p: string) => (t.seen.push(p), [join(out, 'profiles'), join(H, '.demo-studio', 'profiles')].includes(p));
    const s = oldHomeState({ DEMO_STUDIO_HOME: out }, H, exists);
    expect(s).toEqual({ old: out, home: join(H, '.retake'), shown: out, byVar: 'DEMO_STUDIO_HOME', homeExists: false, command: `mv ${out} ~/.retake` });
    expect(t.seen.filter((p) => p.startsWith(join(H, '.demo-studio')))).toEqual([]);
    expect(oldHomeLine(s!)).toBe(
      'Sign-ins from before the rename are in /Volumes/disk/old-home, set by DEMO_STUDIO_HOME, and not read (Retake keeps them in ~/.retake): set RETAKE_HOME to it, or move it — stop the Studio, MCP clients and the worker, then: mv /Volumes/disk/old-home ~/.retake (retake doctor says more)',
    );
    // The variable's folder without sign-ins: nothing to say, even when ~/.demo-studio holds some (it is not theirs).
    expect(oldHomeState({ DEMO_STUDIO_HOME: out }, H, (p) => p === join(H, '.demo-studio', 'profiles'))).toBeNull();
    // `~` expanded as the old build did; a folder under the home shown with `~/`; a word that needs quoting quoted (absolute).
    expect(oldHomeDir({ DEMO_STUDIO_HOME: ' ~/old home ' }, H)).toEqual({ dir: join(H, 'old home'), shown: '~/old home', word: `'${join(H, 'old home')}'`, byVar: 'DEMO_STUDIO_HOME' });
    const swap = oldHomeState({ DEMO_STUDIO_HOME: '~/dsh' }, H, (p) => p === join(H, 'dsh', 'sessions') || p === join(H, '.retake'));
    expect(swap?.command).toBe('mv ~/.retake ~/.retake.after-upgrade && mv ~/dsh ~/.retake');
    // The plain case stays as it was; RETAKE_HOME still wins over both; the variable naming ~/.retake itself: nothing.
    expect(oldHomeDir({ DEMO_STUDIO_HOME: '  ' }, H)).toEqual({ dir: join(H, '.demo-studio'), shown: '~/.demo-studio', word: '~/.demo-studio' });
    expect(oldHomeDir({ DEMO_STUDIO_HOME: out, RETAKE_HOME: '/h' }, H)).toBeNull();
    expect(oldHomeState({ DEMO_STUDIO_HOME: '~/.retake' }, H, () => true)).toBeNull();
    // The preflight's hints: the old home line naming the folder, then the variable's own line.
    expect(oldSignInHints({ DEMO_STUDIO_HOME: out }, H, exists)).toEqual([oldHomeLine(s!), oldVarsLine(['DEMO_STUDIO_HOME'])]);
  });

  it('engine_info names the variable\'s folder and the variable (legacyInfo; the real home is a scratch HOME here)', async () => {
    const home = join(tmp, 'info-var-home');
    const out = join(tmp, 'info-var-old');
    await mkdir(join(out, 'sessions'), { recursive: true });
    await mkdir(join(home, '.demo-studio', 'profiles'), { recursive: true });
    const saved = process.env.HOME;
    process.env.HOME = home; // scratch HOME: restored below
    try {
      expect(legacyInfo({ DEMO_STUDIO_HOME: out })).toEqual({ old_home: out, old_home_var: 'DEMO_STUDIO_HOME', old_vars: ['DEMO_STUDIO_HOME'] });
      expect(legacyInfo({})).toEqual({ old_home: '~/.demo-studio' });
    } finally {
      process.env.HOME = saved;
    }
  });

  it('nothing to say: no old home, an old home without sign-ins, or a new home with sign-ins', () => {
    expect(oldHomeState({}, H, tree().exists)).toBeNull();
    expect(oldHomeState({}, H, tree('.demo-studio/approvals.key').exists)).toBeNull();
    expect(oldHomeState({}, H, tree('.demo-studio/profiles', '.retake/sessions').exists)).toBeNull();
  });

  it('the home is never the old one, even when only the old one holds a signed-in profile', async () => {
    const home = join(tmp, 'realhome');
    await mkdir(join(home, '.demo-studio', 'profiles', 'p', 'local', 'buyer'), { recursive: true });
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(retakeHome({})).toBe(join(home, '.retake'));
      expect(oldHomeState({}, home)?.old).toBe(join(home, '.demo-studio'));
    } finally {
      process.env.HOME = saved;
    }
  });
});

describe('the old workspace file (critique M3)', () => {
  const ws = (name: string) => join(tmp, 'ws', name);

  beforeAll(async () => {
    await mkdir(join(ws('with-projects'), 'projects'), { recursive: true });
    await writeFile(join(ws('with-projects'), 'studio.yaml'), '# anything\n');
    await mkdir(join(ws('with-state'), '.demo-studio'), { recursive: true });
    await writeFile(join(ws('with-state'), 'studio.yaml'), '');
    // Inside a folder with projects/: the lookup must stop at the old file, not drift up to it.
    await mkdir(join(ws('parent'), 'projects'), { recursive: true });
    await mkdir(join(ws('parent'), 'by-content', 'scenes'), { recursive: true });
    await writeFile(join(ws('parent'), 'by-content', 'studio.yaml'), 'version: 1\nprojects_dir: ~/videos/projects\nffmpeg: /opt/ffmpeg\n');
    await mkdir(join(ws('both'), 'projects'), { recursive: true });
    await writeFile(join(ws('both'), 'studio.yaml'), 'version: 1\n');
    await writeFile(join(ws('both'), 'retake.yaml'), 'version: 1\nprojects_dir: mine\n');
    // Another tool's file of that generic name, inside a workspace found by its projects/ folder.
    await mkdir(join(ws('outer'), 'projects'), { recursive: true });
    await mkdir(join(ws('outer'), 'apps', 'site', 'deep'), { recursive: true });
    await writeFile(join(ws('outer'), 'apps', 'site', 'studio.yaml'), 'name: my-site\nversion: 3\nport: 8080\n');
  });

  it("is this tool's next to projects/ or an old tool folder, or by its first 4 KB (version: and a workspace key) — not another tool's", () => {
    expect(oldWorkspaceFileAt(ws('with-projects'))).toBe(true);
    expect(oldWorkspaceFileAt(ws('with-state'))).toBe(true);
    expect(oldWorkspaceFileAt(join(ws('parent'), 'by-content'))).toBe(true);
    expect(oldWorkspaceFileAt(join(ws('outer'), 'apps', 'site'))).toBe(false);
    expect(oldWorkspaceFileAt(ws('outer'))).toBe(false);
  });

  it('stops the lookup where it lies (an ancestor with projects/ never wins); another tool\'s file is walked past', () => {
    const saved = process.env.RETAKE_ROOT;
    delete process.env.RETAKE_ROOT;
    try {
      expect(findWorkspaceRoot(join(ws('parent'), 'by-content', 'scenes'))).toBe(join(ws('parent'), 'by-content'));
      expect(findWorkspaceRoot(join(ws('outer'), 'apps', 'site', 'deep'))).toBe(ws('outer'));
    } finally {
      if (saved !== undefined) process.env.RETAKE_ROOT = saved;
    }
  });

  it('alone, the load refuses it with the mv; next to retake.yaml, retake.yaml is read; another tool\'s file changes nothing', async () => {
    for (const dir of [ws('with-projects'), join(ws('parent'), 'by-content')]) {
      const err = await loadWorkspaceConfig(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toBe(
        `${join(dir, 'studio.yaml')} is the workspace file from before L5.13 (Demo Studio): it is not read any more — rename it: mv ${join(dir, 'studio.yaml')} ${join(dir, 'retake.yaml')}`,
      );
    }
    expect((await loadWorkspaceConfig(ws('both'))).projectsDir).toBe(join(ws('both'), 'mine'));
    expect((await loadWorkspaceConfig(join(ws('outer'), 'apps', 'site'))).projectsDir).toBe(join(ws('outer'), 'apps', 'site', 'projects'));
  });

  it("never in the home folder itself (review A L2): another tool's file of that name in ~ is walked past, even next to ~/Projects and the old home", async () => {
    const home = join(tmp, 'ws', 'home');
    await mkdir(join(home, 'Projects'), { recursive: true });
    await mkdir(join(home, '.demo-studio'), { recursive: true });
    await mkdir(join(home, 'work', 'projects'), { recursive: true });
    await writeFile(join(home, 'studio.yaml'), 'version: 2\nprojects_dir: other-tool\n');
    expect(oldWorkspaceFileAt(home, home)).toBe(false);
    // Through a link to the home folder too; elsewhere the same folder would be this tool's.
    await symlink(home, join(tmp, 'ws', 'home-link'));
    expect(oldWorkspaceFileAt(join(tmp, 'ws', 'home-link'), home)).toBe(false);
    expect(oldWorkspaceFileAt(home, join(tmp, 'ws', 'elsewhere'))).toBe(true);
    const saved = { HOME: process.env.HOME, RETAKE_ROOT: process.env.RETAKE_ROOT };
    process.env.HOME = home;
    delete process.env.RETAKE_ROOT;
    try {
      expect(findWorkspaceRoot(join(home, 'work', 'projects'))).toBe(join(home, 'work'));
      expect((await loadWorkspaceConfig(home)).projectsDir).toBe(join(home, 'projects'));
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.RETAKE_ROOT !== undefined) process.env.RETAKE_ROOT = saved.RETAKE_ROOT;
    }
  });
});

describe('the old tool folder stays unrunnable (critique H1)', () => {
  it('a file under the old tool folder is agent-writable: never run as code through MCP or from the Studio', async () => {
    const project = join(tmp, 'h1');
    await mkdir(join(project, '.demo-studio', 'inspect', 'i_1'), { recursive: true });
    await writeFile(join(project, '.demo-studio', 'inspect', 'i_1', 'dump.js'), 'fetch("/api/delete")');
    expect(agentWritable('.demo-studio/inspect/i_1/dump.js')).toBe(true);
    expect(agentWritable('.Demo-Studio/records/x.sql')).toBe(true);
    expect(projectFileProblem(project, '.demo-studio/inspect/i_1/dump.js', { code: true })).toBe(
      '.demo-studio/inspect/i_1/dump.js is a file an agent can write through MCP (.demo-studio/inspect/i_1/dump.js): through MCP code is only run from files a human put elsewhere in the project (hooks/, assets/…)',
    );
  });
});

describe('the variables (critique H2) and the kit import', () => {
  it('outgoing RETAKE_* variables are also written under their old names; nothing else is', () => {
    expect(withOldOutgoingEnv({ RETAKE_SANDBOX: 'sandbox', RETAKE_RUN_ID: 'r1', RETAKE_HOME: '/h', OTHER: 'x' })).toEqual({
      RETAKE_SANDBOX: 'sandbox',
      RETAKE_RUN_ID: 'r1',
      RETAKE_HOME: '/h',
      OTHER: 'x',
      DEMO_STUDIO_SANDBOX: 'sandbox',
      DEMO_STUDIO_RUN_ID: 'r1',
    });
    expect(oldEnvNames({ DEMO_STUDIO_ROOT: '/w', RETAKE_ROOT: '/w', DEMO_STUDIO_HOME: '/h', DEMO_STUDIO_X: undefined })).toEqual(['DEMO_STUDIO_HOME', 'DEMO_STUDIO_ROOT']);
  });

  it('old variables set without their RETAKE_* twin are named, values never; outgoing names and set twins are not (reviews A M4, B M4)', () => {
    const env = { DEMO_STUDIO_HOME: '/Volumes/x/home', DEMO_STUDIO_ROOT: '/w', RETAKE_ROOT: '/w', DEMO_STUDIO_SANDBOX: 'sandbox', DEMO_STUDIO_CHROMIUM: '/c' };
    expect(oldVarsUnread(env)).toEqual(['DEMO_STUDIO_CHROMIUM', 'DEMO_STUDIO_HOME']);
    expect(oldVarsLine(['DEMO_STUDIO_HOME'])).toBe("DEMO_STUDIO_HOME is set but no longer read: rename it RETAKE_HOME where it is set — shell profile, the MCP registration's env");
    expect(oldVarsLine(oldVarsUnread(env))).toBe(
      "DEMO_STUDIO_CHROMIUM, DEMO_STUDIO_HOME are set but no longer read: rename them RETAKE_CHROMIUM, RETAKE_HOME where they are set — shell profile, the MCP registration's env",
    );
    expect(oldVarsLine(oldVarsUnread(env))).not.toContain('/Volumes');
    expect(oldVarsUnread({ RETAKE_HOME: '/h' })).toEqual([]);
    // engine_info's field: the old home (no RETAKE_HOME, the old one holding sign-ins), the variables, or nothing.
    const H = join(tmp, 'info-home');
    expect(legacyInfo({ ...env, RETAKE_HOME: '/h' })).toEqual({ old_vars: ['DEMO_STUDIO_CHROMIUM'] });
    expect(legacyInfo({ RETAKE_HOME: '/h' })).toBeUndefined();
    expect(oldSignInHints({ DEMO_STUDIO_HOME: '/x', DEMO_STUDIO_ROOT: '/w' }, H, () => false)).toEqual([oldVarsLine(['DEMO_STUDIO_HOME'])]);
    expect(oldSignInHints({ DEMO_STUDIO_ROOT: '/w' }, H, (p) => p === join(H, '.demo-studio', 'profiles'))).toEqual([oldHomeLine(oldHomeState({}, H, (p) => p === join(H, '.demo-studio', 'profiles'))!)]);
    expect(oldSignInHints({ RETAKE_HOME: '/h', DEMO_STUDIO_HOME: '/x' }, H, () => true)).toEqual([]);
  });

  it('a session snapshot names its computer under its key of today or of before the rename (review A L4)', () => {
    expect(snapshotMachine({ cookies: [], retake: { version: 1, machine: 'new-mac' } })).toBe('new-mac');
    expect(snapshotMachine({ cookies: [], demo_studio: { version: 1, machine: 'old-mac' } })).toBe('old-mac');
    expect(snapshotMachine({ cookies: [], demo_studio: { machine: 7 } })).toBeUndefined();
    expect(snapshotMachine({ cookies: [] })).toBeUndefined();
    expect(snapshotMachine(null)).toBeUndefined();
  });

  it('a .gitignore that ignores the old tool folder and not .retake/, with its one-line fix (review B M1)', () => {
    expect(gitignoreNamesOldDirOnly('runs/\nrenders/\n.demo-studio/\n')).toBe(true);
    expect(gitignoreNamesOldDirOnly('/.demo-studio\r\n')).toBe(true);
    expect(gitignoreNamesOldDirOnly('.demo-studio/\n.retake/\n')).toBe(false);
    expect(gitignoreNamesOldDirOnly('runs/\n.retake\n')).toBe(false);
    expect(gitignoreNamesOldDirOnly('# .demo-studio/ was here\n')).toBe(false);
    expect(gitignoreFix('/w/projects/acme/.gitignore')).toBe("printf '.retake/\\n' >> /w/projects/acme/.gitignore");
    expect(gitignoreFix('/w/my projects/.gitignore')).toBe("printf '.retake/\\n' >> '/w/my projects/.gitignore'");
  });

  it('the old kit specifier gets the new one in its message', () => {
    expect(oldKitImportMessage('@demo-studio/components/kit', '@retake/components/kit')).toBe(
      'import "@demo-studio/components/kit" is the kit\'s name before L5.13: import "@retake/components/kit"',
    );
    expect(oldKitImportMessage('@retake/components/kit', '@retake/components/kit')).toBeUndefined();
  });
});
