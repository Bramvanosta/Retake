/**
 * The jobs worker's first import (L5.16; worker-main.ts runs without the CLI's bin.js): when Retake runs from an app
 * bundle, playwright-core is loaded once with the bundle's browsers (core prepareBundle), before the worker's modules
 * import it; the environment is left as it was.
 */
import { prepareBundle } from '@retake/core/io';

prepareBundle();
