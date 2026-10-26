// Pro forma invoices (Demo Studio L5.6, capture reliability): a page made of the traps a real take met.
// - The filters above the table have a "Quantity (kg)" field, and so has the dialog: behind an open modal dialog the
//   page's field is still "visible" but cannot be used (the dialog covers it).
// - The dialog's body scrolls on its own (the dialog keeps its header and footer): "Quantity (kg)" is below its fold.
// - "Delivery date" opens a calendar under the field; the calendar keeps the focus in the field (its days do not take
//   it) and covers the fields below it until a click outside closes it.
// - "Preview" does nothing at all (a feature not wired yet).
// - "Download PDF" opens the PDF in a new tab; with ?flaky=1 the server drops the second transfer of each pro forma.
// - "Send to customer" mails the customer's accounts address and a copy to the supplier, both with the same subject.

import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../../shared/api.js';
import { Modal } from '../../shared/dialog.jsx';
import { eur } from '../../shared/format.js';
import { Icon } from '../../shared/icons.jsx';
import { notify } from '../../shared/toast.jsx';
import { ErrorNote, PageHeader, StatusBadge } from '../../shared/ui.jsx';

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A text field with a calendar under it (opens on focus, closes on a day or a press outside). */
function DateField({ id, label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (box.current && !box.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const year = 2026;
  const month = 10; // November
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  return (
    <div className="field pf-date" ref={box}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        placeholder="dd/mm/yyyy"
        autoComplete="off"
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {open ? (
        <div className="pf-calendar floating" role="dialog" aria-label="Choose a delivery date" data-side="bottom">
          <div className="pf-calendar-title">
            {MONTH[month]} {year}
          </div>
          <div className="pf-calendar-grid">
            {days.map((d) => (
              <button
                key={d}
                type="button"
                className="pf-day"
                aria-label={`${d} ${MONTH[month]} ${year}`}
                // A day never takes the focus: it stays in the field, as many date pickers do.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(`${String(d).padStart(2, '0')}/${String(month + 1).padStart(2, '0')}/${year}`);
                  setOpen(false);
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewProFormaDialog({ open, onClose, onSent }) {
  const [delivery, setDelivery] = useState('');
  const [customer, setCustomer] = useState('Demo Café');
  const [incoterm, setIncoterm] = useState('DAP Stockholm');
  const [payment, setPayment] = useState('30 days net');
  const [notes, setNotes] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDelivery('');
    setNotes('');
    setQuantity('');
    setUnit('');
    setError(null);
    setDraft(null);
    // The reference of the pro forma being written: its PDF can be downloaded before it is sent.
    api.post('/api/proforma/draft').then(setDraft, setError);
  }, [open]);

  const qty = Number(quantity);
  const price = Number(unit.replace(',', '.'));
  const total = qty > 0 && price > 0 ? qty * price : 0;

  async function send() {
    setSending(true);
    setError(null);
    try {
      const pf = await api.post('/api/proforma', { reference: draft?.reference, customer, delivery, incoterm, payment, notes, quantity_kg: qty, unit_price_eur: price });
      onSent(pf);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      className="pf-dialog"
      title="New pro forma"
      description={draft ? `${draft.reference} · ${customer}` : 'A pro forma invoice for a wholesale order'}
      footer={
        <>
          <span className="footer-note">
            Total excl. VAT <b style={{ color: 'var(--text)' }}>{eur(total)}</b>
          </span>
          {/* Not wired yet: clicking it does nothing. */}
          <button type="button" className="btn btn-secondary">
            <Icon name="eye" size={16} />
            Preview
          </button>
          <a className="btn btn-secondary" href={draft ? `/proforma/${draft.reference}.pdf?flaky=1` : undefined} target="_blank" rel="noreferrer">
            <Icon name="download" size={16} />
            Download PDF
          </a>
          <button type="button" className="btn btn-primary" disabled={sending || !(qty > 0 && price > 0)} onClick={send}>
            {sending ? <span className="spinner" /> : <Icon name="inbox" size={16} />}
            Send to customer
          </button>
        </>
      }
    >
      <div className="pf-scroll">
        <DateField id="pf-delivery" label="Delivery date" value={delivery} onChange={setDelivery} />
        <div className="row gap-16">
          <div className="field grow">
            <label className="field-label" htmlFor="pf-customer">
              Customer
            </label>
            <input id="pf-customer" className="input" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <div className="field grow">
            <label className="field-label" htmlFor="pf-incoterm">
              Incoterm
            </label>
            <input id="pf-incoterm" className="input" value={incoterm} onChange={(e) => setIncoterm(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pf-payment">
            Payment terms
          </label>
          <input id="pf-payment" className="input" value={payment} onChange={(e) => setPayment(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pf-notes">
            Notes for the customer
          </label>
          <textarea id="pf-notes" className="textarea" rows={5} placeholder="Roast date, packing, delivery slot…" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="row gap-16">
          <div className="field grow">
            <label className="field-label" htmlFor="pf-quantity">
              Quantity (kg)
            </label>
            <input id="pf-quantity" className="input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div className="field grow">
            <label className="field-label" htmlFor="pf-unit">
              Unit price (EUR/kg)
            </label>
            <input id="pf-unit" className="input" inputMode="decimal" value={unit} onChange={(e) => setUnit(e.target.value)} />
          </div>
        </div>
        {error ? <ErrorNote error={error} /> : null}
      </div>
    </Modal>
  );
}

export function ProFormaPage() {
  const { data, error, reload } = useApi('/api/proforma');
  const [creating, setCreating] = useState(false);
  const [minQty, setMinQty] = useState('');
  const [customer, setCustomer] = useState('');
  const rows = (data ?? []).filter((p) => (!minQty || p.quantity_kg >= Number(minQty)) && (!customer || p.customer.toLowerCase().includes(customer.toLowerCase())));
  return (
    <div className="page">
      <PageHeader
        title="Pro forma invoices"
        description="Send a café a pro forma before a large order: quantity, price, delivery and payment terms."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={17} strokeWidth={2.2} />
            New pro forma
          </button>
        }
      />
      <ErrorNote error={error} />
      <div className="toolbar pf-filters">
        <div className="field">
          <label className="field-label" htmlFor="pf-filter-qty">
            Quantity (kg)
          </label>
          <input id="pf-filter-qty" className="input" inputMode="numeric" placeholder="At least…" value={minQty} onChange={(e) => setMinQty(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="pf-filter-customer">
            Customer
          </label>
          <input id="pf-filter-customer" className="input" placeholder="Any customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
      </div>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>Customer</th>
              <th>Delivery</th>
              <th className="num">Quantity (kg)</th>
              <th className="num">Total</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.reference}>
                <td style={{ fontWeight: 600 }}>{p.reference}</td>
                <td>{p.customer}</td>
                <td>{p.delivery || '—'}</td>
                <td className="num">{p.quantity_kg}</td>
                <td className="num">{eur(p.total_eur)}</td>
                <td>
                  <StatusBadge status={p.status === 'sent' ? 'published' : 'draft'} label={p.status === 'sent' ? 'Sent' : 'Draft'} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <NewProFormaDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSent={(pf) => {
          setCreating(false);
          reload();
          notify({ title: 'Pro forma sent', description: `${pf.reference} to ${pf.customer}` });
        }}
      />
    </div>
  );
}
