import type { Ui } from './ui.js';
import { formatMs, truncate } from './ui.js';

/** One finished step of a long command. */
export interface StepTime {
  name: string;
  ms: number;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 120;

/**
 * The steps of a long command as they happen (hotfix v0.2.2: `retake sandbox up --build` printed its title, then nothing
 * for minutes). On an interactive terminal: one live line — a spinner, the step, its elapsed time and the last line of
 * what it is doing —, replaced by a `✓ step  time` line when the step ends. Otherwise (a pipe, CI): a time-stamped line
 * as each step starts and ends. `--verbose` prints every line the steps report either way (through Ui.debug: the
 * caller's log). `summary()` gives the time of each step.
 */
export class StepDisplay {
  private readonly done: StepTime[] = [];
  private current: { name: string; detail?: string; started: number; note?: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  constructor(
    private readonly ui: Ui,
    private readonly now: () => number = Date.now,
    private readonly columns: () => number = () => process.stderr.columns ?? 100,
  ) {}

  /** Start a step: the one before is over. */
  step(name: string, detail?: string): void {
    this.end();
    this.current = { name, ...(detail ? { detail } : {}), started: this.now() };
    if (this.ui.io.interactive) {
      this.timer ??= setInterval(() => this.draw(), TICK_MS);
      this.timer.unref?.();
      this.draw();
    } else {
      this.ui.line(`  ${this.ui.c.dim(clock(this.now()))}  ${name}${detail ? this.ui.c.dim(` — ${detail}`) : ''}`);
    }
  }

  /** One line of what the current step is doing (the live line shows the last one; --verbose prints them all). */
  note(text: string): void {
    if (!this.current) return;
    this.current.note = text;
    // Redrawn by the timer: a build prints hundreds of lines a second.
  }

  /** The current step is over (the command finished, or failed: `ok: false` marks it). */
  end(ok = true): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const ms = this.now() - cur.started;
    this.done.push({ name: cur.name, ms });
    const c = this.ui.c;
    if (this.ui.io.interactive) {
      this.ui.clearStatus();
      this.ui.line(`  ${ok ? c.green('✓') : c.red('✗')} ${cur.name}  ${c.dim(formatMs(ms))}`);
    } else {
      this.ui.line(`  ${c.dim(clock(this.now()))}  ${cur.name} ${ok ? 'done' : c.red('failed')} ${c.dim(`(${formatMs(ms)})`)}`);
    }
  }

  /** Stop the display (always, in a `finally`): the live line goes, the timer stops. */
  close(ok = true): void {
    this.end(ok);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ui.clearStatus();
  }

  /** The time of each step, in order. */
  times(): StepTime[] {
    return [...this.done];
  }

  /** "compose 0.4 s · build 3 m 02 s · start 41.0 s" (empty when no step ran). */
  summary(): string {
    return this.done.map((s) => `${s.name} ${formatMs(s.ms)}`).join(' · ');
  }

  private draw(): void {
    const cur = this.current;
    if (!cur) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    const head = `  ${FRAMES[this.frame]} ${cur.name} · ${formatMs(Math.floor((this.now() - cur.started) / 1000) * 1000)}`;
    const tail = cur.note ?? cur.detail ?? '';
    const room = Math.max(0, this.columns() - head.length - 4);
    this.ui.setStatus(`${head}${tail && room > 8 ? this.ui.c.dim(` · ${truncate(tail, room)}`) : ''}`);
  }
}

/** HH:MM:SS, local time. */
function clock(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}
