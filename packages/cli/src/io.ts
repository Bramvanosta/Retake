import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

export type Colors = ReturnType<typeof pc.createColors>;

/** Where a command writes. Injected so the CLI can run in-process (tests, other tools). */
export interface Io {
  /** Machine-readable output and command results. */
  out: (text: string) => void;
  /** Progress, diagnostics and errors. */
  err: (text: string) => void;
  /** stderr is an interactive terminal: a live status line may be redrawn in place. */
  interactive: boolean;
  /** stdin is an interactive terminal: the CLI may ask questions. */
  canPrompt: boolean;
  color: boolean;
  /** Ask a yes/no question on the terminal (default answer: no). */
  confirm?: (question: string) => Promise<boolean>;
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Io bound to the process streams. */
export function processIo(): Io {
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    interactive: process.stderr.isTTY === true && process.env.TERM !== 'dumb',
    canPrompt: process.stdin.isTTY === true,
    color: pc.isColorSupported,
    confirm: askYesNo,
  };
}

/** Io that records everything (tests, embedding). */
export function memoryIo(opts: { color?: boolean } = {}): Io & { stdout: () => string; stderr: () => string } {
  let o = '';
  let e = '';
  return {
    out: (t) => void (o += t),
    err: (t) => void (e += t),
    interactive: false,
    canPrompt: false,
    color: opts.color ?? false,
    stdout: () => o,
    stderr: () => e,
  };
}
