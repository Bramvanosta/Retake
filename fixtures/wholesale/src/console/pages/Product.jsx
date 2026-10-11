import { useEffect, useState } from 'react';
import { api, useApi } from '../../shared/api.js';
import { COUNTRY_CODES, CoffeeArt, Flag } from '../../shared/art.jsx';
import { dayTime, eur } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { today } from '../../shared/session.js';
import { notify } from '../../shared/toast.jsx';
import { EmptyState, PageHeader, Skeleton, StatusBadge } from '../../shared/ui.jsx';

const NOTE_COLORS = ['#e7b77d', '#c9667a', '#9a5aa5', '#e3a33b', '#7da36b', '#c4553f', '#6b4a3a', '#d98c9c'];
const noteColor = (note) => NOTE_COLORS[[...note].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % NOTE_COLORS.length];

function EnrichBanner({ enrichment }) {
  return (
    <div className="enrich-banner" role="status">
      <div className="enrich-icon">
        <Icon name="sparkles" size={20} />
      </div>
      <div>
        <div className="enrich-title">Enrichment in progress</div>
        <div className="muted" style={{ fontSize: 13.5 }}>
          Collecting registry data, cupping scores, producer details and awards…
        </div>
      </div>
      <div className="enrich-steps">
        {enrichment.steps.map((s) => (
          <span key={s.label} className="enrich-step" data-done={s.done || undefined}>
            {s.done ? <Icon name="check" size={14} strokeWidth={2.4} /> : <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} />}
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Wraps a section: skeleton while enriching, staggered reveal right after. */
function Section({ className, loading, reveal, index, skeletonHeight, children, ...rest }) {
  if (loading) {
    return (
      <section className={`card section-card ${className}`} aria-busy="true">
        <Skeleton h={18} w={160} style={{ marginBottom: 18 }} />
        <Skeleton h={skeletonHeight} />
      </section>
    );
  }
  return (
    <section
      className={`card section-card ${className} ${reveal ? 'reveal' : ''}`}
      style={reveal ? { animationDelay: `${index * 170}ms` } : undefined}
      {...rest}
    >
      {children}
    </section>
  );
}

function Hero({ p, loading, reveal }) {
  return (
    <section className={`card hero span-12 ${reveal ? 'reveal' : ''}`}>
      {loading ? <Skeleton h={420} r={14} /> : <CoffeeArt palette={p.palette} seed={p.slug} badge={p.badge} label={`${p.name}, product photo`} />}
      <div className="hero-info">
        <div className="hero-origin">
          <Icon name="pin" size={16} />
          {p.origin} · {p.region}
        </div>
        <div className="row gap-16" style={{ alignItems: 'center' }}>
          <h2 className="hero-name grow">{p.name}</h2>
          {loading ? (
            <Skeleton h={76} w={76} r={38} />
          ) : (
            <div className="score-ring" style={{ '--p': Math.max(0, (p.score - 80) / 15) }} aria-label={`Score ${p.score} points`}>
              <div>
                <b>{p.score.toFixed(1)}</b>
                <small>points</small>
              </div>
            </div>
          )}
        </div>
        <div className="facts">
          {[
            ['Producer', p.producer],
            ['Variety', p.variety],
            ['Process', p.process],
            ['Altitude', p.altitude],
            ['Harvest', p.harvest_year],
            ['Registry ref', p.registry_refs[0] ?? '—'],
          ].map(([k, v]) => (
            <div className="fact" key={k}>
              <div className="fact-label">{k}</div>
              <div className="fact-value">{v ?? <Skeleton h={16} w="70%" style={{ marginTop: 4 }} />}</div>
            </div>
          ))}
        </div>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Price per kg
          </div>
          <div className="price-table">
            {Object.entries(p.prices).map(([size, price]) => (
              <div key={size}>
                <div className="p-size">{size} bags</div>
                <div className="p-value">{eur(price)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function lotFacts(p) {
  const s = Math.round((p.score - 80) * 10);
  return [
    ['Lot number', p.lot_number],
    ['Registry reference', p.registry_refs.join(', ') || 'Not linked'],
    ['Warehouse', 'Gothenburg, Sweden'],
    ['Packaging', '30 kg hermetic bags'],
    ['Moisture', `${(10 + (s % 9) / 10).toFixed(1)} %`],
    ['Density', `${740 + (s % 7) * 8} g/l`],
  ];
}

function activity(p) {
  const items = [[p.created_at, 'plus', p.registry_refs.length ? `Added from the Open Lot Registry (${p.registry_refs[0]})` : 'Added to the catalogue']];
  if (p.status === 'published') items.unshift([p.created_at, 'store', 'Published to the buyer shop']);
  if (p.status === 'archived') items.unshift([p.created_at, 'archive', 'Archived']);
  if (p.enrichment.status === 'done') items.unshift([p.created_at, 'sparkles', 'Enriched: tasting notes, producer, awards']);
  return items;
}

export function ProductPage({ params }) {
  const { data: p, error, setData } = useApi(`/api/products/${encodeURIComponent(params.slug)}`);
  const [sawRunning, setSawRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const running = p?.enrichment?.status === 'running';

  useEffect(() => {
    if (!running) return undefined;
    setSawRunning(true);
    const t = setTimeout(async () => {
      try {
        setData(await api.get(`/api/products/${encodeURIComponent(params.slug)}`));
      } catch {
        /* keep the last state; the next render retries */
      }
    }, 350);
    return () => clearTimeout(t);
  }, [p, running, params.slug, setData]);

  if (error) {
    return (
      <div className="page">
        <EmptyState icon="search" title="This coffee does not exist">
          <Link className="link" to="/products">
            Back to coffees
          </Link>
        </EmptyState>
      </div>
    );
  }
  if (!p) {
    return (
      <div className="page">
        <Skeleton h={34} w={360} style={{ margin: '30px 0 26px' }} />
        <Skeleton h={460} r={14} />
      </div>
    );
  }

  const reveal = sawRunning && !running;
  const publish = async () => {
    setPublishing(true);
    try {
      setData(await api.post(`/api/products/${p.slug}/publish`));
      notify({ title: `${p.name} is live`, description: 'Cafés can now find it in the shop.' });
    } catch (e) {
      notify({ title: 'Could not publish', description: e.message });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        crumbs={[['Coffees', '/products'], [p.name]]}
        title={p.name}
        description={`${p.lot_number} · Added ${dayTime(p.created_at, today)}`}
        actions={
          <>
            <StatusBadge status={running ? 'enriching' : p.status} />
            <Link className="btn btn-secondary" to={`/availability/products/${p.slug}`}>
              <Icon name="globe" size={16} />
              Availability
            </Link>
            {p.status === 'draft' ? (
              <button type="button" className="btn btn-primary" onClick={publish} disabled={publishing}>
                <Icon name="store" size={16} />
                Publish
              </button>
            ) : null}
          </>
        }
      />
      {running ? <EnrichBanner enrichment={p.enrichment} /> : null}
      <div className="product-grid">
        <Hero p={p} loading={running} reveal={reveal} />

        <Section className="span-7" loading={running} reveal={reveal} index={1} skeletonHeight={150}>
          <div className="section-head">
            <h2 className="section-title">Tasting notes</h2>
            <span className="muted">Registry cupping · 3 cuppers</span>
          </div>
          <div className="notes">
            {(p.notes ?? []).map((n) => (
              <span className="note-chip" key={n}>
                <i style={{ background: noteColor(n) }} />
                {n}
              </span>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 18, maxWidth: 620 }}>
            A {p.process?.toLowerCase()} {p.variety} from {p.region}. Best enjoyed as a filter coffee; also shines as a single-origin espresso.
          </p>
        </Section>

        <Section className="span-5" loading={running} reveal={reveal} index={2} skeletonHeight={150}>
          <div className="section-head">
            <h2 className="section-title">Cup profile</h2>
            <span className="muted">out of 5</span>
          </div>
          <div className="profile-bars">
            {Object.entries(p.profile ?? {}).map(([k, v]) => (
              <div className="profile-bar" key={k}>
                <span style={{ textTransform: 'capitalize' }}>{k}</span>
                <div className="track">
                  <span style={{ width: `${(v / 5) * 100}%` }} />
                </div>
                <b className="tabular">{v.toFixed(1)}</b>
              </div>
            ))}
          </div>
        </Section>

        <Section className="span-12" loading={running} reveal={reveal} index={3} skeletonHeight={240}>
          <div className="farm">
            <div>
              <div className="section-head">
                <h2 className="section-title">Producer & farm</h2>
              </div>
              <div className="row gap-12" style={{ marginBottom: 14 }}>
                <span className="avatar avatar-lg tone-cream">
                  <Icon name="leaf" size={18} />
                </span>
                <div>
                  <div style={{ fontWeight: 650, fontSize: 16 }}>{p.producer}</div>
                  <div className="muted">
                    {p.farm} · {p.region}, {p.origin}
                  </div>
                </div>
              </div>
              <p style={{ color: 'var(--text-2)', fontSize: 15, lineHeight: 1.65, maxWidth: 680 }}>{p.story}</p>
              <div className="facts" style={{ marginTop: 20, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', borderBottom: 0 }}>
                {[
                  ['Farm size', p.farm_facts?.size],
                  ['Harvest season', p.farm_facts?.harvest],
                  ['Drying', p.farm_facts?.drying],
                  ['Shade', p.farm_facts?.shade],
                ].map(([k, v]) => (
                  <div className="fact" key={k}>
                    <div className="fact-label">{k}</div>
                    <div className="fact-value">{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <div className="farm-map" aria-label={`Map of ${p.region}`}>
              <div className="map-pin">
                <span>{p.farm}</span>
                <Icon name="pin" size={26} strokeWidth={2} />
              </div>
              <div className="map-label">
                {p.region} · {p.altitude}
              </div>
            </div>
          </div>
        </Section>

        <Section className="span-6" loading={running} reveal={reveal} index={4} skeletonHeight={170}>
          <div className="section-head">
            <h2 className="section-title">Lot & logistics</h2>
          </div>
          <div className="facts" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', borderBottom: 0, borderTop: 0, padding: 0 }}>
            {lotFacts(p).map(([k, v]) => (
              <div className="fact" key={k}>
                <div className="fact-label">{k}</div>
                <div className="fact-value">{v}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section className="span-6" loading={running} reveal={reveal} index={5} skeletonHeight={170}>
          <div className="section-head">
            <h2 className="section-title">Markets</h2>
            <Link className="link" to={`/availability/products/${p.slug}`}>
              Manage <Icon name="arrowRight" size={15} />
            </Link>
          </div>
          {p.availability.length ? (
            <>
              <div className="row gap-8" style={{ flexWrap: 'wrap', marginBottom: 12 }}>
                {p.availability.map((r) => (
                  <span key={r.id} className="chip">
                    <Flag code={COUNTRY_CODES[r.region]} /> {r.region}
                  </span>
                ))}
              </div>
              <div className="muted">
                {p.availability.filter((r) => r.status === 'active').length} active of {p.availability.length} markets
              </div>
            </>
          ) : (
            <div className="registry-hint" style={{ padding: 18 }}>
              Not listed in any market yet — set up availability to start selling.
            </div>
          )}
        </Section>

        <Section className="span-12" loading={running} reveal={reveal} index={6} skeletonHeight={130} id="awards">
          <div className="section-head">
            <h2 className="section-title">Awards</h2>
            <span className="muted">{(p.awards ?? []).length} distinctions</span>
          </div>
          <div className="awards">
            {(p.awards ?? []).map((a) => (
              <div className="award" key={a.title}>
                <div className={`medal ${a.kind}`}>
                  <Icon name="award" size={22} strokeWidth={2} />
                </div>
                <div>
                  <div className="award-title">{a.title}</div>
                  <div className="award-detail">{a.detail}</div>
                  <div className="award-score">{a.score}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section className="span-12" loading={running} reveal={reveal} index={7} skeletonHeight={110}>
          <div className="section-head">
            <h2 className="section-title">Activity</h2>
          </div>
          <div className="timeline">
            {activity(p).map(([at, icon, text]) => (
              <div className="timeline-item" key={text}>
                <span className="timeline-dot">
                  <Icon name={icon} size={14} />
                </span>
                <span>{text}</span>
                <span className="muted tabular">{dayTime(at, today)}</span>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
