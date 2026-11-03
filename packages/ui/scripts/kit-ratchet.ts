/**
 * L5.9 (review A-M3): the kit-only lint and its ratchet, shared by app-source.test.ts and `pnpm -F @retake/ui ratchet`
 * (scripts/ratchet.ts). A TypeScript-parser pass over a screen's source finds what only the kit may draw:
 * - a native control or disclosure (`<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`, `<progress>`, `<meter>`,
 *   `<details>`, `<summary>`, `<label>`);
 * - a widget role (button, checkbox, radio, tab, slider, switch, menuitem, option, combobox…), or a role that is not a
 *   literal (an expression or a template the lint cannot read);
 * - a kit class (`k-…`, but the utilities `k-sr`, `k-mono`, `k-scope`);
 * - a legacy token (any non `--ui-*` token of tokens.ts) written in the TypeScript (a `style`, a `getPropertyValue`).
 * The legacy screens' findings were counted per file in test/legacy-controls.json: a count could only stay or go DOWN
 * (≤ its row). L5.12d: the last legacy screens are rebuilt and the legacy layer (app.css, its classes and tokens) is
 * deleted — the table is `{}` and every file holds zero findings; a class word no stylesheet defines is the className
 * lint's (app-source.test.ts). The script still lowers rows and never raises one.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { tokenMap } from '../src/app/tokens.js';

export const APP_DIR = fileURLToPath(new URL('../src/app/', import.meta.url));
export const TABLE_FILE = fileURLToPath(new URL('../test/legacy-controls.json', import.meta.url));

/** The kit's utility classes any file may use (hidden text, mono figures, an appearance scope's surface). */
export const KIT_UTILITIES = new Set(['k-sr', 'k-mono', 'k-scope']);
/** Native controls, dialogs and disclosures: the kit draws them. */
export const KIT_TAGS = new Set(['button', 'input', 'select', 'textarea', 'dialog', 'progress', 'meter', 'details', 'summary', 'label']);
/** The ARIA widget and composite roles: a control built by hand. */
export const KIT_ROLES = new Set([
  'button',
  'checkbox',
  'radio',
  'radiogroup',
  'switch',
  'tab',
  'tablist',
  'tabpanel',
  'slider',
  'spinbutton',
  'searchbox',
  'textbox',
  'combobox',
  'listbox',
  'option',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'progressbar',
  'scrollbar',
  'tree',
  'treeitem',
  'treegrid',
  'grid',
  'gridcell',
  'toolbar',
  'dialog',
  'alertdialog',
  'link',
]);
/** The class names a stylesheet's selectors use (comments stripped, @media blocks walked). */
export function cssClasses(css: string): Set<string> {
  const out = new Set<string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{/g)) for (const c of m[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)) out.add(c[1]);
  return out;
}

/** The legacy tokens (every token but the kit's `--ui-*`; none since L5.12d — kept so that one added back is a finding). */
export function legacyTokens(): Set<string> {
  return new Set([...tokenMap('dark').keys()].filter((k) => !k.startsWith('--ui-')));
}

export interface RatchetContext {
  /** The legacy tokens. */
  tokens: Set<string>;
}

/** The literal strings inside a node (a string, a template's text, the strings of a conditional). */
function literals(n: ts.Node): string[] {
  const out: string[] = [];
  const visit = (x: ts.Node) => {
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) out.push(x.text);
    else if (ts.isTemplateExpression(x)) {
      out.push(x.head.text);
      for (const s of x.templateSpans) {
        visit(s.expression);
        out.push(s.literal.text);
      }
      return;
    }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return out;
}

/** The kit-only findings of one TSX source (see the header). */
export function offKit(file: string, text: string, ctx: RatchetContext): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const at = (n: ts.Node) => `${file}:${src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1}`;
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(src);
      if (KIT_TAGS.has(tag)) out.push(`${at(n)} <${tag}>`);
      for (const a of n.attributes.properties) {
        if (!ts.isJsxAttribute(a) || !a.initializer) continue;
        const name = a.name.getText(src);
        const init = a.initializer;
        if (name === 'role') {
          const lit = ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression) ? init.expression.text : null;
          if (lit === null) out.push(`${at(n)} role ${init.getText(src)} (not a literal)`);
          else if (KIT_ROLES.has(lit)) out.push(`${at(n)} role ${lit}`);
        }
        if (name === 'className') {
          for (const word of literals(init).flatMap((s) => s.split(/\s+/)).filter(Boolean)) {
            if (word.startsWith('k-') && !KIT_UTILITIES.has(word)) out.push(`${at(n)} class ${word}`);
          }
        }
      }
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      for (const m of n.text.matchAll(/--[a-z][\w-]*/g)) if (ctx.tokens.has(m[0])) out.push(`${at(n)} legacy token ${m[0]}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** The legacy screens' rows: file → the most findings it may hold. */
export async function readTable(): Promise<Record<string, number>> {
  return JSON.parse(await readFile(TABLE_FILE, 'utf8')) as Record<string, number>;
}

/** Every TSX source of the app outside ui-kit/, with its findings. */
export async function ratchetFindings(): Promise<Map<string, string[]>> {
  const tokens = legacyTokens();
  const files = (await readdir(APP_DIR, { recursive: true })).filter((f) => f.endsWith('.tsx') && !f.startsWith('ui-kit/')).sort();
  const out = new Map<string, string[]>();
  for (const f of files) out.set(f, offKit(f, await readFile(join(APP_DIR, f), 'utf8'), { tokens }));
  return out;
}
