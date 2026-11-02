/**
 * L5.11a: the status bar's polite line, for anything outside the shell (Prepare, the live screen): the shell sets the
 * one function that writes it; a call before the shell mounted is dropped. It says command answers and a run's start,
 * stop or refusal — never a step's progress (critique M4 of the plan: no news per step).
 */
let sayFn: (s: string) => void = () => undefined;

export function setSay(fn: (s: string) => void): () => void {
  sayFn = fn;
  return () => {
    if (sayFn === fn) sayFn = () => undefined;
  };
}

export function say(s: string): void {
  sayFn(s);
}
