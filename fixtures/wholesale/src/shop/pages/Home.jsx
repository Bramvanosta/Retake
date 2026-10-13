import { useState } from 'react';
import { useApi } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { dateTimeLong } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { session } from '../../shared/session.js';
import { CardSkeletons, ProductCard } from '../components.jsx';

const SHELVES = [
  ['awards', 'Award winners', 'Competition lots and top-scoring coffees from this harvest.'],
  ['arrivals', 'Fresh arrivals', 'New-crop coffees from Ethiopia, Kenya and Rwanda.'],
  ['espresso', 'Espresso staples', 'Sweet, balanced coffees that shine in milk drinks.'],
];

/**
 * The only element of the fixture that reads the BROWSER's clock (everything else shows the server's demo date): the
 * "prices as of" line, shown on `/#as-of` only — the read-only scenario films it with a set clock; the other scenarios
 * film `/` and stay as they were (a hash: the browser bar of a video shows no trace of the flag).
 */
function PricesAsOf() {
  const [now] = useState(() => new Date());
  return (
    <p className="hero-asof" data-testid="prices-as-of">
      Prices as of {dateTimeLong(now)}
    </p>
  );
}

export function HomePage() {
  const { data } = useApi('/api/products?status=published');
  const [showAsOf] = useState(() => window.location.hash === '#as-of');
  const products = data ?? [];
  return (
    <>
      <section className="hero-banner">
        <div className="hero-copy">
          <span className="hero-kicker">
            <Icon name="sparkles" size={14} /> Winter arrivals · delivering to {session.buyer.country}
          </span>
          <h1>Fresh-crop coffees, roasted to order for your café</h1>
          <p>Request a quote on any lot, choose your bag sizes and delivery window, and get a proposal from the roaster within hours.</p>
          {showAsOf ? <PricesAsOf /> : null}
          <div className="row gap-12" style={{ marginTop: 8 }}>
            <Link to="/coffees" className="btn btn-lg btn-light">
              Browse coffees
            </Link>
            <Link to="/quotes" className="btn btn-lg btn-outline-light">
              Your quotes
            </Link>
          </div>
        </div>
        <div className="hero-collage" aria-hidden="true">
          <CoffeeArt palette="berry" seed="hero-1" className="c1" beansCount={3} />
          <CoffeeArt palette="apricot" seed="hero-2" className="c2" beansCount={4} />
          <CoffeeArt palette="lemon" seed="hero-3" className="c3" beansCount={3} />
        </div>
      </section>

      {SHELVES.map(([key, title, sub]) => {
        const items = products.filter((p) => p.shelves.includes(key)).slice(0, 4);
        return (
          <section className="shelf" key={key} aria-labelledby={`shelf-${key}`}>
            <div className="shelf-head">
              <div>
                <h2 className="shelf-title" id={`shelf-${key}`}>
                  {title}
                </h2>
                <div className="shelf-sub">{sub}</div>
              </div>
              <Link to="/coffees" className="link">
                See all <Icon name="arrowRight" size={15} />
              </Link>
            </div>
            {data ? (
              <div className="cards">
                {items.map((p) => (
                  <ProductCard key={p.slug} p={p} />
                ))}
              </div>
            ) : (
              <CardSkeletons />
            )}
          </section>
        );
      })}

      <section className="value-props">
        {[
          ['receipt', 'Quotes within hours', 'Tell the roaster what you need; get a priced proposal you can accept in one click.'],
          ['calendar', 'Your delivery window', 'Pick the days that suit your café — roasted at most five days before delivery.'],
          ['globe', 'Labels in your language', 'Bags are labelled in the language of your market, ready for your shelves.'],
        ].map(([icon, title, text]) => (
          <div className="card value-prop" key={title}>
            <span className="vp-icon">
              <Icon name={icon} size={20} />
            </span>
            <div>
              <div style={{ fontWeight: 650, fontSize: 15 }}>{title}</div>
              <div className="muted" style={{ marginTop: 2 }}>
                {text}
              </div>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
