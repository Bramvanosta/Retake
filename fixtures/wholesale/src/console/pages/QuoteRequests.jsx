import { useEffect, useState } from 'react';
import { api, useApi, useLiveList } from '../../shared/api.js';
import { COUNTRY_CODES, CoffeeArt, Flag } from '../../shared/art.jsx';
import { Modal } from '../../shared/dialog.jsx';
import { dayTime, eur, range } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { session, today } from '../../shared/session.js';
import { notify } from '../../shared/toast.jsx';
import { EmptyState, ErrorNote, PageHeader, Segmented, Skeleton, StatusBadge } from '../../shared/ui.jsx';

function ProposalDialog({ quote, onClose, onSent }) {
  const [unit, setUnit] = useState('');
  const [shipping, setShipping] = useState('30');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!quote) return;
    setUnit(quote.suggested_unit_price ? quote.suggested_unit_price.toFixed(2) : '');
    setShipping('30');
    setNote('');
    setError(null);
  }, [quote]);

  const unitN = Number(unit);
  const shipN = Number(shipping);
  const valid = unitN > 0 && shipN >= 0;
  const goods = valid && quote ? unitN * quote.quantity_kg : 0;
  const net = goods + (valid ? shipN : 0);
  const total = net * (1 + session.vat_rate);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await api.post(`/api/quotes/${quote.id}/proposal`, { unit_price_eur: unitN, shipping_eur: shipN, note });
      onSent(quote);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={quote !== null}
      onOpenChange={(o) => !o && onClose()}
      title="Send a proposal"
      description={quote ? `${quote.reference} · ${quote.buyer_name} · ${quote.product?.name}` : undefined}
      footer={
        <>
          <span className="footer-note">
            Total incl. VAT <b style={{ color: 'var(--text)' }}>{eur(total)}</b>
          </span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid || sending} onClick={send}>
            {sending ? <span className="spinner" /> : <Icon name="receipt" size={16} />}
            Send proposal
          </button>
        </>
      }
    >
      {quote ? (
        <>
          <div className="edit-summary">
            <CoffeeArt palette={quote.product?.palette} seed={quote.product_slug} beansCount={0} variant="crop" />
            <div className="grow">
              <div style={{ fontWeight: 600 }}>
                {quote.bags} × {quote.bag_size} · {quote.quantity_kg} kg
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {quote.grind} · {quote.label_language} labels · delivery {range(quote.window_start, quote.window_end)}
              </div>
            </div>
          </div>
          <div className="row gap-16">
            <div className="field grow">
              <label className="field-label" htmlFor="proposal-unit">
                Price per kg (EUR)
              </label>
              <input id="proposal-unit" className="input" inputMode="decimal" value={unit} onChange={(e) => setUnit(e.target.value)} />
            </div>
            <div className="field grow">
              <label className="field-label" htmlFor="proposal-shipping">
                Delivery (EUR)
              </label>
              <input id="proposal-shipping" className="input" inputMode="decimal" value={shipping} onChange={(e) => setShipping(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="proposal-note">
              Note to the café
            </label>
            <textarea
              id="proposal-note"
              className="textarea"
              placeholder="Roast date, delivery details, volume discounts…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error ? <ErrorNote error={error} /> : null}
        </>
      ) : null}
    </Modal>
  );
}

export function QuoteRequestsPage() {
  // `view=list`: the request NORTHFIELD_QUOTES_MS slows down (the console's badge and notifications ask without it).
  const { data, error, reload } = useApi('/api/quotes?view=list');
  const products = useApi('/api/products?status=all');
  const [filter, setFilter] = useState('requested');
  const [proposing, setProposing] = useState(null);
  // Live (L2.11 fixture): a request a café sends while the page is open arrives within a second, highlighted.
  const fresh = useLiveList(reload, data);
  const quotes = data ?? [];
  const shown = filter === 'all' ? quotes : quotes.filter((q) => q.status === filter);
  const priceOf = (q) => (products.data ?? []).find((p) => p.slug === q.product_slug)?.prices[q.bag_size];

  return (
    <div className="page">
      <PageHeader title="Quote requests" description="Cafés ask for a price on a coffee, a quantity and a delivery window. Reply with a proposal." />
      <ErrorNote error={error} />
      <div className="toolbar">
        <Segmented
          label="Filter quotes"
          value={filter}
          onChange={setFilter}
          items={[
            ['requested', 'Awaiting proposal', quotes.filter((q) => q.status === 'requested').length],
            ['proposal', 'Proposal sent', quotes.filter((q) => q.status === 'proposal').length],
            ['all', 'All', quotes.length],
          ]}
        />
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Request</th>
              <th>Café</th>
              <th>Coffee</th>
              <th>Quantity</th>
              <th>Delivery window</th>
              <th>Received</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!data
              ? [0, 1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={9}>
                      <Skeleton h={26} />
                    </td>
                  </tr>
                ))
              : shown.map((q) => (
                  <tr key={q.id} className={fresh.has(q.id) ? 'row-new' : undefined}>
                    <td className="cell-title tabular">
                      {q.reference}
                      {fresh.has(q.id) ? <span className="new-pill">New</span> : null}
                    </td>
                    <td>
                      <div className="row gap-8">
                        <Flag code={COUNTRY_CODES[q.buyer_country]} />
                        {q.buyer_name}
                      </div>
                    </td>
                    <td>{q.product?.name}</td>
                    <td className="tabular">
                      {q.bags} × {q.bag_size}
                    </td>
                    <td className="tabular">{range(q.window_start, q.window_end)}</td>
                    <td className="tabular">{dayTime(q.created_at, today)}</td>
                    <td>
                      <StatusBadge status={q.status === 'proposal' ? 'proposal' : q.status} label={q.status === 'proposal' ? 'Proposal sent' : undefined} />
                    </td>
                    <td className="num">{q.proposal ? eur(q.proposal.total_eur) : '—'}</td>
                    <td className="actions" style={{ width: 150 }}>
                      {q.status === 'requested' ? (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setProposing({ ...q, suggested_unit_price: priceOf(q) })}>
                          Send proposal
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
        {data && shown.length === 0 ? <EmptyState icon="inbox" title="Nothing waiting for you" /> : null}
      </div>
      <ProposalDialog
        quote={proposing}
        onClose={() => setProposing(null)}
        onSent={(q) => {
          setProposing(null);
          reload();
          notify({ title: 'Proposal sent', description: `${q.buyer_name} has been notified about ${q.reference}.` });
        }}
      />
    </div>
  );
}
