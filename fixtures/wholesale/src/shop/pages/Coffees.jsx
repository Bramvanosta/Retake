import { useApi } from '../../shared/api.js';
import { navigate, useLocation } from '../../shared/router.jsx';
import { Segmented, PageHeader, EmptyState } from '../../shared/ui.jsx';
import { CardSkeletons, ProductCard } from '../components.jsx';

export function CoffeesPage() {
  const { search } = useLocation();
  const q = search.get('q') ?? '';
  const origin = search.get('origin') ?? 'all';
  const { data } = useApi(`/api/products?status=published${q ? `&q=${encodeURIComponent(q)}` : ''}`);
  const products = data ?? [];
  const origins = [...new Set(products.map((p) => p.origin))].sort();
  const shown = origin === 'all' ? products : products.filter((p) => p.origin === origin);
  const setOrigin = (o) => {
    const params = new URLSearchParams(search);
    if (o === 'all') params.delete('origin');
    else params.set('origin', o);
    const qs = params.toString();
    navigate(`/coffees${qs ? `?${qs}` : ''}`, { scroll: false });
  };
  return (
    <>
      <PageHeader
        title={q ? `Coffees matching “${q}”` : 'All coffees'}
        description="Roasted to order by Northfield Roasters and delivered across the Nordics and Europe."
      />
      {data && origins.length > 1 ? (
        <div style={{ marginBottom: 24 }}>
          <Segmented label="Origin" value={origin} onChange={setOrigin} items={[['all', 'All origins', products.length], ...origins.map((o) => [o, o])]} />
        </div>
      ) : null}
      {data ? (
        shown.length ? (
          <div className="cards">
            {shown.map((p) => (
              <ProductCard key={p.slug} p={p} />
            ))}
          </div>
        ) : (
          <EmptyState icon="search" title="No coffees match your search" />
        )
      ) : (
        <CardSkeletons n={8} />
      )}
    </>
  );
}
