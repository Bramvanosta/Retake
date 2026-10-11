import { CoffeeArt } from '../shared/art.jsx';
import { eur } from '../shared/format.js';
import { Icon } from '../shared/icons.jsx';
import { Link } from '../shared/router.jsx';

/** Lowest price per kg across bag sizes. */
export function fromPrice(prices) {
  return Math.min(...Object.values(prices));
}

export function ProductCard({ p }) {
  return (
    <Link to={`/products/${p.slug}`} className="product-card" data-product={p.slug}>
      <CoffeeArt palette={p.palette} seed={p.slug} badge={p.badge} />
      <div>
        <div className="pc-origin">
          {p.origin} · {p.region}
        </div>
        <div className="pc-name">{p.name}</div>
        <div className="pc-notes">{(p.notes ?? []).slice(0, 3).join(' · ')}</div>
      </div>
      <div className="pc-foot">
        <span className="price">
          from {eur(fromPrice(p.prices))} <small>/ kg</small>
        </span>
        <span className="pc-score">
          <Icon name="award" size={15} strokeWidth={2} />
          {p.score.toFixed(1)}
        </span>
      </div>
    </Link>
  );
}

export function CardSkeletons({ n = 4 }) {
  return (
    <div className="cards">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="product-card">
          <div className="skeleton" style={{ aspectRatio: '4 / 3', borderRadius: 16 }} />
          <div className="skeleton" style={{ height: 18, width: '60%' }} />
          <div className="skeleton" style={{ height: 14, width: '80%' }} />
        </div>
      ))}
    </div>
  );
}
