/**
 * vitest setupFiles (L5.14, captures first): every test file gets a filming-marker folder of its own (0700) under the
 * run's scratch parent (vitest.config.ts RETAKE_TEST_CAPTURES) — a take one file films never holds a render another file
 * runs at the same time, and no test reads or writes the person's own folder. The processes a test starts inherit it
 * (core test/retake-home.test.ts is the canary). A file that sets its own RETAKE_CAPTURES_DIR keeps it.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const parent = process.env.RETAKE_TEST_CAPTURES?.trim();
if (parent && !process.env.RETAKE_CAPTURES_DIR?.trim()) process.env.RETAKE_CAPTURES_DIR = mkdtempSync(join(parent, 'file-'));
