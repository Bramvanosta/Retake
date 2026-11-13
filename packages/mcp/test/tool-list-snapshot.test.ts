/**
 * The MCP tool list as tools/list publishes it — each tool's name, title, description, input JSON Schema and
 * annotations, in order — held byte for byte against fixtures/tool-list.json: a change to what Claude sees of a tool
 * shows in the diff of that file. After an intended change: RETAKE_WRITE_SNAPSHOTS=1 on this file, then review the diff.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLS, protocolTool } from '../src/index.js';
import { recordGolden } from '@retake/test-support/golden';

const FILE = fileURLToPath(new URL('./fixtures/tool-list.json', import.meta.url));

/** The published list: what protocolTool hands the protocol layer, without the handler. */
function toolListText(): string {
  const list = TOOLS.map((t) => protocolTool(t, () => Promise.reject(new Error('no engine')))).map((p) => ({
    name: p.name,
    title: p.title,
    description: p.description,
    inputSchema: p.inputSchema,
    annotations: p.annotations,
  }));
  return `${JSON.stringify(list, null, 1)}\n`;
}

describe('the MCP tool list (snapshot)', () => {
  it('names, titles, descriptions, input schemas and annotations match fixtures/tool-list.json byte for byte', () => {
    const text = toolListText();
    recordGolden(FILE, text);
    expect(text).toBe(readFileSync(FILE, 'utf8'));
    expect(TOOLS).toHaveLength(45);
  });
});
