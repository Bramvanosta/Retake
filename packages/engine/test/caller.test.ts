/**
 * The caller policy (packages/engine/src/caller.ts): one caller (client, channel, trust) and every decision the engine
 * takes from who calls it, as a table per client — the decisions as they were made before they were gathered here
 * (engine.ts, approvals.ts, record-studio.ts, theme-edit.ts), plus the admission rules (the Studio and MCP).
 */
import { describe, expect, it } from 'vitest';
import { JOB_CLIENTS } from '@retake/core';
import {
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
  drivesRecordScreen,
  editsThemes,
  guardsStudioRecordings,
  needsIfMatch,
  personChannel,
  proposes,
  refusalChannel,
  submittedInStudio,
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
        person: personChannel(c),
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
      expect(refusalChannel(client)).toBe(row.refusal);
    });
  }

  it('words an unknown submitter as MCP; a job is the Studio\'s when the Studio submitted it; jobs run under trust mcp', () => {
    expect(refusalChannel(undefined)).toBe('mcp');
    expect(agentChannel(undefined)).toBe('mcp');
    expect(ENGINE_TRUST).toBe('mcp');
    expect(submittedInStudio({ submitted_by: 'ui' })).toBe(true);
    for (const by of ['cli', 'mcp', 'test'] as const) expect(submittedInStudio({ submitted_by: by })).toBe(false);
    expect(submittedInStudio({})).toBe(false);
    expect(submittedInStudio({ input: { submitted_by: 'ui' } } as never)).toBe(true);
    expect(submittedInStudio({ input: { submitted_by: 'mcp' } } as never)).toBe(false);
  });
});
