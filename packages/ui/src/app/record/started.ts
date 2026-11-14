/** What this tab started (shared by the start form, the view's poll and the recording's screen). */

/** record_start's job per recording, for this tab: the view needs it until the recording's folder exists. */
export const startedJobs = new Map<string, string>();
/** A recording just started from this tab: its title takes the focus when its route opens (the Start button is gone). */
export const focusOnArrival = new Set<string>();
