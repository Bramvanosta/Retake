import type { RunProgress, RunRecord, TimelineEvent } from '@demo-studio/core';
import type { Ui } from './ui.js';
import { formatMs, truncate } from './ui.js';

const ACTION_WIDTH = 12;
const DESC_WIDTH = 64;

/**
 * Human rendering of RunProgress events: one line per step with its duration, hook results, warnings,
 * and a live "running…" line on interactive terminals.
 */
export class ProgressPrinter {
  private readonly started = performance.now();
  private hookPhase: string | null = null;
  private desc = '';

  constructor(private readonly ui: Ui) {}

  get elapsedMs(): number {
    return performance.now() - this.started;
  }

  handle(e: RunProgress): void {
    const { ui } = this;
    const c = ui.c;
    switch (e.type) {
      case 'run_start': {
        const r = e.run;
        const mode = r.mode === 'dry' ? c.cyan('dry run') : c.magenta('capture');
        const opts = [`env ${r.env}`, `hooks ${r.options.hooks}`];
        if (r.options.until) opts.push(`until ${r.options.until}`);
        if (r.options.headed) opts.push('headed');
        ui.line(`${c.bold(`${r.project}/${r.scenario}`)}  ${mode}  ${c.dim(opts.join(' · '))}`);
        ui.line(c.dim(`run ${r.id} → ${ui.path(r.dir)}`));
        break;
      }
      case 'hook': {
        if (e.status === 'start') {
          this.hookPhase = e.phase;
          ui.line(`${c.bold(e.phase)} ${c.dim(e.message ?? '')}`);
          break;
        }
        if (this.hookPhase !== e.phase) {
          this.hookPhase = e.phase;
          ui.line(c.bold(e.phase));
        }
        const icon = e.status === 'ok' ? c.green('✓') : e.status === 'skipped' ? c.dim('–') : c.red('✗');
        const msg = e.message ? (e.status === 'failed' ? c.red(e.message) : c.dim(e.message)) : '';
        ui.line(`  ${icon} ${truncate(e.name, 60)}  ${msg}`);
        break;
      }
      case 'scene_start':
        this.hookPhase = null;
        ui.line(`${c.cyan('▸')} ${c.bold(e.scene)}`);
        break;
      case 'step_start':
        this.desc = truncate(e.desc, DESC_WIDTH);
        ui.setStatus(c.dim(`  … ${this.stepLabel(e.step, e.action)} ${this.desc}`));
        break;
      case 'step_end': {
        ui.clearStatus();
        const note = e.message && e.status !== 'failed' ? `  ${c.dim(truncate(e.message, 80))}` : '';
        ui.line(`  ${this.statusIcon(e.status)} ${this.stepLabel(e.step, e.action)} ${this.desc.padEnd(DESC_WIDTH)} ${c.dim(formatMs(e.ms).padStart(8))}${note}`);
        if (e.status === 'failed' && e.message) ui.line(`      ${c.red(e.message)}`);
        this.desc = '';
        break;
      }
      case 'log':
        if (e.level === 'error') ui.error(e.message);
        else if (e.level === 'warn') ui.warn(e.message);
        else ui.debug(e.message); // info and debug: --verbose only
        break;
      case 'encode':
        if (e.status === 'start') {
          ui.line(`${c.bold('encode')} ${c.dim(e.message ?? '')}`);
          ui.setStatus(c.dim('  … encoding with ffmpeg'));
        } else {
          ui.clearStatus();
          if (e.message?.startsWith('failed')) ui.error(`encoding ${e.message}`);
        }
        break;
      case 'run_end':
        ui.clearStatus();
        break;
    }
  }

  private stepLabel(step: number, action: string): string {
    return `${String(step).padStart(2, ' ')} ${action.padEnd(ACTION_WIDTH)}`;
  }

  private statusIcon(status: TimelineEvent['status']): string {
    const c = this.ui.c;
    switch (status) {
      case 'ok':
        return c.green('✓');
      case 'failed':
        return c.red('✗');
      case 'dry':
        return c.cyan('◦');
      case 'skipped':
        return c.dim('–');
    }
  }
}

/** Short status word for a finished run. */
export function runStatusText(ui: Ui, r: RunRecord): string {
  const c = ui.c;
  switch (r.status) {
    case 'succeeded':
      return c.green(r.mode === 'dry' ? 'dry run succeeded' : 'capture succeeded');
    case 'failed':
      return c.red('run failed');
    case 'cancelled':
      return c.yellow('run cancelled');
    default:
      return r.status;
  }
}
