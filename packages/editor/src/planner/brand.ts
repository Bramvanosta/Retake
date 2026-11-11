/** A step of `planEdit`: the brand the compositions draw with (the theme's tokens, colours, fonts, logo, wordmark). */
import { fontFileFace } from '@retake/components/geometry';
import type { PlanBrand } from '../plan-types.js';
import type { PlanScope } from './scope.js';

/** The theme as the compositions draw it: tokens, colours, fonts, logo and wordmark. */
export function planBrand(s: PlanScope): PlanBrand {
  const { tokens, t, displayUrl, bodyUrls, template, logoUrl, wordmarkUrl } = s;
  const brand: PlanBrand = {
    tokens,
    colors: structuredClone(t.colors),
    background: structuredClone(t.background),
    captions: structuredClone(t.captions),
    intro: structuredClone(t.intro),
    outro: structuredClone(t.outro),
    interstitial: structuredClone(t.interstitial),
    brandmark: structuredClone(t.brandmark ?? { position: 'bottom-right' }),
    frame: structuredClone(t.frame),
    style_bias: t.style_bias,
    fonts: {
      display: { family: tokens.fonts.display, url: displayUrl },
      body: bodyUrls.map((url, i) => ({ family: tokens.fonts.body, url, weight: fontFileFace(template.assets.body[i]).weight })),
    },
    logo: { url: logoUrl },
  };
  if (wordmarkUrl) brand.wordmark = { url: wordmarkUrl };
  return brand;
}
