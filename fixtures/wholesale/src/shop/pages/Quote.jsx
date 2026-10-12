import { useState } from 'react';
import { api, useApi } from '../../shared/api.js';
import { CoffeeArt } from '../../shared/art.jsx';
import { date, dayTime, eur, num, range } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { Link } from '../../shared/router.jsx';
import { today } from '../../shared/session.js';
import { notify } from '../../shared/toast.jsx';
import { Breadcrumbs, EmptyState, Skeleton, StatusBadge } from '../../shared/ui.jsx';

function Steps({ q }) {
  const decided = q.status === 'accepted' || q.status === 'declined';
  const steps = [
    { title: 'Request sent', sub: dayTime(q.created_at, today), done: true },
    {
      title: q.proposal ? `Proposal received from ${q.proposal.from}` : `Waiting for ${q.supplier}`,
      sub: q.proposal ? dayTime(q.proposal.created_at, today) : 'Usually within a few hours',
      done: Boolean(q.proposal),
      current: !q.proposal,
    },
    {
      title: q.status === 'declined' ? 'Proposal declined' : q.status === 'accepted' ? 'Proposal accepted — order confirmed' : 'Accept the proposal',
      sub: decided ? 'Roasting is scheduled for your delivery window' : 'Confirm to schedule roasting',
      done: decided,
      current: q.status === 'proposal',
    },
  ];
  return (
    <div className="steps">
      {steps.map((s) => (
        <div className="step" key={s.title} data-done={s.done || undefined} data-current={s.current || undefined}>
          <span className="step-dot">{s.done ? <Icon name="check" size={16} strokeWidth={2.4} /> : <Icon name="clock" size={16} />}</span>
          <div>
            <div className="s-title">{s.title}</div>
            <div className="s-sub">{s.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Proposal({ q, onDecision }) {
  const p = q.proposal;
  const [busy, setBusy] = useState(false);
  const decide = async (action) => {
    setBusy(true);
    try {
      await onDecision(action);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="proposal-card" aria-label="Proposal">
      <div className="proposal-head">
        <span className="avatar tone-burgundy">NR</span>
        <div className="grow">
          <div style={{ fontWeight: 650 }}>Proposal from {p.from}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Sent {dayTime(p.created_at, today)} · valid until {date(p.valid_until)}
          </div>
        </div>
        <StatusBadge status={q.status} />
      </div>
      <div className="proposal-lines">
        <div className="proposal-line">
          <div>
            <div style={{ fontWeight: 600 }}>{q.product?.name}</div>
            <div className="sub">
              {num(p.quantity_kg)} kg × {eur(p.unit_price_eur)} / kg · {q.grind.toLowerCase()} · {q.label_language} labels
            </div>
          </div>
          <span>{eur(p.goods_eur)}</span>
        </div>
        <div className="proposal-line">
          <div>
            <div style={{ fontWeight: 600 }}>Delivery</div>
            <div className="sub">{range(q.window_start, q.window_end)}</div>
          </div>
          <span>{eur(p.shipping_eur)}</span>
        </div>
        <div className="proposal-line muted-line" style={{ paddingTop: 12 }}>
          <span>Subtotal</span>
          <span>{eur(p.net_eur)}</span>
        </div>
        <div className="proposal-line muted-line">
          <span>VAT {Math.round(p.vat_rate * 100)}%</span>
          <span>{eur(p.vat_eur)}</span>
        </div>
      </div>
      <div className="proposal-total">
        <span style={{ fontWeight: 600 }}>Total</span>
        <span className="amount" data-testid="proposal-total">
          {eur(p.total_eur)}
          <span className="incl">incl. VAT</span>
        </span>
      </div>
      {p.note ? (
        <p className="muted" style={{ padding: '6px 24px 0' }}>
          “{p.note}”
        </p>
      ) : null}
      {q.status === 'proposal' ? (
        <div className="proposal-actions">
          <button type="button" className="btn btn-primary btn-lg" style={{ flex: 1 }} disabled={busy} onClick={() => decide('accept')}>
            <Icon name="check" size={18} strokeWidth={2.2} />
            Accept proposal
          </button>
          <button type="button" className="btn btn-secondary btn-lg" disabled={busy} onClick={() => decide('decline')}>
            Decline
          </button>
        </div>
      ) : (
        <div style={{ height: 18 }} />
      )}
      <a className="pdf-link" href={`/quotes/${q.id}/quote.pdf`} target="_blank" rel="noopener noreferrer">
        <span className="pdf-icon">PDF</span>
        <span className="grow">
          <span className="pdf-name">Download quote PDF</span>
          <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>
            Northfield_Quote_{q.reference}.pdf · 1 page
          </span>
        </span>
        <Icon name="external" size={16} style={{ color: 'var(--muted)' }} />
      </a>
    </section>
  );
}

export function QuotePage({ params }) {
  const { data: q, error, setData } = useApi(`/api/quotes/${encodeURIComponent(params.id)}`);
  if (error) {
    return (
      <EmptyState icon="receipt" title="Quote not found">
        <Link className="link" to="/quotes">
          Back to your quotes
        </Link>
      </EmptyState>
    );
  }
  if (!q) return <Skeleton h={480} r={18} />;

  const decide = async (action) => {
    const next = await api.post(`/api/quotes/${q.id}/${action}`);
    setData(next);
    notify(
      action === 'accept'
        ? { title: 'Proposal accepted', description: `${q.supplier} will roast your ${q.product?.name} for ${range(q.window_start, q.window_end)}.` }
        : { title: 'Proposal declined', description: `${q.supplier} has been told.` },
    );
  };

  return (
    <>
      <Breadcrumbs items={[['Quotes', '/quotes'], [q.reference]]} />
      <div className="row gap-16" style={{ margin: '4px 0 28px', alignItems: 'center' }}>
        <h1 className="quote-title">{q.product?.name}</h1>
        <StatusBadge status={q.status} />
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {q.reference} · requested {dayTime(q.created_at, today)}
        </span>
      </div>
      <div className="quote-layout">
        <div className="stack gap-16">
          <section className="card card-pad">
            <div className="row gap-16" style={{ marginBottom: 20 }}>
              <CoffeeArt palette={q.product?.palette} seed={q.product_slug} beansCount={0} variant="crop" style={{ width: 72, height: 72, borderRadius: 14 }} />
              <div>
                <div className="eyebrow">Your request</div>
                <div style={{ fontWeight: 650, fontSize: 17 }}>
                  {q.bags} × {q.bag_size} of {q.product?.name}
                </div>
                <div className="muted">
                  {q.product?.origin} · {q.product?.variety} · {q.product?.process}
                </div>
              </div>
            </div>
            <div className="detail-grid">
              {[
                ['Quantity', `${num(q.quantity_kg, q.quantity_kg % 1 ? 2 : 0)} kg`],
                ['Bag size', q.bag_size],
                ['Grind', q.grind],
                ['Label language', q.label_language],
                ['Delivery window', range(q.window_start, q.window_end)],
                ['Roaster', q.supplier],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="k">{k}</div>
                  <div className="v">{v}</div>
                </div>
              ))}
            </div>
            {q.message ? (
              <div style={{ marginTop: 20, padding: '14px 16px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>
                  Your message
                </div>
                {q.message}
              </div>
            ) : null}
          </section>
          <section className="card card-pad">
            <div className="card-title" style={{ marginBottom: 8 }}>
              Progress
            </div>
            <Steps q={q} />
          </section>
        </div>
        {q.proposal ? (
          <Proposal q={q} onDecision={decide} />
        ) : (
          <section className="card waiting">
            <span className="w-icon">
              <Icon name="hourglass" size={22} />
            </span>
            <div style={{ fontWeight: 650, fontSize: 16 }}>Waiting for the roaster’s proposal</div>
            <div className="muted" style={{ maxWidth: 340 }}>
              {q.supplier} usually replies within a few hours. You’ll get a notification as soon as the proposal arrives.
            </div>
          </section>
        )}
      </div>
    </>
  );
}
