import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { CheckContext } from './checks/context.js';
import { checkHooks } from './checks/hooks.js';
import { checkTokens } from './checks/tokens.js';
import { hasErrors } from './issues.js';
import { HookStepSchema } from './schemas/hooks.js';
import type { HookStep, LoadedProject, ValidationIssue } from './types.js';
import { checkYamlDocument } from './validation/document.js';
import type { LocatedIssue } from './validation/located.js';

/** A hooks file (`retake hooks run <project> hooks/x.yaml`): a YAML list of hook entries. */
export const HookFileSchema = z.array(HookStepSchema).describe('A list of hooks (same entries as `setup:` in a scenario).');

/**
 * Validate a hooks file: YAML syntax, schema, then the hook checks of scenarios (destructive hooks need
 * `confirm: true`, referenced files exist, js `page` keys, `{{tokens}}`). `file` locates relative files when
 * no project is given. `hooks` is returned only when there is no error-level issue.
 */
export function parseHookFile(
  text: string,
  opts: { file?: string; project?: LoadedProject } = {},
): { hooks?: HookStep[]; issues: ValidationIssue[] } {
  const projectDir = opts.project?.dir ?? (opts.file ? dirname(resolve(opts.file)) : undefined);
  const pages = opts.project ? [...new Set(Object.values(opts.project.config.environments).flatMap((p) => Object.keys(p)))] : undefined;
  const { value, issues } = checkYamlDocument(
    text,
    HookFileSchema,
    (v, structural): LocatedIssue[] => {
      const ctx = new CheckContext(structural, projectDir);
      const saved = new Set<string>();
      checkHooks(v, [], ctx, { pages, saved, project: opts.project });
      if (Array.isArray(v) && opts.project) {
        const scope = { pages, vars: new Set(Object.keys(opts.project.config.vars ?? {})), varsComplete: true, saved };
        v.forEach((h, i) => {
          if (!ctx.broken([i])) checkTokens(h, [i], scope, ctx);
        });
      }
      return ctx.out;
    },
    [],
  );
  return hasErrors(issues) ? { issues } : { hooks: value as HookStep[], issues };
}
