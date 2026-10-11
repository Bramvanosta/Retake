import { useEffect, useRef, useState } from 'react';
import { api } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { Modal } from '../../shared/dialog.jsx';
import { Icon } from '../../shared/icons.jsx';
import { Link, navigate } from '../../shared/router.jsx';

const DEBOUNCE_MS = 280;
/** While typing continuously, still refresh the results at least this often. */
const MAX_WAIT_MS = 700;

/** Debounced registry search: results follow the typing with a short delay. */
function useRegistrySearch(query) {
  const [state, setState] = useState({ results: [], loading: false, searched: '' });
  const burstStart = useRef(null);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      burstStart.current = null;
      setState({ results: [], loading: false, searched: '' });
      return undefined;
    }
    setState((s) => ({ ...s, loading: true }));
    let cancelled = false;
    burstStart.current ??= Date.now();
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, burstStart.current + MAX_WAIT_MS - Date.now()));
    const t = setTimeout(async () => {
      burstStart.current = null;
      try {
        const results = await api.get(`/api/registry?q=${encodeURIComponent(q)}`);
        if (!cancelled) setState({ results, loading: false, searched: q });
      } catch {
        if (!cancelled) setState({ results: [], loading: false, searched: q });
      }
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);
  return state;
}

export function AddCoffeeDialog({ open, onOpenChange }) {
  const [query, setQuery] = useState('');
  const [duplicate, setDuplicate] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(null);
  const inputRef = useRef(null);
  const { results, loading, searched } = useRegistrySearch(query);

  useEffect(() => {
    if (open) return undefined;
    const t = setTimeout(() => {
      setQuery('');
      setDuplicate(null);
      setError(null);
      setAdding(null);
    }, 200);
    return () => clearTimeout(t);
  }, [open]);

  async function add(entry) {
    setAdding(entry.ref);
    setDuplicate(null);
    setError(null);
    try {
      const product = await api.post('/api/products', { registry_ref: entry.ref });
      onOpenChange(false);
      navigate(`/products/${product.slug}`);
    } catch (e) {
      if (e.code === 'duplicate') setDuplicate({ entry, product: e.details?.product });
      else setError(e);
    } finally {
      setAdding(null);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Add a coffee"
      description="Search the Open Lot Registry — tasting notes, producer details and awards are filled in for you."
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <div className="input-icon">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          className="input"
          style={{ height: 46, fontSize: 15 }}
          type="text"
          placeholder="Coffee, farm, producer or registry reference"
          aria-label="Search the registry"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setDuplicate(null);
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <span className="input-trailing">{loading ? <span className="spinner" /> : null}</span>
      </div>

      {duplicate ? (
        <div className="alert alert-warning" role="alert">
          <Icon name="info" size={18} />
          <div className="grow">
            <strong>This coffee is already in your catalogue</strong>
            {duplicate.entry.name} ({duplicate.entry.harvest_year}) is linked to {duplicate.product?.name}
            {duplicate.product?.status === 'archived' ? ', which is archived' : ''}.{' '}
            {duplicate.product ? (
              <Link className="link" to={`/products/${duplicate.product.slug}`} onClick={() => onOpenChange(false)}>
                Open product
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="alert alert-error" role="alert">
          <Icon name="alert" size={18} />
          <div>{error.message}</div>
        </div>
      ) : null}

      <div>
        <div className="registry-head">
          <span className="eyebrow">Registry search</span>
          {searched && !loading ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {results.length} {results.length === 1 ? 'lot' : 'lots'}
            </span>
          ) : null}
        </div>
        {query.trim().length < 2 ? (
          <div className="registry-hint">Try a farm like “Finca Lirandel”, a region like “Huila” or a reference like GCR-26-0412.</div>
        ) : searched && results.length === 0 && !loading ? (
          <div className="registry-hint">No registry lots match “{searched}”.</div>
        ) : (
          <div className="registry-results" role="listbox" aria-label="Registry search results">
            {results.map((r, i) => (
              <button
                key={r.ref}
                type="button"
                role="option"
                aria-selected={false}
                className="registry-result"
                style={{ animationDelay: `${i * 30}ms` }}
                onClick={() => add(r)}
                disabled={adding !== null}
              >
                <CoffeeArt palette={r.palette} seed={r.ref} className="thumb" beansCount={0} variant="crop" />
                <div className="grow">
                  <div className="r-name">{r.name}</div>
                  <div className="r-meta">
                    {r.origin} · {r.region} · {r.variety} · {r.process.split(',')[0]}
                  </div>
                </div>
                {r.in_catalogue ? <span className="badge">In catalogue</span> : null}
                <span className="r-year">{r.harvest_year}</span>
                <span className="r-score">
                  <b>{r.score.toFixed(1)}</b>
                  pts
                </span>
                {adding === r.ref ? <span className="spinner" /> : <Icon name="chevronRight" size={16} style={{ color: 'var(--faint)' }} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
