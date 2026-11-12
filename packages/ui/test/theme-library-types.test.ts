/**
 * The types the app's StudioOps (src/app/data/ops.ts) is derived from, held exactly for the Studio's theme and library
 * operations (L7.17: they became the engine's operations; written on the commit before the move): each op's arguments
 * as a page sends them (`ToolArgs`) and its answer (`ToolData`) of `StudioTools` (server/studio.ts). A type that widens
 * or narrows fails `pnpm typecheck` (tsconfig.test.json), not this file's run: the run only says the file is part of
 * the suite.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { BrandInputSchema, ComponentKind, THEME_FIELD_PATHS } from '@retake/core';
import type { ToolArgs, ToolData } from '@retake/engine/contract';
import type { BrandFileList, ThemeCopied, ThemeCreated, ThemeEditResult, ThemeEditView } from '@retake/engine';
import type { LibraryComponentAnswer, LibraryImagesAnswer, LibraryRenderAnswer, LibraryViewAnswer, SiteListAnswer, ThemeListAnswer, ThemePreviewAnswer } from '../src/index.js';
import type { StudioTools } from '../src/server/studio.js';

/** A and B are each other's (mutually assignable) and have the same keys (an extra optional member counts). */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Exact<A, B> = Same<A, B> extends true ? Same<keyof A, keyof B> : false;
type Holds<T extends true> = T;

type Args<K extends keyof StudioTools> = ToolArgs<StudioTools[K]>;
type Data<K extends keyof StudioTools> = ToolData<StudioTools[K]>;

/** A theme field's value as the page sends it. */
type FieldValue = string | number | string[];
type Hex = string;

export type Checks = [
  Holds<Exact<Args<'theme_list'>, { project: string }>>,
  Holds<Exact<Data<'theme_list'>, ThemeListAnswer>>,
  Holds<Exact<Args<'theme_view'>, { theme: string }>>,
  Holds<Exact<Data<'theme_view'>, Omit<ThemeEditView, 'yaml'> & { yaml: ThemeEditView['yaml'] }>>,
  Holds<Exact<Args<'theme_edit'>['theme'], string>>,
  Holds<Exact<Args<'theme_edit'>['if_match'], string>>,
  Holds<
    Exact<
      Args<'theme_edit'>['edit'],
      | { kind: 'set_field'; field: (typeof THEME_FIELD_PATHS)[number]; from?: FieldValue | undefined; to?: FieldValue | undefined; ripple?: boolean | undefined }
      | { kind: 'set_background'; from?: Record<string, string | number> | undefined; to: { type: 'solid'; color: Hex } | { type: 'radial' | 'linear'; from: Hex; to: Hex } }
      | { kind: 'set_component'; component: ComponentKind; from?: string | null | undefined; id: string | null; params: 'keep' | 'drop' }
      | { kind: 'restore'; text: string; text_hash: string }
    >
  >,
  Holds<Exact<Data<'theme_edit'>, ThemeEditResult>>,
  Holds<Exact<Args<'theme_copy'>, { from: string; name: string }>>,
  Holds<Exact<Data<'theme_copy'>, ThemeCopied>>,
  Holds<Exact<Args<'theme_create'>, Omit<z.input<typeof BrandInputSchema>, 'replace'>>>,
  Holds<Exact<Data<'theme_create'>, Omit<ThemeCreated, 'dir'>>>,
  Holds<Exact<Args<'brand_files'>, { kind: 'image' | 'font' }>>,
  Holds<Exact<Data<'brand_files'>, BrandFileList>>,
  Holds<Exact<Args<'site_list'>, { url?: string | undefined }>>,
  Holds<Exact<Data<'site_list'>, SiteListAnswer>>,
  Holds<Exact<Args<'library_view'>, { project: string; theme?: string | undefined }>>,
  Holds<Exact<Data<'library_view'>, LibraryViewAnswer>>,
  Holds<Exact<Args<'library_images'>, { project: string; keys?: string[] | undefined; committed?: string[] | undefined }>>,
  Holds<Exact<Data<'library_images'>, LibraryImagesAnswer>>,
  Holds<Exact<Args<'library_render'>, { project: string; theme?: string | undefined; items: Array<{ component: string; poster?: string | undefined; loop?: string | undefined }>; retry?: boolean | undefined }>>,
  Holds<Exact<Data<'library_render'>, LibraryRenderAnswer>>,
  Holds<Exact<Args<'library_component'>, { project: string; component: string }>>,
  Holds<Exact<Data<'library_component'>, LibraryComponentAnswer>>,
  Holds<Exact<Data<'theme_preview'>, ThemePreviewAnswer>>,
];

describe('StudioTools types of the theme and library operations', () => {
  it('are held at compile time (tsconfig.test.json)', () => {
    expect(true).toBe(true);
  });
});
