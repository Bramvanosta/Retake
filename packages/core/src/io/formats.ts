/**
 * The run folder's format check: a run.json a newer Retake wrote is refused (core formats.ts says the words).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAT_VERSIONS, newerFormatMessage } from '../formats.js';

/**
 * The refusal of a run folder whose run.json a newer Retake wrote (render, plan, raw export). Undefined when
 * run.json is absent, unreadable or of a version this Retake reads: a run without one still renders.
 */
export function newerRunMessage(dir: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  } catch {
    return undefined;
  }
  return newerFormatMessage(value, { file: 'run.json', supported: FORMAT_VERSIONS.run });
}
