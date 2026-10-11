import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useDeferredValue, useState } from 'react';
import { useApi } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { eur } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link, navigate } from '../../shared/router.jsx';
import { urls } from '../../shared/session.js';
import { notify } from '../../shared/toast.jsx';
import { EmptyState, ErrorNote, PageHeader, Segmented, Skeleton, StatusBadge } from '../../shared/ui.jsx';
import { AddCoffeeDialog } from './AddCoffeeDialog.jsx';

/** Row actions: a Radix DropdownMenu (opens on pointerdown). */
function ProductActions({ product }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="icon-btn" aria-label="Product actions">
        <Icon name="more" size={18} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="floating" align="end" sideOffset={6} style={{ width: 220 }}>
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate(`/products/${product.slug}`)}>
            <Icon name="eye" size={16} />
            Open product
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item" onSelect={() => navigate(`/availability/products/${product.slug}`)}>
            <Icon name="globe" size={16} />
            View availability
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="menu-item"
            disabled={product.status !== 'published'}
            onSelect={() => window.open(`${urls.shop}/products/${product.slug}`, '_blank', 'noopener')}
          >
            <Icon name="store" size={16} />
            View in shop
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item
            className="menu-item"
            onSelect={() => {
              navigator.clipboard?.writeText(product.lot_number).catch(() => {});
              notify({ title: 'Lot number copied', description: product.lot_number });
            }}
          >
            <Icon name="copy" size={16} />
            Copy lot number
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function ProductsPage() {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('active');
  const [adding, setAdding] = useState(false);
  const q = useDeferredValue(query);
  const all = useApi('/api/products?status=all');
  const products = (all.data ?? []).filter((p) => (tab === 'archived' ? p.status === 'archived' : p.status !== 'archived'));
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? products.filter((p) => [p.name, p.farm, p.producer, p.origin, p.region, p.variety].join(' ').toLowerCase().includes(needle))
    : products;
  const counts = {
    active: (all.data ?? []).filter((p) => p.status !== 'archived').length,
    archived: (all.data ?? []).filter((p) => p.status === 'archived').length,
  };

  return (
    <div className="page">
      <PageHeader
        title="Coffees"
        description="Every lot you sell, with tasting notes, producers and prices per bag size."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={17} strokeWidth={2.2} />
            Add a coffee
          </button>
        }
      />
      <ErrorNote error={all.error} />
      <div className="toolbar">
        <div className="input-icon search">
          <Icon name="search" size={17} />
          <input
            className="input"
            type="search"
            placeholder="Search coffees, producers, origins…"
            aria-label="Search coffees"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Segmented
          label="Status"
          value={tab}
          onChange={setTab}
          items={[
            ['active', 'Active', counts.active],
            ['archived', 'Archived', counts.archived],
          ]}
        />
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Coffee</th>
              <th>Origin</th>
              <th>Process</th>
              <th className="num">Harvest</th>
              <th className="num">Score</th>
              <th className="num">Price / kg</th>
              <th>Markets</th>
              <th>Status</th>
              <th className="actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {!all.data
              ? [0, 1, 2, 3, 4].map((i) => (
                  <tr key={i}>
                    <td colSpan={9}>
                      <Skeleton h={30} />
                    </td>
                  </tr>
                ))
              : shown.map((p) => (
                  <tr key={p.slug} className="row-link">
                    <td>
                      <Link to={`/products/${p.slug}`} className="coffee-cell">
                        <CoffeeArt palette={p.palette} seed={p.slug} className="thumb" beansCount={0} variant="crop" />
                        <div>
                          <div className="cell-title">{p.name}</div>
                          <div className="cell-sub">
                            {p.lot_number} · {p.variety}
                          </div>
                        </div>
                      </Link>
                    </td>
                    <td>
                      <div>{p.origin}</div>
                      <div className="cell-sub">{p.region}</div>
                    </td>
                    <td>{p.process}</td>
                    <td className="num">{p.harvest_year}</td>
                    <td className="num score">{p.score.toFixed(1)}</td>
                    <td className="num">{eur(p.prices['5 kg'])}</td>
                    <td>
                      {p.markets ? (
                        <span className="tabular">
                          {p.active_markets} <span className="muted">/ {p.markets} active</span>
                        </span>
                      ) : (
                        <span className="muted">Not listed yet</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="actions">
                      <ProductActions product={p} />
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {all.data && shown.length === 0 ? (
          <EmptyState icon="search" title={needle ? `No coffees match “${q}”` : 'No coffees here yet'} />
        ) : null}
      </div>
      <AddCoffeeDialog open={adding} onOpenChange={setAdding} />
    </div>
  );
}
