/**
 * @retake/compose — the product's composition: the adapters of the product's packages behind the engine's ports and the
 * ports bag that wires them (`productPorts`), the jobs worker's entry (worker-main.ts). The shells build their engine
 * from it; the engine depends on core and the adapters' domain entries only.
 */
export { bindProduct, productAdapters, productPorts } from './ports.js';
export { editorRenderer, withPreviewBackend } from './editor-renderer.js';
export { packageHookRunner } from './package-hooks.js';
export { packageRegistries } from './package-registries.js';
export { packageSandboxes } from './package-sandboxes.js';
export { packageReviewer } from './review-package.js';
export { runnerWebCapture } from './runner-web-capture.js';
