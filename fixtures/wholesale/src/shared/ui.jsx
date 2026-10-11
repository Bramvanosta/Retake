import { Icon } from './icons.jsx';
import { Link } from './router.jsx';

export function Spinner({ size = 16, style }) {
  return <span className="spinner" style={{ width: size, height: size, ...style }} aria-hidden="true" />;
}

export function Skeleton({ h = 16, w = '100%', r, style }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} aria-hidden="true" />;
}

export function Avatar({ initials, tone = 'burgundy', size }) {
  return <span className={`avatar tone-${tone} ${size ? `avatar-${size}` : ''}`}>{initials}</span>;
}

const STATUS = {
  active: ['green', 'Active'],
  published: ['green', 'Published'],
  completed: ['green', 'Completed'],
  accepted: ['green', 'Accepted'],
  paused: ['amber', 'Paused'],
  warnings: ['amber', 'Completed with warnings'],
  draft: ['', 'Draft'],
  scheduled: ['blue', 'Scheduled'],
  processing: ['blue', 'Processing'],
  enriching: ['blue', 'Enriching'],
  requested: ['blue', 'Awaiting proposal'],
  proposal: ['accent', 'Proposal received'],
  failed: ['red', 'Failed'],
  declined: ['red', 'Declined'],
  archived: ['', 'Archived'],
};

export function StatusBadge({ status, label }) {
  const [tone, text] = STATUS[status] ?? ['', status];
  return (
    <span className={`badge ${tone ? `badge-${tone}` : ''}`} data-status={status}>
      {status === 'processing' || status === 'enriching' ? <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> : <span className="dot" />}
      {label ?? text}
    </span>
  );
}

export function Breadcrumbs({ items }) {
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      {items.map(([label, to], i) => (
        <span key={label} className="crumb">
          {i > 0 ? <Icon name="chevronRight" size={14} /> : null}
          {to ? <Link to={to}>{label}</Link> : <span aria-current="page">{label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({ title, description, actions, crumbs, children }) {
  return (
    <header className="page-header">
      {crumbs ? <Breadcrumbs items={crumbs} /> : null}
      <div className="page-header-row">
        <div className="grow">
          <h1 className="page-title">{title}</h1>
          {description ? <p className="page-description">{description}</p> : null}
        </div>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}

export function EmptyState({ icon = 'inbox', title, children }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <strong>Something went wrong</strong>
        {error.message}
      </div>
    </div>
  );
}

/** Segmented tabs (role=tablist). items: [[value, label, count?]] */
export function Segmented({ value, onChange, items, label }) {
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {items.map(([v, text, count]) => (
        <button key={v} role="tab" type="button" aria-selected={value === v} onClick={() => onChange(v)}>
          {text}
          {count !== undefined ? <span className="count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}
