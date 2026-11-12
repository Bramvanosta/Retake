import type { Confinement } from '@retake/core';

/**
 * The Studio's confinement as the engine hands it down (engine caller.ts `CONFINEMENTS.studio`; engine test
 * caller.test.ts holds the two equal): the words of a refusal of work from the Studio, for tests of core and the
 * adapters, which do not import the engine.
 */
export const STUDIO_CONFINEMENT: Confinement = Object.freeze({ words: 'from the Studio', approval: ' and the Studio cannot approve hooks yet — run it in a terminal' });
