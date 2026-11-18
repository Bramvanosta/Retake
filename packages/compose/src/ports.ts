/**
 * The product's ports: the engine's ports bag with the adapters of the product's packages — the hooks package's runner,
 * the review package's reviewer, the runner package's capture, the sandbox package's sandboxes, the editor's renderer,
 * the components package's registries — and the engine's own adapters for the rest (the engine's enginePorts). The
 * one place those package adapters are made by default: a composition root (the CLI, the MCP server, the Studio
 * server, the jobs worker and its job processes) calls `productPorts`, which binds the product into the engine first.
 */
import { fileURLToPath } from 'node:url';
import { bindProduct as bindEngineProduct, enginePorts, guardUntrusted, productBound } from '@retake/engine/composition';
import type { EngineEnv, EnginePorts, Product, ProductAdapters, Secrets } from '@retake/engine/composition';
import { editorRenderer } from './editor-renderer.js';
import { components, editor } from './lazy.js';
import { packageHookRunner } from './package-hooks.js';
import { packageRegistries } from './package-registries.js';
import { packageSandboxes } from './package-sandboxes.js';
import { packageReviewer } from './review-package.js';
import { runnerWebCapture } from './runner-web-capture.js';

/**
 * The product's adapters of the package ports, the given ones kept: the sandboxes on the bag's secrets and hook runner.
 * The ones made here refuse an imported project not trusted on every member that runs its code (the engine's
 * guardUntrusted, judged with `env`'s Retake home): a gate below the operations', whoever calls them.
 */
export function productAdapters(given: Partial<EnginePorts>, secrets: Secrets, env: EngineEnv = {}): ProductAdapters {
  const hooks = given.hooks ?? packageHookRunner();
  const g = guardUntrusted(
    { hooks, reviewer: packageReviewer(), capture: runnerWebCapture(), sandboxes: packageSandboxes(secrets, hooks), renderer: editorRenderer(), registries: packageRegistries() },
    env,
  );
  // The ports handed are kept as they are (a test's, a root's own); only the ones made here are guarded.
  return {
    hooks: given.hooks ?? g.hooks,
    reviewer: given.reviewer ?? g.reviewer,
    capture: given.capture ?? g.capture,
    sandboxes: given.sandboxes ?? g.sandboxes,
    renderer: given.renderer ?? g.renderer,
    registries: given.registries ?? g.registries,
  };
}

/** The worker entry beside this file: worker-main.js when built, worker-main.ts when run from the sources. */
const WORKER_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker-main.ts' : './worker-main.js', import.meta.url));

/** The product: its adapter modules, its package adapters and its worker entry (one object: binding it again is a no-op). */
const PRODUCT: Product = { modules: { editor, components }, adapters: productAdapters, workerEntry: WORKER_ENTRY };

/** Bind the product into the engine: a no-op when it is bound already; refused when another product is. */
export function bindProduct(): void {
  bindEngineProduct(PRODUCT);
}

/** The ports given, the product's adapters for the others (the product bound first, when no product is). */
export function productPorts(given: Partial<EnginePorts> = {}): EnginePorts {
  if (!productBound()) bindProduct();
  return enginePorts(given);
}
