/** The cursor overlay's host element (the resolver and the change watchers skip it). */
export let host: HTMLElement;
/** Create the overlay's host element (where the kit installs itself: after a previous kit was disposed). */
export function createHost(): void {
  host = document.createElement('retake-cursor');
}
