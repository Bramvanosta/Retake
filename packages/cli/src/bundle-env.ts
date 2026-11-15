/**
 * Loaded by bin.js before main.js: when Retake runs from an app bundle, playwright-core is loaded once with the
 * bundle's browsers (core prepareBundle), before anything else imports it; the environment is left as it was.
 */
import { prepareBundle } from '@retake/core/io';

prepareBundle();
