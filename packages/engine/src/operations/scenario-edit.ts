/**
 * The Studio's scenario write (moved from the Studio server's ops.ts in L7.18): scenario_edit and its edit schema. It
 * declares `serialize` on the scenario's key (scenarioKey), so invoke runs it on the engine's operation chain with
 * scenario_render, thread_apply and record_save (the Studio holds one engine per server: its chain).
 */
import { z } from 'zod';
import { SLUG_RE } from '@retake/core/model';
import { FIELD_PATHS, PALETTE_ACTIONS, SCENARIO_EDIT_MAX_CHARS } from '@retake/core/scenario';
import { defineOperation } from './define.js';
import { scenarioKey } from './studio-jobs.js';
import { studioProject as project, studioScenario as scenario } from './studio-schema.js';
import { plural } from './words.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lower-case hex characters)');
const editText = z.string().max(SCENARIO_EDIT_MAX_CHARS, `at most ${SCENARIO_EDIT_MAX_CHARS.toLocaleString('en')} characters`);

const sceneId = z.string().max(100).regex(SLUG_RE, 'a scene id of the file');
const stepIndex = z.number().int().min(0).max(100_000);
/** A step as the screen showed it: scene id, index, and its guard (scenario_blocks `guard`, critique B2). */
const StepAtInput = z.strictObject({
  scene: sceneId,
  index: stepIndex.describe('Its index in the scene (0-based).'),
  guard: z.string().regex(/^[0-9a-f]{16}$/, 'the step\'s guard as scenario_blocks gave it (16 hex characters)'),
});

/** A form field's value (critique B9 is checked by core, which names the field): one line of text, a number, yes / no. */
const fieldValue = z.union([z.string().max(10_000, 'at most 10,000 characters'), z.number().finite(), z.boolean()]);
const fieldSeg = z.string().regex(/^[a-z][a-z_]{0,39}$/, 'a field name of the form (lower-case letters and _)');
/** A form field's key, dotted ("type.into.label"): at most three levels (a flat target). */
const fieldKey = z.string().max(122).regex(/^[a-z][a-z_]{0,39}(\.[a-z][a-z_]{0,39}){0,2}$/, 'a field key of the form ("type.text", "click.in")');
const FieldChangeInput = z.strictObject({
  path: z.array(fieldSeg).min(1).max(3).describe('The field, as its key split on dots: ["type", "text"], ["caption", "text"], ["hold"].'),
  from: fieldValue.optional().describe('The value the form showed (absent: none) — the change is applied only while the file still holds it.'),
  to: fieldValue.optional().describe('The new value (absent: the value is removed).'),
});

/**
 * A timeline switch's place (L4.5, core FieldAt): the video's top level, or a scene / card / interstitial by its id and
 * its guard (timeline_view `choices[…].at`).
 */
const FieldAtInput = z.union([
  z.strictObject({ entry: z.literal('top') }),
  z.strictObject({
    entry: z.enum(['scene', 'card', 'interstitial']),
    id: sceneId,
    guard: z.string().regex(/^[0-9a-f]{16}$/, "the entry's guard as timeline_view gave it (16 hex characters)"),
  }),
]);
/** Every path of core FIELD_PATHS (each an edit value); which entry takes which is checked below, before any read. */
type FieldName = (typeof FIELD_PATHS)[keyof typeof FIELD_PATHS][number];
const FIELD_NAMES = [...new Set(Object.values(FIELD_PATHS).flat())] as [FieldName, ...FieldName[]];
/** A timeline switch's value: a frame, a transition, a component id, a speed or duration, the intro / outro switch. */
const switchValue = z.union([z.string().max(200, 'at most 200 characters'), z.number().finite(), z.boolean()]);
const SetFieldInput = z
  .strictObject({
    kind: z.literal('set_field'),
    at: FieldAtInput,
    field: z.enum(FIELD_NAMES).describe('A value of the edit part (core FIELD_PATHS), never a step, a hook, a var or the environment.'),
    from: switchValue.optional().describe('What the inspector showed there (absent: not written) — applied only while the file still holds it.'),
    to: switchValue.optional().describe("The new value (absent: removed — the theme's default)."),
  })
  .superRefine((e, ctx) => {
    const allowed = FIELD_PATHS[e.at.entry] as readonly string[];
    if (!allowed.includes(e.field)) ctx.addIssue({ code: 'custom', path: ['field'], message: `${e.field} is not a value of ${e.at.entry === 'top' ? 'the video' : `a ${e.at.entry}`} (${allowed.join(', ')})` });
  });

