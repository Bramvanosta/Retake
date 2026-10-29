/**
 * L5.2 (critique M7) — the desktop shell's security and lifecycle rules run in the default suite: `cargo test` of
 * apps/desktop/core, a crate with no dependency (no registry, no Tauri build: about a second warm). The supervised
 * line, the navigation allow-list, redaction and sanitising of what the shell prints, the `--route` shape, the launch
 * config (environment in debug builds only), the workspace order, desktop.json (0600, atomic) and the stop sequence
 * against real processes; L5.2 fixes: the navigation decision once the server stopped or an attached one is gone
 * (review A L3), the code loaders a release child never gets (A L4), the workspace check of Open Workspace… (B M1), the
 * CLI's no_workspace line (B L4). Rust is never required by `pnpm test` (review B M4): skipped, the reason in the
 * title, on Windows, on macOS without the Xcode command line tools (checked with `xcode-select -p` BEFORE cargo runs:
 * the `cc` shim would open their install dialog), without rustc / cargo, or with a Rust older than 1.70 (the crate
 * declares no `rust-version`).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CORE = join(REPO, 'apps', 'desktop', 'core');

/** Why the rules cannot be built here; undefined when they can. Checked before cargo builds anything. */
function rustBlocked(): string | undefined {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin' && spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status !== 0) return 'no Xcode command line tools';
  const v = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
  const m = v.status === 0 ? /^rustc (\d+)\.(\d+)\./.exec(v.stdout) : null;
  if (!m) return 'no rustc';
  if (Number(m[1]) === 1 && Number(m[2]) < 70) return `Rust ${m[1]}.${m[2]} (1.70 or later needed)`;
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) return 'no cargo';
  return undefined;
}
const blocked = rustBlocked();

describe.skipIf(blocked !== undefined)(`desktop shell rules (apps/desktop/core, cargo test)${blocked ? ` — skipped: ${blocked}` : ''}`, () => {
  it('cargo test --offline --locked: every rule test passes', () => {
    const r = spawnSync('cargo', ['test', '--offline', '--locked', '--manifest-path', join(CORE, 'Cargo.toml')], {
      encoding: 'utf8',
      env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(CORE, 'target') },
      timeout: 120_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    const m = /test result: ok\. (\d+) passed; 0 failed/.exec(out);
    expect(Number(m?.[1]), out).toBeGreaterThanOrEqual(21);
    for (const name of [
      'a_line_with_any_other_host_scheme_port_or_shape_is_refused',
      'navigation_exact_origins_only',
      'redact_keeps_origins_only',
      'sanitize_strips_control_and_bidi_characters_and_caps_the_length',
      'launch_config_from_launch_json_and_debug_env',
      'desktop_json_is_written_0600_atomically_and_read_back',
      'a_child_that_ignores_sigterm_is_killed_after_the_grace_period',
      'navigation_after_the_server_stopped_or_with_an_attached_server_gone',
      'a_release_child_never_gets_a_code_loader_variable',
      'a_workspace_has_studio_yaml_or_projects_like_the_cli',
      'the_no_workspace_line_is_told_from_another_failure',
    ]) {
      expect(out, name).toMatch(new RegExp(`${name} \\.\\.\\. ok`));
    }
  }, 150_000);
});
