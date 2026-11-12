/**
 * The caller policy (packages/engine/src/caller.ts): one caller (client, channel, trust) and every decision the engine
 * takes from who calls it, as a table per client — the decisions as they were made before they were gathered here
 * (engine.ts, approvals.ts, record-studio.ts, theme-edit.ts, the Studio server's pipe), plus the admission rules (the
 * Studio and MCP); the trust every job runs under (ENGINE_TRUST), used by each job module instead of a literal.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_CONFINEMENT } from '@retake/core';
import { STUDIO_CONFINEMENT } from '../../core/test/helpers.js';
import { JOB_CLIENTS } from '@retake/engine';
import {
  CONFINEMENTS,
  ENGINE_TRUST,
  admits,
  agentChannel,
  agentChecks,
  agentTrust,
  agentWorkspace,
  anchorsOnShownRender,
  callerOf,
  chainsRecordings,
  cleansWorkerEnv,
  confinementOf,
  drivesRecordScreen,
  editsThemes,
  guardsStudioRecordings,
  needsIfMatch,
  proposes,
  refusalChannel,
  speaksAsPerson,
  submittedInStudio,
  submitterChannel,
} from '../src/index.js';
import type { Caller, EngineClient } from '../src/index.js';

type Row = {
  caller: Omit<Caller, 'client'>;
  agentChecks: boolean;
  agentWorkspace: boolean;
  refusal: 'mcp' | 'studio';
  person: boolean;
  ifMatch: boolean;
  proposes: boolean;
  anchors: boolean;
  recordScreen: boolean;
  chainsRecordings: boolean;
  cleanEnv: boolean;
  guardsRecordings: boolean;
  editsThemes: boolean;
  admits: boolean;
};

// One row per client: what the engine decided for it before the policy module (and the admission rules, new).
const TABLE: Record<EngineClient, Row> = {
  cli: { caller: { channel: 'cli', trust: 'author' }, agentChecks: false, agentWorkspace: false, refusal: 'mcp', person: true, ifMatch: false, proposes: false, anchors: false, recordScreen: false, chainsRecordings: false, cleanEnv: false, guardsRecordings: false, editsThemes: true, admits: false },
  mcp: { caller: { channel: 'mcp', trust: 'mcp' }, agentChecks: true, agentWorkspace: true, refusal: 'mcp', person: false, ifMatch: true, proposes: true, anchors: false, recordScreen: false, chainsRecordings: false, cleanEnv: true, guardsRecordings: true, editsThemes: false, admits: true },
  test: { caller: { channel: 'mcp', trust: 'mcp' }, agentChecks: false, agentWorkspace: true, refusal: 'mcp', person: false, ifMatch: true, proposes: true, anchors: false, recordScreen: true, chainsRecordings: false, cleanEnv: true, guardsRecordings: false, editsThemes: true, admits: false },
  ui: { caller: { channel: 'studio', trust: 'mcp' }, agentChecks: true, agentWorkspace: true, refusal: 'studio', person: true, ifMatch: true, proposes: false, anchors: true, recordScreen: true, chainsRecordings: true, cleanEnv: true, guardsRecordings: false, editsThemes: true, admits: true },
};

describe('the caller policy', () => {
  it('has a row for every client a job records', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...JOB_CLIENTS].sort());
  });

  for (const client of JOB_CLIENTS) {
    it(`decides for ${client} as the table says`, () => {
      const { caller, ...want } = TABLE[client];
      const row = TABLE[client];
      const c = callerOf(client);
      expect(c).toEqual({ client, ...caller });
      expect({
        agentChecks: agentChecks(c),
        agentWorkspace: agentWorkspace(c),
        refusal: refusalChannel(c),
        person: speaksAsPerson(c),
        ifMatch: needsIfMatch(c),
        proposes: proposes(c),
        anchors: anchorsOnShownRender(c),
        recordScreen: drivesRecordScreen(c),
        chainsRecordings: chainsRecordings(c),
        cleanEnv: cleansWorkerEnv(c),
        guardsRecordings: guardsStudioRecordings(c),
        editsThemes: editsThemes(c),
        admits: admits(c),
      }).toEqual(want);
      // The engine's older names say the same.
      expect(agentTrust(client)).toBe(row.agentChecks);
      expect(agentChannel(client)).toBe(row.refusal);
      expect(submitterChannel(client)).toBe(row.refusal);
    });
  }

  it("hands core and the adapters each channel's words as a confinement value, never the channel (L7.35, finding D6)", () => {
    // The MCP server's words are core's default (what core says when it is given none); the Studio's name no MCP tool.
    expect(CONFINEMENTS.mcp).toBe(AGENT_CONFINEMENT);
    expect({ ...CONFINEMENTS.mcp }).toEqual({ words: 'through MCP', writesThrough: 'through MCP', themeList: 'template_list', approval: ' — a human approves it when asked, or runs it in a terminal' });
    expect({ ...CONFINEMENTS.studio }).toEqual({ words: 'from the Studio', approval: ' and the Studio cannot approve hooks yet — run it in a terminal' });
    // The Studio value core's and the adapters' tests use (core test/helpers.ts) is this one, member for member.
    expect(STUDIO_CONFINEMENT).toEqual(CONFINEMENTS.studio);
    for (const ch of ['mcp', 'studio'] as const) {
      expect(confinementOf(ch)).toBe(CONFINEMENTS[ch]);
      expect(Object.isFrozen(confinementOf(ch)), ch).toBe(true);
    }
    expect(Object.isFrozen(CONFINEMENTS)).toBe(true);
    // Every client's refusals are worded by its channel's value (the CLI's as MCP's).
    for (const client of JOB_CLIENTS) expect(confinementOf(refusalChannel(callerOf(client)))).toBe(client === 'ui' ? CONFINEMENTS.studio : CONFINEMENTS.mcp);
  });

  it('words an unknown submitter as MCP; a job is the Studio\'s when the Studio submitted it; jobs run under trust mcp', () => {
    expect(submitterChannel(undefined)).toBe('mcp');
    expect(agentChannel(undefined)).toBe('mcp');
    expect(ENGINE_TRUST).toBe('mcp');
    expect(submittedInStudio({ submitted_by: 'ui' })).toBe(true);
    for (const by of ['cli', 'mcp', 'test'] as const) expect(submittedInStudio({ submitted_by: by })).toBe(false);
    expect(submittedInStudio({})).toBe(false);
    expect(submittedInStudio({ input: { submitted_by: 'ui' } } as never)).toBe(true);
    expect(submittedInStudio({ input: { submitted_by: 'mcp' } } as never)).toBe(false);
  });

  it('no job module names a trust or a submitter by its literal: each goes through the caller module', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const files = [...readdirSync(join(src, 'jobs')).map((f) => join('jobs', f)), 'approvals.ts', 'record-studio.ts'].filter((f) => f.endsWith('.ts'));
    const hits: string[] = [];
    for (const f of files) {
      const code = readFileSync(join(src, f), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
      code.forEach((l, i) => {
        if (/\b(?:hookTrust|trust):\s*'(?:mcp|author)'/.test(l) || /submitted_by\s*[!=]==\s*'/.test(l) || /\bbyJob\s*[!=]==\s*'/.test(l)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(hits, hits.join('\n')).toEqual([]);
    const supervise = readFileSync(join(src, '..', '..', 'ui', 'src', 'server', 'supervise.ts'), 'utf8');
    expect(supervise).not.toMatch(/submitted_by\s*[!=]==\s*'/);
  });
});
