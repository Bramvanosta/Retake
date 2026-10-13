import { useState } from 'react';
import { useApi } from '../../shared/api.js';
import { CoffeeArt, Flag } from '../../shared/art.jsx';
import { eur, range } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { session } from '../../shared/session.js';
import { Avatar, Breadcrumbs, EmptyState, Skeleton } from '../../shared/ui.jsx';
import { ProductCard } from '../components.jsx';
import '../brew-guide.js';
import { QuoteDialog } from './QuoteDialog.jsx';

export function ProductPage({ params }) {
  const { data: p, error } = useApi(`/api/products/${encodeURIComponent(params.slug)}`);
  const related = useApi('/api/products?status=published');
  const [quoting, setQuoting] = useState(false);

  if (error || (p && p.status !== 'published')) {
    return (
      <EmptyState icon="search" title="This coffee is not available">
        <Link className="link" to="/coffees">
          Browse all coffees
        </Link>
      </EmptyState>
    );
  }
  if (!p) {
    return (
      <div className="pdp">
        <Skeleton h={640} r={22} />
        <div className="stack gap-16">
          <Skeleton h={60} w="70%" />
          <Skeleton h={24} w="40%" />
          <Skeleton h={180} />
        </div>
      </div>
    );
  }

  const market = p.availability.find((r) => r.code === session.buyer.country_code && r.status === 'active');
  const more = (related.data ?? []).filter((x) => x.slug !== p.slug && x.origin === p.origin).slice(0, 4);
  const others = more.length ? more : (related.data ?? []).filter((x) => x.slug !== p.slug).slice(0, 4);

  return (
    <>
      <Breadcrumbs items={[['Discover', '/'], [p.origin, `/coffees?origin=${encodeURIComponent(p.origin)}`], [p.name]]} />
      <div className="pdp">
        <div className="pdp-gallery">
          <CoffeeArt className="main" palette={p.palette} seed={p.slug} badge={p.badge} beansCount={8} label={`${p.name}, product photo`} />
          <div className="pdp-thumbs" aria-hidden="true">
            {['bag', 'crop', 'beans', 'bag'].map((variant, i) => (
              <CoffeeArt key={i} palette={p.palette} seed={i === 0 ? p.slug : `${p.slug}-${i}`} beansCount={i === 0 ? 8 : 10} variant={variant} />
            ))}
          </div>
        </div>
        <div className="pdp-info">
          <div className="pdp-roaster">
            <Avatar initials={p.organization?.initials ?? 'NR'} size="sm" />
            {p.organization?.name}
            <span className="muted" style={{ fontWeight: 500 }}>
              · Roaster in {p.organization?.city}
            </span>
          </div>
          <div>
            <h1>{p.name}</h1>
            <div className="pdp-origin">
              <Icon name="pin" size={17} />
              {p.origin} · {p.region} · {p.altitude}
            </div>
          </div>
          <div className="pdp-badges">
            <span className="badge badge-accent">
              <Icon name="award" size={14} strokeWidth={2} />
              {p.score.toFixed(1)} points
            </span>
            {p.badge ? <span className="badge">{p.badge}</span> : null}
            <span className="badge">Harvest {p.harvest_year}</span>
          </div>
          <div className="notes">
            {p.notes.map((n) => (
              <span key={n} className="note-chip" style={{ height: 32 }}>
                {n}
              </span>
            ))}
          </div>
          <p className="pdp-story">{p.story}</p>
          <div className="spec-grid">
            {[
              ['Producer', p.producer],
              ['Variety', p.variety],
              ['Process', p.process],
              ['Altitude', p.altitude],
            ].map(([k, v]) => (
              <div key={k}>
                <div className="k">{k}</div>
                <div className="v">{v}</div>
              </div>
            ))}
          </div>
          <div className="avail-box">
            <div className="avail-box-head">
              <Flag code={session.buyer.country_code} />
              Delivers to {session.buyer.country}
              {market ? <span className="muted">· {range(market.window_start, market.window_end)}</span> : null}
              <span style={{ marginLeft: 'auto' }} className={`badge ${market ? 'badge-green' : 'badge-amber'}`}>
                <span className="dot" />
                {market ? 'Available' : 'Not available'}
              </span>
            </div>
            <div className="price-rows">
              {Object.entries(p.prices).map(([size, price]) => {
                const offered = market?.bag_sizes.includes(size);
                return (
                  <div key={size}>
                    <div className="k">{size} bags</div>
                    <div className={`v ${offered ? '' : 'unavailable'}`}>{offered ? `${eur(price)} / kg` : '—'}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="cta-row">
            <button type="button" className="btn btn-primary btn-lg" disabled={!market} onClick={() => setQuoting(true)}>
              <Icon name="receipt" size={18} />
              Request a quote
            </button>
            <button type="button" className="btn btn-secondary btn-lg" aria-label="Save to favourites">
              <Icon name="heart" size={18} />
              Save
            </button>
            <span className="reply">
              <Icon name="clock" size={15} /> Usually replies within 4 hours
            </span>
          </div>
        </div>
      </div>

      {others.length ? (
        <section className="shelf">
          <div className="shelf-head">
            <h2 className="shelf-title">{more.length ? `More from ${p.origin}` : 'You might also like'}</h2>
          </div>
          <div className="cards">
            {others.map((x) => (
              <ProductCard key={x.slug} p={x} />
            ))}
          </div>
        </section>
      ) : null}

      {/* At the bottom of the page, below what the other scenarios film: a web component with an open shadow root and
          a same-origin iframe widget (the `embedded` scenario films them, R-ISS-07). */}
      <section className="pdp-extras">
        <div className="shelf-head">
          <h2 className="shelf-title">Before you order</h2>
        </div>
        <div className="pdp-extras-grid">
          <nf-brew-guide coffee={p.name} />
          <iframe className="ship-frame" title="Shipping estimate" src={`/embed/shipping?product=${encodeURIComponent(p.slug)}`} />
        </div>
      </section>

      {market ? <QuoteDialog product={p} market={market} open={quoting} onOpenChange={setQuoting} /> : null}
    </>
  );
}
