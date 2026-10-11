import { useState } from 'react';
import { useApi } from '../../shared/api.js';
import { dayTime, fileSize, num } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { today } from '../../shared/session.js';
import { Avatar, EmptyState, ErrorNote, PageHeader, StatusBadge, Skeleton } from '../../shared/ui.jsx';
import { NewImportDialog } from './NewImportDialog.jsx';

export function FileTile({ name }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return <span className={`file-tile ${ext === 'csv' ? 'csv' : ''}`}>{ext.toUpperCase().slice(0, 4)}</span>;
}

function Stats({ imports }) {
  const done = imports.filter((i) => i.status === 'completed');
  const latestPerOrg = new Map();
  for (const i of done) if (!latestPerOrg.has(i.organization_id)) latestPerOrg.set(i.organization_id, i);
  const live = [...latestPerOrg.values()].reduce((s, i) => s + i.offers, 0);
  const latest = done[0];
  return (
    <div className="stats">
      <div className="card stat">
        <div className="stat-label">
          <Icon name="layers" size={16} /> Live offers
        </div>
        <div className="stat-value">{num(live)}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">
          <Icon name="upload" size={16} /> Imports this quarter
        </div>
        <div className="stat-value">{imports.filter((i) => i.created_at >= '2026-10-01').length}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">
          <Icon name="users" size={16} /> Organisations
        </div>
        <div className="stat-value">{new Set(imports.map((i) => i.organization_id)).size}</div>
      </div>
      <div className="card stat">
        <div className="stat-label">
          <Icon name="clock" size={16} /> Last import
        </div>
        <div className="stat-value" style={{ fontSize: 20, paddingTop: 5 }}>
          {latest ? dayTime(latest.created_at, today) : '—'}
        </div>
      </div>
    </div>
  );
}

function ImportStatus({ imp }) {
  if (imp.status === 'completed' && imp.warnings > 0) {
    return <StatusBadge status="warnings" label={`${imp.warnings} warning${imp.warnings > 1 ? 's' : ''}`} />;
  }
  return <StatusBadge status={imp.status} />;
}

export function ImportsPage() {
  const { data, error, reload } = useApi('/api/imports');
  const [open, setOpen] = useState(false);
  const imports = data ?? [];
  return (
    <div className="page">
      <PageHeader
        title="Imports"
        description="Upload a price list to create offers for every market you sell in."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            <Icon name="upload" size={17} />
            New import
          </button>
        }
      />
      <ErrorNote error={error} />
      {data ? <Stats imports={imports} /> : null}
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>File</th>
              <th>Organisation</th>
              <th>Imported</th>
              <th className="num">Offers</th>
              <th className="num">Markets</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {!data
              ? [0, 1, 2, 3].map((i) => (
                  <tr key={i}>
                    <td colSpan={6}>
                      <Skeleton h={22} />
                    </td>
                  </tr>
                ))
              : imports.map((imp) => (
                  <tr key={imp.id} data-import={imp.id}>
                    <td>
                      <div className="row gap-12">
                        <FileTile name={imp.file_name} />
                        <div>
                          <div className="cell-title">{imp.file_name}</div>
                          <div className="cell-sub">
                            {fileSize(imp.file_size)} · by {imp.by}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="org-cell">
                        <Avatar initials={imp.organization?.initials ?? '?'} tone={imp.organization?.tone} size="sm" />
                        {imp.organization?.name}
                      </div>
                    </td>
                    <td className="tabular">{dayTime(imp.created_at, today)}</td>
                    <td className="num">{imp.status === 'failed' ? '—' : num(imp.offers)}</td>
                    <td className="num">{imp.status === 'failed' ? '—' : imp.regions}</td>
                    <td>
                      <div className="stack gap-4" style={{ alignItems: 'flex-start' }}>
                        <ImportStatus imp={imp} />
                        {imp.error ? <span className="cell-sub">{imp.error}</span> : null}
                      </div>
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {data && imports.length === 0 ? <EmptyState icon="upload" title="No imports yet" /> : null}
      </div>
      <NewImportDialog open={open} onOpenChange={setOpen} onImported={reload} />
    </div>
  );
}
