/**
 * The ES module half of Retake.app's module lookup guard (guard.cjs registers it; staged as
 * Contents/Resources/node/guard-hooks.mjs): a bare specifier imported by a module inside Resources resolves inside
 * Resources, or not at all — never to a `node_modules` folder above the app. Relative, absolute and URL specifiers
 * (the engine importing a workspace component by its path) and every import made by a module outside Resources keep
 * Node.js's own resolution.
 */
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

let root = null;

export function initialize(data) {
  root = data && typeof data.root === 'string' ? data.root : null;
}

const inside = (p) => {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const fileOf = (url) => (typeof url === 'string' && url.startsWith('file:') ? fileURLToPath(url) : null);
/** `x`, `@scope/x/sub`, `#imports`: not `./`, `../`, `/`, nor a URL (`node:`, `file:`, `data:`). */
const bare = (s) => !/^(?:\.{1,2}(?:\/|$)|\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(s);

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (!root || !bare(specifier)) return result;
  const parent = fileOf(context.parentURL);
  const target = fileOf(result.url);
  if (parent && target && inside(parent) && !inside(target)) {
    const e = new Error(`Cannot find package '${specifier}' imported from ${parent} (Retake.app resolves its own modules inside the app only)`);
    e.code = 'ERR_MODULE_NOT_FOUND';
    throw e;
  }
  return result;
}
