/**
 * The update's Tools, before its restart (DESIGN §4p (d)). Once the shell has downloaded and verified an update,
 * it hands the kept archive to its own server — one stdin line `{"type":"update_archive","version","path","sha256"}`
 * (shell-line.ts, strict) — and waits (update_flow State::PreparingTools, TOOLS_MS at most). Here:
 *
 * 1-2. the engine checks the file (a plain file of this account's, the shell's archive name, its SHA-256 the line's)
 *    and reads the new version's bundle.json from it with /usr/bin/tar, its `tools` checked against the manifest's
 *    rules and the hosts' allow-list (engine.tools.readUpdate: engine tools/update-archive.ts);
 * 3. the Tools it names that are missing are downloaded and checked by the same installer as a person's download
 *    (engine.tools.installUpdate: kept by `.pending.json` until that version starts), while this version runs on its
 *    own Tools, untouched;
 * 4. the shell is told `{"type":"update_tools","version","state":"ready"|"failed"|"skip"}` (DesktopPipe.updateTools).
 *    `skip`: this version cannot read the new version's manifest whole (update-archive.ts): the quit goes on and the
 *    new version downloads its Tools at its first start — this version never decides which later releases install.
 *    While another install holds the Tools (the person's own download, a terminal's, a previous prepare that is
 *    ending), the update's waits for it and then goes on, within the shell's own limit (TOOLS_MS, 30 minutes).
 *
 * The shell's next state line that is not the preparing, waiting or installing of that version (Later, a failure)
 * gives it up: the download pauses and its Tools are no longer kept (engine.tools.abandonUpdate). The Studio's update
 * sheet reads the progress through desktop_update_status (`tools`). Nothing here comes from a page.
 */
import { toolsState } from '@retake/core/io';
import type { ToolEntry, ToolId } from '@retake/core/io';
import type { Engine } from '@retake/engine';
import type { InstallResult } from '@retake/engine/tools';
import type { DesktopPipe } from './desktop.js';

/** The shell's line (shell-line.ts parseShellLine). */
export interface UpdateArchiveLine {
  type: 'update_archive';
  version: string;
  path: string;
  sha256: string;
}

/** What the update sheet shows of the update's Tools (desktop_update_status `tools`). */
export interface UpdateToolsView {
  version: string;
  state: 'preparing' | 'ready' | 'failed';
  /** Bytes to download (the Tools not here yet) and received so far. */
  total: number;
  received: number;
  tools: Array<{ id: ToolId; label: string; name: string; version: string; bytes: number; here: boolean }>;
  /** Why it failed (ours, or the system's: shown as text). */
  untrusted?: { message: string };
}

/** The shell's update state as `follow` reads it (update-ops.ts UpdateLine). */
interface UpdateStateLine {
  state: string;
  version?: string | null;
}

/** The update's Tools under way (one at a time) and what the sheet shows of the last one. */
/** The longest an update's install waits for another one to end (the shell's TOOLS_MS). */
export const UPDATE_WAIT_MS = 30 * 60 * 1000;

/** Wait `ms`, or less when `signal` is aborted. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), done()), { once: true });
  });
}

export class UpdateTools {
  view: UpdateToolsView | undefined;
  private abort: AbortController | undefined;

  /** `pollMs`: how often a busy Tools folder is looked at again (tests: less). */
  constructor(private readonly o: { engine: () => Engine; pipe: DesktopPipe; pollMs?: number }) {}

  /** The update's install; while another install holds the Tools, wait for it to end and try again (UPDATE_WAIT_MS at most). */
  private async installWhenFree(
    e: Engine,
    req: { app: string; entries: readonly ToolEntry[]; signal: AbortSignal; onProgress: NonNullable<Parameters<Engine['tools']['installUpdate']>[0]['onProgress']> },
  ): Promise<InstallResult> {
    const until = Date.now() + UPDATE_WAIT_MS;
    for (;;) {
      const r = await e.tools.installUpdate(req);
      if (r.outcome !== 'busy' || req.signal.aborted || Date.now() >= until) return r;
      do await pause(this.o.pollMs ?? 500, req.signal);
      while (!req.signal.aborted && Date.now() < until && e.tools.status().by);
    }
  }

  /** The shell's `update_archive` line: check, read, install, answer. */
  async prepare(l: UpdateArchiveLine): Promise<void> {
    this.giveUp();
    const abort = new AbortController();
    this.abort = abort;
    this.view = { version: l.version, state: 'preparing', total: 0, received: 0, tools: [] };
    try {
      const e = this.o.engine();
      const read = await e.tools.readUpdate({ version: l.version, path: l.path, sha256: l.sha256 });
      if (abort.signal.aborted) return;
      if ('skip' in read) {
        // A manifest this version cannot read: nothing downloaded now, the new version downloads its Tools at its start.
        this.view = { ...this.view, state: 'ready' };
        this.o.pipe.updateTools(l.version, 'skip');
        return;
      }
      const entries = read.entries;
      const here = toolsState(entries, e.tools.status().folder).map((s) => s.state === 'ready');
      const tools = entries.map((t, i) => ({ id: t.id, label: t.label, name: t.name, version: t.version, bytes: t.bytes, here: here[i]! }));
      this.view = { ...this.view, tools, total: tools.filter((t) => !t.here).reduce((n, t) => n + t.bytes, 0) };
      const r = await this.installWhenFree(e, {
        app: l.version,
        entries,
        signal: abort.signal,
        onProgress: (run) => {
          if (this.view?.version !== l.version) return;
          this.view.received = entries.filter((_, i) => !here[i]).reduce((n, t) => n + Math.min(run.tools[t.id]?.received ?? 0, t.bytes), 0);
        },
      });
      if (abort.signal.aborted) return;
      if (r.outcome !== 'ready') throw new Error(r.message ?? `the download ended ${r.outcome}`);
      this.view = { ...this.view, state: 'ready', received: this.view.total };
      this.o.pipe.updateTools(l.version, 'ready');
    } catch (err) {
      if (abort.signal.aborted || this.view?.version !== l.version) return;
      this.view = { ...this.view, state: 'failed', untrusted: { message: err instanceof Error ? err.message : String(err) } };
      try {
        this.o.pipe.updateTools(l.version, 'failed');
      } catch {
        /* the pipe closed: the shell's own limit ends its wait */
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  /** The shell's update state: anything but this version's preparing, waiting or installing gives it up. */
  follow(l: UpdateStateLine): void {
    const v = this.view;
    if (!v) return;
    const same = l.version === v.version;
    if (same && (l.state === 'preparing' || l.state === 'waiting' || l.state === 'installing')) return;
    if (same && l.state === 'failed' && v.state === 'failed') return;
    this.giveUp();
  }

  /** The server's close: the download under way pauses; the update's Tools stay kept (the restart may come next). */
  stop(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Stop the download under way (what arrived is kept), and no longer keep the update's Tools. */
  giveUp(): void {
    const v = this.view;
    this.abort?.abort();
    this.abort = undefined;
    if (!v) return;
    this.view = undefined;
    try {
      this.o.engine().tools.abandonUpdate(v.version);
    } catch {
      /* a checkout: nothing kept */
    }
  }
}
