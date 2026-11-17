/** Small text helpers shared by the CLI's output and the engine's messages (one wording for both). */
import type { UpResult } from '@retake/sandbox/types';

/** 850 → "850 ms", 4210 → "4.2 s", 75000 → "1 m 15 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} m ${String(s).padStart(2, '0')} s`;
}

/** "started fixture · healthy 1/1" / "running · healthy 3/3". */
export function sandboxUpText(up: Pick<UpResult, 'started' | 'kept'>): string {
  const total = up.started.length + up.kept.length;
  const what = up.started.length ? `started ${up.started.join(', ')}${up.kept.length ? `, kept ${up.kept.join(', ')}` : ''}` : 'running';
  return `${what} · healthy ${total}/${total}`;
}

/**
 * "3 Firebase Auth accounts put back — admin, owner sign in again at the next take, off camera": the accounts put
 * back sign out every session saved before; a persona without login steps cannot sign in again (a take refuses it).
 */
export function firebaseAuthText(f: { accounts: number; personas?: { login: string[]; no_login: string[] } }): string {
  const p = f.personas;
  const again = p?.login.length ? ` — ${p.login.join(', ')} sign${p.login.length === 1 ? 's' : ''} in again at the next take, off camera` : '';
  const none = p?.no_login.length
    ? ` (${p.no_login.join(', ')}: no login steps — give ${p.no_login.map((n) => `accounts.${n}`).join(', ')} login steps in sandbox.yaml, or the next take refuses ${p.no_login.length === 1 ? 'it' : 'them'})`
    : '';
  return `${f.accounts} Firebase Auth account${f.accounts === 1 ? '' : 's'} put back${again}${none}`;
}

/**
 * What a reset did with an outdated snapshot (R-SBX-10), or undefined: "snapshot outdated (the seed changed …): base
 * restored in 410 ms" / "… outdated snapshot restored (no base)" / "base kept in 9 ms (the database before its first
 * seed)". One wording for the CLI's reset line, a sandbox job's summary and a run's note.
 */
export function resetLadderText(r: { outdated?: { reason: string; from: 'base' | 'snapshot' }; base?: { action: 'taken' | 'restored'; ms: number } }): string | undefined {
  const o = r.outdated;
  if (o) return `snapshot outdated (${o.reason}): ${o.from === 'base' ? `base restored${r.base ? ` in ${formatMs(r.base.ms)}` : ''}` : 'outdated snapshot restored (no base)'}`;
  if (r.base?.action === 'taken') return `base kept in ${formatMs(r.base.ms)} (the database before its first seed)`;
  return undefined;
}

/**
 * What the next reset does with a sandbox's snapshot (R-SBX-12): `retake sandbox status`'s `snapshot` line and
 * sandbox_status's. The command to a fresh database follows where the data lives (FB-31): `down --volumes` for a
 * volume, `down` for a tmpfs or the container's own layer (every down takes it), `down --forget` when not known.
 */
export function snapshotStatusText(
  slug: string,
  env: string,
  s: { base: boolean; next?: string; reason?: string; detail?: string; new_cluster?: boolean; storage?: { kind: string; where?: string } },
): string {
  const base = s.base ? 'base kept' : 'no base';
  const down = `retake sandbox down ${slug} --env ${env}`;
  const up = `retake sandbox up ${slug} --env ${env}`;
  const kind = s.storage?.kind;
  const ephemeral = kind === 'tmpfs' || kind === 'container';
  const fresh = ephemeral
    ? `${down}, then ${up}`
    : kind === 'volume'
      ? `${down} --volumes (every volume of the sandbox), then ${up}`
      : kind === 'bind' || kind === 'external'
        ? `${down} --volumes, then ${up}, once ${kind === 'bind' ? `the folder ${s.storage?.where} is emptied (a bind mount: --volumes leaves it)` : `the external volume ${s.storage?.where} is removed (--volumes leaves it)`}`
        : `${down} --volumes --forget (every volume of the sandbox, and the records forgotten), then ${up}`;
  const anonymous = kind === 'volume' && !s.storage?.where;
  const where = ephemeral
    ? ` · data ${kind === 'tmpfs' ? 'in memory (tmpfs)' : "in the container's own layer"}: every down takes it`
    : anonymous
      ? ' · data in an anonymous volume: every down leaves it behind (the next up starts a new one)'
      : '';
  switch (s.next) {
    case 'restore':
      return `current · ${base}${where}`;
    case 'first-seed':
      return s.new_cluster
        ? `none — its Postgres is a new cluster (the data went with the old one): the next reset forgets the old seed and snapshot, keeps a base and seeds it${where}`
        : `none yet — the first seed keeps a base (the database before it), then takes the snapshot${where}`;
    case 'from-base':
      return `outdated (${s.reason}) — the next reset restores the base, restarts the services, seeds and takes a new snapshot${where}`;
    case 'from-snapshot':
      return `outdated (${s.reason}), no base — the next reset restores the outdated snapshot and seeds on it (seeds reset what they create); ${fresh} gives it a base${where}`;
    case 'refuse':
      return `no base nor snapshot, and the database already holds data — the next reset refuses: start from a fresh database in a terminal, ${fresh}${where}`;
    default:
      return `unknown (${s.detail ?? 'not read'})`;
  }
}
