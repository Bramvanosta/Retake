'use strict';
/**
 * The module lookup guard of Retake.app (L5.16, DESIGN §4p), staged as Contents/Resources/node/guard.cjs and given to
 * every Node.js the app starts as an argument (`node --require <Resources>/node/guard.cjs …`: the launcher, the shell's
 * Studio server, the jobs worker, the MCP registration) — never through NODE_OPTIONS, which the app drops.
 *
 * Node.js looks a bare specifier (`require('x')`, `import 'x'`) up in every `node_modules` folder from the importing
 * file to `/`, then in $HOME/.node_modules, $HOME/.node_libraries and <prefix>/lib/node. For the app's own code that
 * walk leaves the app: `Retake.app/node_modules`, `/Applications/node_modules` (writable by any admin process), `/`,
 * `~/node_modules` for a copy in ~/Applications — a module there would run inside the app's Node.js, under its
 * signature and its grants. Here a file inside Resources (this file's parent folder) resolves bare specifiers inside
 * Resources only: CommonJS through `Module._nodeModulePaths` and `Module._resolveLookupPaths`, ES modules through a
 * resolve hook (guard-hooks.mjs, `module.register`). A file outside Resources — the person's workspace components, a
 * JavaScript hook, a sandbox script — keeps Node.js's lookup from its own folder.
 */
const Module = require('node:module');
const { realpathSync } = require('node:fs');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = realpathSync(dirname(__dirname));
const inside = (p) => {
  const rel = relative(root, resolve(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const nodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function guardedNodeModulePaths(from) {
  const paths = nodeModulePaths.call(this, from);
  return inside(from) ? paths.filter(inside) : paths;
};

/** Where a module looks from: its file, or — `require.resolve(x, { paths })`'s parent has none — its first folder. */
const from = (parent) => (parent && typeof parent.filename === 'string' && parent.filename) || (parent && Array.isArray(parent.paths) && parent.paths[0]) || null;
const resolveLookupPaths = Module._resolveLookupPaths;
Module._resolveLookupPaths = function guardedResolveLookupPaths(request, parent) {
  const paths = resolveLookupPaths.call(this, request, parent);
  // The global folders ($HOME/.node_modules…) are added here, after the parent's own paths.
  const at = from(parent);
  return Array.isArray(paths) && at && inside(at) ? paths.filter(inside) : paths;
};

Module.register(pathToFileURL(join(__dirname, 'guard-hooks.mjs')), { data: { root } });
