/**
 * The JSON Schemas of every file format (core schemas/json.ts) written to a folder.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSON_SCHEMAS } from '../schemas/json.js';

/** Write `<dir>/<name>.schema.json` for every schema; returns the written paths. */
export async function writeJsonSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  for (const [name, fn] of Object.entries(JSON_SCHEMAS)) {
    const file = join(dir, `${name}.schema.json`);
    await writeFile(file, JSON.stringify(fn(), null, 2) + '\n', 'utf8');
    files.push(file);
  }
  return files;
}
