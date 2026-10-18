/**
 * scenario_from_script (L3.3, R-MCP-22): an optional aid when the user hands a timecoded script table — the table read
 * deterministically into an outline and a draft scenario (one `hold` per beat, the action as its note), validated.
 * It calls no model and writes nothing: the draft is a skeleton Claude rewrites from page inspections, then saves with
 * scenario_save. Never the start of the main authoring path (page_inspect → write the YAML → validate → save → run_dry).
 */
import { z } from 'zod';
import { SCRIPT_MARKDOWN_MAX } from '@demo-studio/core';
import type { ScriptIssue, ValidationIssue } from '@demo-studio/core';
import { envName, projectSlug, scenarioName } from '../schema.js';
import { plural } from '../result.js';
import { READ, defineTool } from './define.js';
import type { ToolDef } from './define.js';

const scriptLine = (i: ScriptIssue) => `script ${i.line}${i.col !== undefined ? `:${i.col}` : ''} ${i.severity}: ${i.message}`;
const yamlLine = (i: ValidationIssue) => `draft ${i.line !== undefined ? `${i.line}:${i.col ?? 1} ` : ''}${i.severity}${i.path.length ? ` ${i.path.join('.')}` : ''}: ${i.message}`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export const scenarioFromScript = defineTool({
  name: 'scenario_from_script',
  title: 'Draft a skeleton from a script table',
  description:
    'Optional aid, only when the user hands a timecoded script as a Markdown table (columns time | scene | action | caption, optionally end, duration, kicker, page, type — English or French headers; times M:SS or ranges M:SS–M:SS; type interstitial, title or outro). Returns an outline and a draft scenario that validates: one `hold` per beat sized to its time, the action as its `note`, captions, pages as environment page keys (never a URL). It films nothing yet — rewrite each hold into real steps from page_inspect, then scenario_validate and scenario_save. Writes nothing, calls no model.',
  input: z.strictObject({
    project: projectSlug,
    script_markdown: z.string().min(1).max(SCRIPT_MARKDOWN_MAX).describe('The script: Markdown with one pipe table (its first usable table is read).'),
    env: envName.optional().describe('Map the page column to this environment\'s page keys (default: the project default).'),
    name: scenarioName.optional().describe('The scenario name the draft is meant for (its `video`; default "draft").'),
  }),
  annotations: READ,
  async run({ project, script_markdown, env, name }, { engine }) {
    const d = await engine.scenarios.fromScript(project, script_markdown, { env, name });
    const lines: string[] = [];
    if (!d.yaml) {
      lines.push('No draft: the script has no usable table.');
    } else {
      const scenes = d.outline.scenes.filter((s) => s.kind === 'scene');
      const beats = scenes.reduce((n, s) => n + s.beats.length, 0);
      const extra = [d.outline.title ? 'a title' : '', d.outline.outro ? 'an outro' : '', plural(d.outline.scenes.length - scenes.length, 'interstitial')].filter(Boolean);
      lines.push(
        `Draft "${d.name}" (environment ${d.env}): ${plural(scenes.length, 'scene')}, ${plural(beats, 'beat')}, ${extra.join(', ')}; ${clock(d.outline.total_s)} in all. The draft ${d.validation.ok ? 'validates' : 'does not validate'}.`,
      );
      lines.push(
        `It is a skeleton: each beat is a \`hold\` with the script's action as its note. page_inspect the pages, replace the holds with real steps (targets from the inspection), then scenario_validate and scenario_save {name: "${d.name}"} (nothing was saved).`,
      );
    }
    const issues = [...d.script_issues.map(scriptLine), ...d.validation.issues.map(yamlLine)];
    if (issues.length) lines.push(`${plural(issues.length, 'issue')}:`, ...issues);
    return { summary: lines.join('\n'), data: { ...d } };
  },
});

export const AUTHORING_TOOLS: ToolDef[] = [scenarioFromScript];
