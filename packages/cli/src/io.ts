import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { CliError } from './errors.js';

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
  /** Ask for a line of text on the terminal; an empty answer gives `def` (when given). */
  ask?: (question: string, def?: string) => Promise<string>;
}

/** Lines typed (or pasted) ahead of their question: answers for the next questions. */
const ahead: string[] = [];

/**
 * One line from the terminal. A readline per question, closed once answered: between questions the terminal is back to
 * normal (Ctrl-C stops the command, e.g. while a login window is open); lines that came with the answer wait for the
 * next questions. Ctrl-C at a question, or the end of the input, is "no answer".
 */
async function readAnswer(prompt: string): Promise<string> {
  const queued = ahead.shift();
  if (queued !== undefined) {
    process.stderr.write(`${prompt}${queued}\n`);
    return queued;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve, reject) => {
    let answered = false;
    rl.on('line', (line) => {
      if (answered) {
        ahead.push(line);
        return;
      }
      answered = true;
      // Closed once the rest of this input chunk was read (its lines are the next answers), then answered: the next
      // question's readline takes the input over.
      setImmediate(() => {
        rl.close();
        resolve(line);
      });
    });
    rl.on('SIGINT', () => rl.close());
    rl.on('close', () => {
      if (answered) return;
      process.stderr.write('\n');
      reject(new CliError('no answer: the input was closed'));
    });
    rl.setPrompt(prompt);
    rl.prompt();
  });
}

async function askYesNo(question: string): Promise<boolean> {
  return /^y(es)?$/i.test((await readAnswer(`${question} [y/N] `)).trim());
}

async function askLine(question: string, def?: string): Promise<string> {
  const answer = (await readAnswer(`${question}${def ? ` [${def}]` : ''}: `)).trim();
  return answer === '' && def !== undefined ? def : answer;
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
    ask: askLine,
  };
}

/**
 * Io that records everything (tests, embedding). With `answers`, it can prompt: each question (`ask` or `confirm`)
 * takes the next answer ("y" / "yes" confirms); running out of answers is an error naming the question.
 */
export function memoryIo(opts: { color?: boolean; answers?: string[] } = {}): Io & { stdout: () => string; stderr: () => string; questions: () => string[] } {
  let o = '';
  let e = '';
  const answers = [...(opts.answers ?? [])];
  const questions: string[] = [];
  const next = (q: string): string => {
    questions.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`no scripted answer for: ${q}`);
    e += `${q} ${a}\n`;
    return a;
  };
  return {
    out: (t) => void (o += t),
    err: (t) => void (e += t),
    interactive: false,
    canPrompt: opts.answers !== undefined,
    color: opts.color ?? false,
    ...(opts.answers !== undefined
      ? {
          confirm: async (q: string) => /^y(es)?$/i.test(next(q).trim()),
          ask: async (q: string, def?: string) => {
            const a = next(q).trim();
            return a === '' && def !== undefined ? def : a;
          },
        }
      : {}),
    stdout: () => o,
    stderr: () => e,
    questions: () => questions,
  };
}
