import { Menu } from '@base-ui/react/menu';
import { useState } from 'react';
import { api, useApi } from '../../shared/api.js';
import { CoffeeArt, Flag } from '../../shared/art.jsx';
import { Confirm } from '../../shared/dialog.jsx';
import { date, monthShort, range } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { notify } from '../../shared/toast.jsx';
import { EmptyState, ErrorNote, PageHeader, Segmented, Skeleton, StatusBadge } from '../../shared/ui.jsx';
import { EditAvailabilityDialog } from './EditAvailabilityDialog.jsx';

/** Row actions: a Base UI Menu (opens on press; items fire on click). */
function RowActions({ row, onEdit, onPause, onResume, onArchive }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="icon-btn" aria-label="Row actions">
        <Icon name="more" size={18} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="positioner" side="bottom" align="end" sideOffset={6}>
          <Menu.Popup className="floating" style={{ width: 200 }}>
            <Menu.Item className="menu-item" onClick={() => onEdit(row)}>
              <Icon name="pencil" size={16} />
              Edit
            </Menu.Item>
            {row.status === 'paused' ? (
              <Menu.Item className="menu-item" onClick={() => onResume(row)}>
                <Icon name="play" size={16} />
                Resume
              </Menu.Item>
            ) : (
              <Menu.Item className="menu-item" disabled={row.status === 'archived'} onClick={() => onPause(row)}>
                <Icon name="pause" size={16} />
                Pause
              </Menu.Item>
            )}
            <Menu.Separator className="menu-separator" />
            <Menu.Item className="menu-item danger" disabled={row.status === 'archived'} onClick={() => onArchive(row)}>
              <Icon name="archive" size={16} />
              Archive
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const MARKET_GROUPS = [
  ['Nordics', ['IS', 'SE', 'NO', 'DK', 'FI']],
  ['Baltics', ['EE', 'LV', 'LT']],
  ['Western Europe', ['DE', 'FR', 'NL', 'BE', 'IE']],
  ['Central Europe', ['AT', 'CH', 'PL']],
];
const DAY = 86_400_000;
const toDay = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY;

/** Gantt-style overview of the delivery windows, one bar per market group. */
function WindowsOverview({ rows }) {
  const groups = MARKET_GROUPS.map(([name, codes]) => [name, rows.filter((r) => codes.includes(r.code) && r.status !== 'archived')]).filter(
    ([, rs]) => rs.length > 0,
  );
  if (groups.length === 0) return null;
  const starts = rows.map((r) => r.window_start).sort();
  const ends = rows.map((r) => r.window_end).sort();
  const first = new Date(`${starts[0].slice(0, 7)}-01T00:00:00Z`);
  const lastEnd = new Date(`${ends.at(-1)}T00:00:00Z`);
  const months = [];
  for (let d = new Date(first); d <= lastEnd; d.setUTCMonth(d.getUTCMonth() + 1)) months.push(new Date(d));
  const t0 = first.getTime() / DAY;
  const t1 = Date.UTC(lastEnd.getUTCFullYear(), lastEnd.getUTCMonth() + 1, 1) / DAY;
  const pct = (iso) => ((toDay(iso) - t0) / (t1 - t0)) * 100;
  return (
    <div className="card windows">
      <div className="windows-head">
        <div className="card-title">Delivery windows</div>
        <div className="windows-legend">
          <span>
            <i className="lg-active" /> Active
          </span>
          <span>
            <i className="lg-scheduled" /> Scheduled
          </span>
          <span>
            <i className="lg-paused" /> Paused
          </span>
        </div>
      </div>
      <div className="windows-grid">
        <div />
        <div className="windows-months">
          {months.map((m) => (
            <span key={m.toISOString()}>{monthShort(m.getUTCMonth())}</span>
          ))}
        </div>
        {groups.map(([name, rs]) => {
          const s = rs.map((r) => r.window_start).sort()[0];
          const e = rs.map((r) => r.window_end).sort().at(-1);
          const active = rs.filter((r) => r.status === 'active').length;
          const paused = rs.filter((r) => r.status === 'paused').length;
          const scheduled = rs.length - active - paused;
          return [
            <div key={`${name}-label`} className="windows-label">
              <span>{name}</span>
              <span className="windows-flags">
                {rs.map((r) => (
                  <Flag key={r.code} code={r.code} />
                ))}
              </span>
            </div>,
            <div key={`${name}-track`} className="windows-track" style={{ '--months': months.length }}>
              <div className="windows-bar" style={{ left: `${pct(s)}%`, width: `${pct(e) - pct(s)}%` }}>
                <span className="seg seg-active" style={{ flex: active }} />
                <span className="seg seg-scheduled" style={{ flex: scheduled }} />
                <span className="seg seg-paused" style={{ flex: paused }} />
                <b>{range(s, e)}</b>
              </div>
            </div>,
          ];
        })}
      </div>
    </div>
  );
}

function Chips({ items, max = 3 }) {
  const shown = items.slice(0, max);
  return (
    <div className="chips">
      {shown.map((x) => (
        <span className="chip" key={x}>
          {x}
        </span>
      ))}
      {items.length > max ? <span className="chip">+{items.length - max}</span> : null}
    </div>
  );
}

export function AvailabilityPage({ params }) {
  const slug = params.slug;
  const { data, error, setData } = useApi(`/api/availability/${encodeURIComponent(slug)}`);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [pausing, setPausing] = useState(null);
  const [busy, setBusy] = useState(false);

  const patchRow = async (row, patch) => {
    const updated = await api.patch(`/api/availability/${encodeURIComponent(slug)}/${row.id}`, patch);
    setData((d) => ({ ...d, rows: d.rows.map((r) => (r.id === updated.id ? updated : r)) }));
    return updated;
  };

  if (error) {
    return (
      <div className="page">
        <EmptyState icon="search" title="This coffee does not exist">
          <Link className="link" to="/availability">
            Back to availability
          </Link>
        </EmptyState>
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const p = data?.product;
  const count = (s) => rows.filter((r) => r.status === s).length;
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
  const active = rows.filter((r) => r.status === 'active');
  const reserved = active.length ? Math.round(active.reduce((s, r) => s + r.reserved_pct, 0) / active.length) : 0;
  const nextWindow = rows.map((r) => r.window_start).sort()[0];

  return (
    <div className="page">
      <PageHeader
        crumbs={[['Availability', '/availability'], [p?.name ?? '…']]}
        title="Availability by market"
        description="Delivery windows, bag sizes, grinds and label languages for every market."
      />
      {p ? (
        <div className="card avail-head">
          <CoffeeArt palette={p.palette} seed={p.slug} beansCount={2} variant="crop" />
          <div>
            <div className="eyebrow">
              {p.origin} · {p.region}
            </div>
            <h2 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.025em', margin: '4px 0 8px' }}>
              <Link to={`/products/${p.slug}`}>{p.name}</Link>
            </h2>
            <div className="chips">
              <span className="chip">{p.variety}</span>
              <span className="chip">{p.process}</span>
              <span className="chip">Harvest {p.harvest_year}</span>
              <span className="chip chip-accent">{p.score.toFixed(1)} pts</span>
            </div>
          </div>
          <div className="avail-stats">
            <div>
              <div className="k">Markets</div>
              <div className="v">{rows.length}</div>
            </div>
            <div>
              <div className="k">Active</div>
              <div className="v">{active.length}</div>
            </div>
            <div>
              <div className="k">Reserved</div>
              <div className="v">{reserved}%</div>
            </div>
            <div>
              <div className="k">Next window</div>
              <div className="v" style={{ fontSize: 17, paddingTop: 4 }}>
                {nextWindow ? date(nextWindow) : '—'}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Skeleton h={160} r={14} style={{ marginBottom: 22 }} />
      )}
      {data ? <WindowsOverview rows={rows} /> : null}

      <div className="toolbar">
        <Segmented
          label="Filter markets"
          value={filter}
          onChange={setFilter}
          items={[
            ['all', 'All markets', rows.length],
            ['active', 'Active', count('active')],
            ['paused', 'Paused', count('paused')],
            ['scheduled', 'Scheduled', count('scheduled')],
          ]}
        />
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Market</th>
              <th>Delivery window</th>
              <th>Bag sizes</th>
              <th>Grind options</th>
              <th>Label languages</th>
              <th>Reserved</th>
              <th>Status</th>
              <th className="actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {!data
              ? [0, 1, 2, 3, 4, 5].map((i) => (
                  <tr key={i}>
                    <td colSpan={8}>
                      <Skeleton h={28} />
                    </td>
                  </tr>
                ))
              : shown.map((r) => (
                  <tr key={r.id} data-status={r.status} data-region={r.region}>
                    <td>
                      <div className="market-cell">
                        <Flag code={r.code} />
                        <span className="cell-title">{r.region}</span>
                        <span className="code">{r.code}</span>
                      </div>
                    </td>
                    <td className="window-cell">
                      <div className="tabular">{range(r.window_start, r.window_end)}</div>
                      <div className="cell-sub">Min. {r.min_order_bags} bag{r.min_order_bags > 1 ? 's' : ''} per order</div>
                    </td>
                    <td>
                      <Chips items={r.bag_sizes} max={4} />
                    </td>
                    <td>
                      <Chips items={r.grind_options} />
                    </td>
                    <td>
                      <Chips items={r.label_languages} />
                    </td>
                    <td>
                      <div className="reserved">
                        <div className="track">
                          <span style={{ width: `${r.reserved_pct}%` }} />
                        </div>
                        {r.reserved_pct}%
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="actions">
                      <RowActions
                        row={r}
                        onEdit={setEditing}
                        onPause={setPausing}
                        onResume={async (row) => {
                          await patchRow(row, { status: 'active' });
                          notify({ title: `${row.region} resumed`, description: `${p.name} is orderable again in ${row.region}.` });
                        }}
                        onArchive={async (row) => {
                          await patchRow(row, { status: 'archived' });
                          notify({ title: `${row.region} archived`, description: 'The market no longer appears to buyers.' });
                        }}
                      />
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {data && shown.length === 0 ? <EmptyState icon="globe" title="No markets with this status" /> : null}
      </div>

      <Confirm
        open={pausing !== null}
        onOpenChange={(o) => !o && setPausing(null)}
        icon="pause"
        title={pausing ? `Pause availability in ${pausing.region}?` : ''}
        description={
          pausing
            ? `Cafés in ${pausing.region} won’t be able to order ${p?.name} until you resume it. Quote requests you already received are kept.`
            : ''
        }
        confirmLabel="Pause"
        busy={busy}
        onConfirm={async () => {
          const row = pausing;
          setBusy(true);
          try {
            await patchRow(row, { status: 'paused' });
            setPausing(null);
            notify({ title: `${row.region} paused`, description: `${p.name} is hidden from cafés in ${row.region}.` });
          } finally {
            setBusy(false);
          }
        }}
      />
      <EditAvailabilityDialog
        product={p}
        row={editing}
        onClose={() => setEditing(null)}
        onSave={async (row, patch) => {
          await patchRow(row, patch);
          setEditing(null);
          notify({ title: `${row.region} updated`, description: 'Bag sizes, grinds and label languages saved.' });
        }}
      />
    </div>
  );
}

export function AvailabilityIndexPage() {
  const { data, error } = useApi('/api/products?status=active');
  return (
    <div className="page">
      <PageHeader title="Availability" description="Choose a coffee to manage where and when cafés can order it." />
      <ErrorNote error={error} />
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Coffee</th>
              <th>Origin</th>
              <th>Markets</th>
              <th>Status</th>
              <th className="actions" aria-label="Open" />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.slug} className="row-link">
                <td>
                  <Link to={`/availability/products/${p.slug}`} className="coffee-cell">
                    <CoffeeArt palette={p.palette} seed={p.slug} className="thumb" beansCount={0} variant="crop" />
                    <div>
                      <div className="cell-title">{p.name}</div>
                      <div className="cell-sub">{p.lot_number}</div>
                    </div>
                  </Link>
                </td>
                <td>
                  {p.origin} <span className="muted">· {p.region}</span>
                </td>
                <td className="tabular">
                  {p.active_markets} <span className="muted">/ {p.markets} active</span>
                </td>
                <td>
                  <StatusBadge status={p.status} />
                </td>
                <td className="actions">
                  <Link className="icon-btn" to={`/availability/products/${p.slug}`} aria-label={`Open ${p.name}`}>
                    <Icon name="chevronRight" size={18} />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
