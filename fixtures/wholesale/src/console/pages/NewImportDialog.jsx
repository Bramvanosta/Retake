import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../../shared/api.js';
import { COUNTRY_CODES, Flag } from '../../shared/art.jsx';
import { Modal } from '../../shared/dialog.jsx';
import { fileSize, num } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { navigate } from '../../shared/router.jsx';
import { SelectField } from '../../shared/select.jsx';
import { notify } from '../../shared/toast.jsx';
import { Avatar } from '../../shared/ui.jsx';
import { FileTile } from './Imports.jsx';

/**
 * Drop zone with real drag & drop handlers and a hidden file input (click to browse).
 * Keeps its height once a file is chosen so the dialog does not jump.
 */
function DropZone({ file, onFile, onRemove }) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  return (
    <label
      className="dropzone"
      data-dragging={dragging || undefined}
      data-has-file={(file && !dragging) || undefined}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (!dragging) setDragging(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile({ name: f.name, size: f.size });
      }}
    >
      <input
        type="file"
        className="visually-hidden"
        accept=".xlsx,.xls,.csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile({ name: f.name, size: f.size });
          e.target.value = '';
        }}
      />
      {file && !dragging ? (
        <>
          <FileCard file={file} onRemove={onRemove} />
          <span className="dz-hint">Drop another file here to replace it</span>
        </>
      ) : (
        <>
          <span className="dz-icon">
            <Icon name="upload" size={20} />
          </span>
          <span className="dz-title">{dragging ? 'Drop to upload' : 'Drop your price list here'}</span>
          <span className="dz-link">Click to choose a file</span>
          <span className="dz-hint">Excel or CSV, up to 20 MB</span>
        </>
      )}
    </label>
  );
}

function FileCard({ file, org, onRemove, children }) {
  return (
    <div className="file-card">
      <FileTile name={file.name} />
      <div className="grow">
        <div className="file-name">{file.name}</div>
        <div className="file-meta">
          {fileSize(file.size)}
          {org ? ` · ${org.name}` : ' · Ready to import'}
        </div>
        {children}
      </div>
      {onRemove ? (
        <button
          type="button"
          className="icon-btn"
          aria-label="Remove file"
          onClick={(e) => {
            e.preventDefault();
            onRemove();
          }}
        >
          <Icon name="x" size={16} />
        </button>
      ) : null}
    </div>
  );
}

function ImportResult({ job }) {
  const summary = job.summary ?? [];
  const max = Math.max(1, ...summary.map((s) => s.offers));
  return (
    <div className="import-result" data-testid="import-result">
      <div className="result-icon">
        <Icon name="check" size={26} strokeWidth={2.4} />
      </div>
      <div className="result-count">{num(job.offers)} offers created</div>
      <div className="muted">
        {job.file_name} · {job.regions} markets · no errors
      </div>
      <div className="region-bars" aria-label="Offers by market">
        {summary.map((s, i) => (
          <div className="region-bar" key={s.region}>
            <Flag code={COUNTRY_CODES[s.region]} />
            <span>{s.region}</span>
            <b className="tabular">{num(s.offers)}</b>
            <div className="bar">
              <span style={{ width: `${(s.offers / max) * 100}%`, animationDelay: `${i * 40}ms` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Keeps polling an import after its dialog was closed, then toasts the result. */
async function followInBackground(id, onDone) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    const imp = await api.get(`/api/imports/${id}`).catch(() => null);
    if (!imp || imp.status === 'processing') continue;
    onDone();
    notify({ title: 'Import complete', description: `${num(imp.offers)} offers created from ${imp.file_name}` });
    return;
  }
}

export function NewImportDialog({ open, onOpenChange, onImported }) {
  const orgs = useApi('/api/organizations');
  const [orgId, setOrgId] = useState(undefined);
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const jobRef = useRef(job);
  jobRef.current = job;

  useEffect(() => {
    if (open) return undefined;
    if (jobRef.current?.status === 'processing') followInBackground(jobRef.current.id, onImported);
    const t = setTimeout(() => {
      setOrgId(undefined);
      setFile(null);
      setJob(null);
      setError(null);
    }, 200);
    return () => clearTimeout(t);
  }, [open, onImported]);

  useEffect(() => {
    if (!job || job.status !== 'processing') return undefined;
    const t = setTimeout(async () => {
      try {
        const next = await api.get(`/api/imports/${job.id}`);
        setJob(next);
        if (next.status !== 'processing') onImported();
      } catch (e) {
        setError(e);
      }
    }, 160);
    return () => clearTimeout(t);
  }, [job, onImported]);

  const org = (orgs.data ?? []).find((o) => o.id === orgId);
  const phase = !job ? 'form' : job.status === 'processing' ? 'running' : 'done';

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const created = await api.post('/api/imports', { organization_id: orgId, file_name: file.name, file_size: file.size });
      setJob(created);
      onImported();
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }

  const footer =
    phase === 'form' ? (
      <>
        <span className="footer-note">Existing offers are updated, never duplicated.</span>
        <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!orgId || !file || starting} onClick={start}>
          {starting ? <span className="spinner" /> : <Icon name="upload" size={16} />}
          Start import
        </button>
      </>
    ) : phase === 'running' ? (
      <>
        <span className="footer-note">This usually takes a few seconds.</span>
        <button type="button" className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          Continue in background
        </button>
      </>
    ) : (
      <>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            onOpenChange(false);
            navigate('/availability');
          }}
        >
          View availability
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onOpenChange(false)}>
          Done
        </button>
      </>
    );

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={phase === 'done' ? 'Import complete' : 'New import'}
      description={phase === 'done' ? 'Your price list is live in every market below.' : 'Upload a price list to create offers for every market you sell in.'}
      footer={footer}
    >
      {phase === 'form' ? (
        <>
          <SelectField
            id="import-organization"
            label="Organisation"
            placeholder="Select an organisation"
            value={orgId}
            onValueChange={setOrgId}
            options={(orgs.data ?? []).map((o) => ({
              value: o.id,
              label: o.name,
              sub: o.city,
              leading: <Avatar initials={o.initials} tone={o.tone} size="sm" />,
            }))}
          />
          <div className="field">
            <span className="field-label">Price list</span>
            <DropZone file={file} onFile={setFile} onRemove={() => setFile(null)} />
          </div>
        </>
      ) : null}
      {phase === 'running' ? (
        <div className="import-progress" aria-live="polite">
          <FileCard file={file} org={org} />
          <div className="stage">
            <span className="row gap-8">
              <span className="spinner" style={{ color: 'var(--accent)' }} />
              {job.stage}…
            </span>
            <span className="tabular muted">{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="progress" role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(4, job.progress * 100)}%` }} />
          </div>
        </div>
      ) : null}
      {phase === 'done' ? <ImportResult job={job} /> : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          <Icon name="alert" size={18} />
          <div>{error.message}</div>
        </div>
      ) : null}
    </Modal>
  );
}
