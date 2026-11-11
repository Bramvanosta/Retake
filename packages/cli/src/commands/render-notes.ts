import { projectPath } from '@retake/core';
import { latestRenderLines, renamedRenderLine } from '@retake/core/io';
import type { FoundRender } from '@retake/engine';

/**
 * What a terminal says of a render it found for `retake review` / `retake export` (core/io): what `latest` passed over
 * (the newer files of renders/ with the fixed words of their reason, then a count; the files that say nothing readable,
 * counted), and a record whose id is not its file's name (renamed or copied by hand: `renders/quote-final.json says it
 * is quote-v1`, an id that is no render id in fixed words). No text of a file is printed as the file has it.
 */
export function renderNotes(projectDir: string, found: Pick<FoundRender, 'latest' | 'file' | 'renamed' | 'record' | 'output'>): string[] {
  const line = renamedRenderLine(projectPath(projectDir, 'renders'), found);
  return [...latestRenderLines(found.latest), ...(line ? [line] : [])];
}