const EditInput = z.strictObject({
  project,
  name: scenario.describe('The scenario: the file scenario_blocks read (scenarios/<name>.yaml, or an existing .yml).'),
  hash: sha256.describe('The file as the screen showed it (scenario_blocks `hash`): refused (409) when the file changed since.'),
  edit: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('replace_text'), text: editText.describe('The YAML view\'s text (a final line break is added when missing).') }),
      z.strictObject({
        kind: z.literal('restore'),
        text: editText.describe('The exact text of an earlier version (undo / redo).'),
        text_hash: sha256.describe('Its sha256: the text is written byte for byte, checked against it.'),
      }),
      z.strictObject({
        kind: z.literal('move_step'),
        from: StepAtInput,
        to: z.strictObject({ scene: sceneId, index: stepIndex.describe('Its index in that scene once moved (in its own scene: counted without it).') }),
      }),
      z.strictObject({ kind: z.literal('delete_step'), at: StepAtInput }),
      z.strictObject({ kind: z.literal('duplicate_step'), at: StepAtInput.describe('The step to copy (the copy goes right after it, without id or mark, a capture renamed).') }),
      z.strictObject({
        kind: z.literal('set_step'),
        at: StepAtInput,
        changes: z.array(FieldChangeInput).min(1).max(40).describe("The form's changed fields (scenario_forms names them)."),
      }),
      z.strictObject({
        kind: z.literal('insert_step'),
        to: z.strictObject({ scene: sceneId, index: stepIndex.describe('Its index in the scene once added.') }),
        after: z
          .string()
          .regex(/^[0-9a-f]{16}$/, "the guard of the step before that place, as scenario_blocks gave it")
          .nullable()
          .describe('The guard of the step just before that place (null at the start of the scene).'),
        action: z.enum(PALETTE_ACTIONS).describe('An action of the palette.'),
        values: z.record(fieldKey, fieldValue).describe("The new step's form values (scenario_forms names the fields).").refine((v) => Object.keys(v).length <= 40, 'at most 40 values'),
      }),
      SetFieldInput,
    ])
    .describe('One edit.'),
});

/**
 * scenario_edit (L4.3): the Studio's one write path for scenarios — engine scenarios.edit under the `ui` client's agent
 * trust ("from the Studio"): the file the view read, `hash` as if_match, refused whole when the file is blocked (the
 * view's `edit` said so first), no hidden character added, hooks and mocks unchanged, validated (errors refuse with
 * their lines, warnings save), atomic with its mode kept, under the write lock. Edits of one file run one at a time on
 * the engine's operation chain (a double click, two tabs): the second then finds the new hash and gets its 409. L4.5
 * part D: the timeline inspector's `set_field` (SetFieldInput: strict, a field of core FIELD_PATHS that the entry
 * takes, checked before any read). Not an MCP tool: Claude edits a scenario with scenario_save.
 */
export const scenarioEdit = defineOperation({
  name: 'scenario_edit',
  title: 'Edit a scenario from the Studio',
  description: "Apply one edit (the YAML view's text, undo / redo's exact earlier version, a step moved, deleted, duplicated, changed by its form or added from the palette, a timeline switch of an edit value) to a scenario, on the version the screen showed.",
  input: EditInput,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Edits of one file run one at a time on the engine's chain (invoke), shared with scenario_render, thread_apply and
  // record_save: the second of two finds the new hash and gets its 409.
  serialize: (a) => scenarioKey(a.project, a.name),
  async run(a, { engine }) {
    const r = await engine.scenarios.edit(a.project, a.name, { hash: a.hash, edit: a.edit });
    // Path-free (L4.6, the L4.5 rule for Studio answers): the file's project-relative name, never its absolute path.
    const { path: _path, ...data } = r as typeof r & { path?: string };
    return {
      summary: `${r.label}: ${r.file} (hash ${r.hash})${r.warnings.length ? ` with ${plural(r.warnings.length, 'warning')}` : ''}`,
      data,
    };
  },
});
