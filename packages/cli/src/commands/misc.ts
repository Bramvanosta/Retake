import { JSON_SCHEMAS } from '@demo-studio/core';
import type { JsonSchemaName } from '@demo-studio/core';
import { EXIT } from '../errors.js';
import type { ExitCode } from '../errors.js';
import type { Ui } from '../ui.js';

export const SCHEMA_NAMES = ['scenario', 'project', 'template', 'timeline', 'sandbox'] as const satisfies readonly JsonSchemaName[];

/** `studio schema [name]`: the JSON Schema on stdout (for editors and agents). */
export function schemaCommand(ui: Ui, name: JsonSchemaName): ExitCode {
  ui.result(JSON.stringify(JSON_SCHEMAS[name](), null, 2));
  return EXIT.ok;
}

/**
 * Commands of later phases: registered so `studio --help` lists them, they only say when they arrive. Empty since
 * L4.1 made `ui` a real command; the mechanism stays for the next one.
 */
export const LATER_COMMANDS: ReadonlyArray<{ name: string; phase: 4 | 5; summary: string }> = [];

export function laterCommand(ui: Ui, name: string, phase: number): ExitCode {
  ui.error(`studio ${name} is available in phase ${phase}; available now: new, list, validate, run, inspect, record, plan, render, still, review, export, comment, hooks, env reset, sandbox, components, theme create, schema, login, auth status, doctor, mcp and ui`);
  return EXIT.failure;
}
