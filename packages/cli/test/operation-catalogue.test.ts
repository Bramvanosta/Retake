/**
 * The `retake` commands against the operation catalogue (@retake/engine/contract): every command that runs something
 * (hidden ones included) is named by some operation of the catalogue, and every command the catalogue names exists.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE, cliCommandsOf, servedBy } from '@retake/engine/contract';
import { commandPaths } from '../src/main.js';

describe('the CLI commands and the operation catalogue', () => {
  it('the commander tree and the catalogue name the same 44 commands', () => {
    expect([...commandPaths()].sort()).toEqual([...cliCommandsOf()].sort());
    expect(commandPaths()).toHaveLength(44);
    expect(commandPaths()).toContain('worker');
    expect(commandPaths()).toContain('hooks run');
    expect(commandPaths()).not.toContain('hooks');
  });

  it('an operation the CLI does not serve says why; one it serves names its commands', () => {
    for (const o of CATALOGUE) expect(Array.isArray(o.cli) === servedBy(o, 'cli'), o.name).toBe(true);
    expect(CATALOGUE.filter((o) => Array.isArray(o.cli) && o.cli.includes('run')).map((o) => o.name)).toEqual(['run_dry', 'run_capture', 'scenario_run']);
  });
});
