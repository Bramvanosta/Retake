/**
 * The Studio's operation table — the allow-list (UI_OPS, in order), each op's title, description, annotations and
 * input JSON Schema as `/v1/call/<op>` parses it (the MCP tools with the Studio's narrowed arguments, and the Studio's
 * own ops), and the ops' own HTTP statuses (OP_STATUS) — held byte for byte against fixtures/op-table.json. After an
 * intended change: RETAKE_WRITE_SNAPSHOTS=1 on this file, then review the diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OP_STATUS, UI_OPS } from '../src/server/studio.js';
import { stubTools } from './studio-tools.js';
import { recordGolden } from '@retake/test-support/golden';

const FILE = fileURLToPath(new URL('./fixtures/op-table.json', import.meta.url));

function schemaOf(input: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  delete json.$id;
  return json;
}

function opTableText(): string {
  const tools = stubTools();
  const ops = UI_OPS.map((op) => {
    const t = tools.get(op)!;
    return { name: t.name, title: t.title, description: t.description, annotations: t.annotations, input: schemaOf(t.input) };
  });
  return `${JSON.stringify({ ops: [...UI_OPS], status: OP_STATUS, tools: ops }, null, 1)}\n`;
}

describe("the Studio's operation table (snapshot)", () => {
  it("the allow-list, each op as /v1/call parses it and the ops' own statuses match fixtures/op-table.json byte for byte", () => {
    const text = opTableText();
    recordGolden(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(UI_OPS).toHaveLength(76);
  });
});
